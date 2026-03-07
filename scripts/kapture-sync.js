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
 * Required env vars: METABASE_API_KEY, SLACK_BOT_TOKEN
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

  // ── Idempotency check: skip if already ran successfully today ─────────────
  const today = todayStr();
  const lastRun = await fbGet('/run_flags/kapture_sync');
  if (lastRun === today) {
    log(`Already ran today (${today}) — skipping.`);
    return;
  }

  log('Starting Kapture → High Pain Tracker sync via Metabase…');

  // ── Step 1: Query SERVICE_TICKET_MODEL via Metabase ──────────────────────
  // Table: PUBLIC.SERVICE_TICKET_MODEL (Metabase table ID 5599, DB 113)
  const sql = `
    SELECT
      stm.KAPTURE_TICKET_ID,
      stm.CUSTOMER_MOBILE,
      c.NAME                                             AS CUSTOMER_NAME,
      stm.CURRENT_PARTNER_NAME                          AS PARTNER,
      stm.FIRST_TITLE                                   AS SUB_CATEGORY,
      FLOOR(stm.TOTALTAT_TILLNOW_MINS_CALENDARHRS / 60) AS TAT_HOURS,
      stm.CURRENT_TICKET_STATUS,
      TO_CHAR(stm.TICKET_ADDED_TIME, 'DD/Mon/YYYY')    AS CREATED_DATE
    FROM SERVICE_TICKET_MODEL stm
    LEFT JOIN COMBINED_T_WG_CUSTOMER c
      ON c.MOBILE = stm.CUSTOMER_MOBILE
    WHERE
      -- Internet-related sub-category
      (
        stm.FIRST_TITLE ILIKE '%internet supply down%'
        OR stm.FIRST_TITLE ILIKE '%slow speed%'
        OR stm.FIRST_TITLE ILIKE '%frequent disconnection%'
        OR stm.FIRST_TITLE ILIKE '%recharge done but no internet%'
        OR stm.FIRST_TITLE ILIKE '%internet not working%'
        OR stm.FIRST_TITLE ILIKE '%no internet%'
        OR stm.FIRST_TITLE ILIKE '%internet issue%'
        OR stm.FIRST_TITLE ILIKE '%internet%'
      )
      -- Not resolved
      AND stm.IS_RESOLVED = 0
      -- Not reopened (excluded per requirement)
      AND stm.TIMES_REOPENED = 0
      -- Only cases that CROSSED 72 hours TODAY
      AND stm.TICKET_ADDED_TIME >= DATEADD(HOUR, -96, CURRENT_TIMESTAMP())
      AND stm.TICKET_ADDED_TIME <  DATEADD(HOUR, -72, CURRENT_TIMESTAMP())
      -- Must have a valid Kapture ticket ID
      AND stm.KAPTURE_TICKET_ID IS NOT NULL
      AND stm.KAPTURE_TICKET_ID != ''
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

  // ── Step 2: Add to Firebase (skip duplicates, update stale dates) ──────────
  let added = 0, skipped = 0, updated = 0;

  for (const t of tickets) {
    const ticketId = String(t.KAPTURE_TICKET_ID || '').trim();
    if (!ticketId) continue;

    const key      = ticketKey(ticketId);
    const existing = await fbGet('/cases/' + key);

    if (existing !== null) {
      // Case already exists — no duplicate added.
      // If it was added on a previous date, refresh case_added_on to today.
      if (existing.case_added_on !== today) {
        try {
          await fbPut('/cases/' + key + '/case_added_on', today);
          log(`  Date updated ticket=${ticketId} ${existing.case_added_on} → ${today}`);
          updated++;
        } catch (e) {
          log(`  ERROR updating date ticket=${ticketId}: ${e.message}`);
        }
      } else {
        log(`  Already exists (today) — skip ticket=${ticketId}`);
        skipped++;
      }
      continue;
    }

    const tatHours = t.TAT_HOURS || 72;
    const tatLabel = tatHours >= 120 ? '>120 hrs' : tatHours >= 72 ? '>72 hrs' : tatHours + ' hrs';

    const payload = {
      case_added_on:  todayStr(),
      ticket_no:      ticketId,
      created_date:   String(t.CREATED_DATE || '').trim(),
      mobile:         String(t.CUSTOMER_MOBILE || '').trim(),
      subcat:         String(t.SUB_CATEGORY    || '').trim(),
      cust_name:      String(t.CUSTOMER_NAME || '').trim(),
      partner:        String(t.PARTNER         || '').trim(),
      tat:            tatLabel,
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
      log(`  Added ticket=${ticketId} subcat="${t.SUB_CATEGORY}" tat="${tatLabel}"`);
      added++;
    } catch (e) {
      log(`  ERROR adding ticket=${ticketId}: ${e.message}`);
    }
  }

  log(`Sync complete. Added: ${added}  Date-updated: ${updated}  Skipped (already today): ${skipped}`);

  // Mark today as done so duplicate cron runs are skipped
  await fbPut('/run_flags/kapture_sync', today);

  // ── Step 3: Notify Slack (only on scheduled runs, not manual triggers) ──────
  const slackToken  = process.env.SLACK_BOT_TOKEN;
  const notifySlack = process.env.NOTIFY_SLACK === 'true';
  if (slackToken && notifySlack) {
    log('Sending Slack notification…');
    try {
      await httpRequest(
        'POST',
        'https://slack.com/api/chat.postMessage',
        {
          channel:  'C0AHDR8H4CC',
          username: "Shariq's Slack Agent",
          icon_url: 'https://raw.githubusercontent.com/shariqkhan-ui/hp-customer-tracker/master/shariq-agent.jpg',
          text:     `<!channel> New cases have been added in the tracker \u2014 check it here: https://shariqkhan-ui.github.io/hp-customer-tracker/`
        },
        { 'Authorization': 'Bearer ' + slackToken }
      );
      log('Slack notification sent.');
    } catch (e) {
      log('ERROR sending Slack notification: ' + e.message);
    }
  }
})();
