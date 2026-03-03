/**
 * Kapture → High Pain Tracker Auto-Sync (via Metabase)
 *
 * What it does:
 *   1. Queries V_SERVICE_TICKET_MODEL_FINAL in Snowflake via Metabase API
 *   2. Filters for: internet-related sub-category, pending 72+ hours, open/pending status, not reopened
 *   3. Checks Firebase — skips tickets already in the tracker
 *   4. Adds new qualifying cases to Firebase with today's date as "Case Added On"
 *
 * No browser automation needed — uses Metabase SQL API directly.
 * Runs daily at 10 AM IST via GitHub Actions cron.
 * Required env vars: METABASE_API_KEY
 */

const https = require('https');

// ── Constants ────────────────────────────────────────────────────────────────

const FIREBASE_DB    = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const METABASE_URL   = 'https://metabase.wiom.in';
const METABASE_DB_ID = 113;
const KAPTURE_BASE   = 'https://wiomin.kapturecrm.com';
const KAPTURE_ORG    = '957486452';

const MONTHS_SHORT   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function todayStr() {
  const d = new Date();
  return String(d.getDate()).padStart(2, '0') + '-' + MONTHS_SHORT[d.getMonth()] + '-' + d.getFullYear();
}

function ticketKey(t) {
  return String(t).replace(/[.#$[\]/ ]/g, '_');
}

function kaptureUrl(ticketId) {
  return `${KAPTURE_BASE}/nui/tickets/all/5/-1/0/detail/${KAPTURE_ORG}/${ticketId}?query=${ticketId}`;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpRequest(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  { 'Content-Type': 'application/json', ...headers },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function fbGet(path) {
  return httpRequest('GET', FIREBASE_DB + path + '.json', null, {});
}

async function fbPut(path, value) {
  return httpRequest('PUT', FIREBASE_DB + path + '.json', value, {});
}

// ── Metabase query ────────────────────────────────────────────────────────────

async function queryMetabase(sql, apiKey) {
  const result = await httpRequest(
    'POST',
    METABASE_URL + '/api/dataset',
    { database: METABASE_DB_ID, type: 'native', native: { query: sql } },
    { 'x-api-key': apiKey }
  );

  if (result.error) throw new Error('Metabase query error: ' + result.error);

  const cols = (result.data?.cols || []).map(c => c.name);
  const rows = result.data?.rows || [];

  // Convert rows to objects keyed by column name
  return rows.map(row => {
    const obj = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey) {
    console.error('ERROR: METABASE_API_KEY env var is required.');
    process.exit(1);
  }

  log('Starting Kapture → High Pain Tracker sync via Metabase…');

  // ── Step 1: Query SERVICE_TICKET_MODEL via Metabase ──────────────────────
  // Table: PUBLIC.SERVICE_TICKET_MODEL (Metabase table ID 5599, DB 113)
  const sql = `
    SELECT
      KAPTURE_TICKET_ID,
      CUSTOMER_MOBILE,
      CURRENT_PARTNER_NAME                               AS PARTNER,
      FIRST_TITLE                                        AS SUB_CATEGORY,
      ROUND(TOTALTAT_TILLNOW_MINS_CALENDARHRS / 60, 1)  AS TAT_HOURS,
      CURRENT_TICKET_STATUS,
      TICKET_ADDED_TIME
    FROM SERVICE_TICKET_MODEL
    WHERE
      -- Internet-related sub-category
      (
        FIRST_TITLE ILIKE '%internet supply down%'
        OR FIRST_TITLE ILIKE '%slow speed%'
        OR FIRST_TITLE ILIKE '%frequent disconnection%'
        OR FIRST_TITLE ILIKE '%recharge done but no internet%'
        OR FIRST_TITLE ILIKE '%internet not working%'
        OR FIRST_TITLE ILIKE '%no internet%'
        OR FIRST_TITLE ILIKE '%internet issue%'
        OR FIRST_TITLE ILIKE '%internet%'
      )
      -- Not resolved
      AND IS_RESOLVED = 0
      -- Not reopened
      AND TIMES_REOPENED = 0
      -- Pending more than 72 hours (4320 minutes)
      AND TOTALTAT_TILLNOW_MINS_CALENDARHRS >= 4320
      -- Must have a valid Kapture ticket ID
      AND KAPTURE_TICKET_ID IS NOT NULL
      AND KAPTURE_TICKET_ID != ''
  `;

  log('Running Metabase query…');
  let tickets;
  try {
    tickets = await queryMetabase(sql, apiKey);
  } catch (e) {
    console.error('ERROR querying Metabase:', e.message);
    process.exit(1);
  }

  log(`Qualifying tickets from Metabase: ${tickets.length}`);

  if (tickets.length === 0) {
    log('No qualifying cases found. Done.');
    return;
  }

  // ── Step 2: Add to Firebase (skip duplicates) ─────────────────────────────
  let added = 0, skipped = 0;

  for (const t of tickets) {
    const ticketId = String(t.KAPTURE_TICKET_ID || '').trim();
    if (!ticketId) continue;

    const key      = ticketKey(ticketId);
    const existing = await fbGet('/cases/' + key);

    if (existing !== null) {
      log(`  Already exists — skip ticket=${ticketId}`);
      skipped++;
      continue;
    }

    const payload = {
      case_added_on:  todayStr(),
      ticket_no:      ticketId,
      mobile:         String(t.CUSTOMER_MOBILE || '').trim(),
      subcat:         String(t.SUB_CATEGORY    || '').trim(),
      cust_name:      '',
      partner:        String(t.PARTNER         || '').trim(),
      tat:            t.TAT_HOURS ? t.TAT_HOURS + ' hrs' : '72+ hrs',
      remarks:        '',
      easy_remarks:   '',
      engineer:       '',
      ticket_url:     kaptureUrl(ticketId),
      col12:          '',
      col13:          '',
      migration_date: '',
    };

    try {
      await fbPut('/cases/' + key, payload);
      log(`  Added ticket=${ticketId} subcat="${t.SUB_CATEGORY}" tat="${t.TAT_HOURS} hrs"`);
      added++;
    } catch (e) {
      log(`  ERROR adding ticket=${ticketId}: ${e.message}`);
    }
  }

  log(`Sync complete. Added: ${added}  Skipped (already existed): ${skipped}`);
})();
