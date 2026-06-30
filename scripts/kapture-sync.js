/**
 * Kapture → High Pain Tracker Auto-Sync (via Metabase)
 *
 * What it does:
 *   1. Queries V_SERVICE_TICKET_MODEL_FINAL in Snowflake via Metabase API
 *   2. Filters for: internet-related sub-category, open (not resolved), aged 72+ hours (no upper bound), valid Kapture ticket ID
 *   3. Checks Firebase — skips tickets already in the tracker
 *   4. Adds new qualifying cases to Firebase with today's date as "Case Added On"
 *
 * No browser automation needed — uses Metabase SQL API directly.
 * Runs every hour from 10 AM IST via GitHub Actions cron.
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

// ── Firebase auth (service account → access token) ───────────────────────────

let _fbToken = null;

async function getFirebaseToken() {
  if (_fbToken) return _fbToken;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const crypto = require('crypto');

  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const res = await new Promise((resolve, reject) => {
    const url = new URL('https://oauth2.googleapis.com/token');
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (!res.access_token) throw new Error('Failed to get Firebase token: ' + JSON.stringify(res));
  _fbToken = res.access_token;
  return _fbToken;
}

async function fbGet(path) {
  return httpRequest('GET', FIREBASE_DB + path + '.json', null, {});
}

async function fbPut(path, value) {
  const token = await getFirebaseToken();
  return httpRequest('PUT', FIREBASE_DB + path + '.json?access_token=' + token, value, {});
}

// Partial update — only the keys in `value` are written; all other fields
// (engineer/remarks/etc.) are left exactly as they are.
async function fbPatch(path, value) {
  const token = await getFirebaseToken();
  return httpRequest('PATCH', FIREBASE_DB + path + '.json?access_token=' + token, value, {});
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

// ── Add a batch of tickets to Firebase (skip any already tracked) ────────────
async function addTicketsToFirebase(tickets, sourceLabel) {
  // Dedup within this batch — the mobile join can yield duplicate rows per ticket.
  const uniq = [...new Map(
    tickets.map(t => [String(t.KAPTURE_TICKET_ID || '').trim(), t])
  ).values()];

  let added = 0, skipped = 0, enriched = 0;
  for (const t of uniq) {
    const ticketId = String(t.KAPTURE_TICKET_ID || '').trim();
    if (!ticketId) continue;

    const newPartner = String(t.PARTNER       || '').trim();
    const newName    = String(t.CUSTOMER_NAME || '').trim();

    const key      = ticketKey(ticketId);
    const existing = await fbGet('/cases/' + key);
    if (existing !== null) {
      // Already tracked. Don't re-add or disturb engineer/remarks — but DO backfill
      // CSP/customer details that were missing, by patching only those blank fields.
      const patch = {};
      if (newPartner && !String(existing.partner   || '').trim()) patch.partner   = newPartner;
      if (newName    && !String(existing.cust_name || '').trim()) patch.cust_name = newName;
      if (Object.keys(patch).length) {
        try {
          await fbPatch('/cases/' + key, patch);
          log(`  Enriched ticket=${ticketId} ${Object.keys(patch).join('+')}`);
          enriched++;
        } catch (e) {
          log(`  ERROR enriching ticket=${ticketId}: ${e.message}`);
        }
      }
      skipped++;
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
      cust_name:      String(t.CUSTOMER_NAME   || '').trim(),
      partner:        String(t.PARTNER         || '').trim(),
      tat:            tatLabel,
      remarks:        '',
      easy_remarks:   '',
      engineer:       '',
      ticket_url:     kaptureUrl(ticketId),
      col12:          '',
      col13:          '',
      migration_date: '',
      channel:        String(t.CHANNEL || 'Service').trim(),
      source:         sourceLabel,
      added_at:       Date.now(),
    };

    try {
      await fbPut('/cases/' + key, payload);
      log(`  Added ticket=${ticketId} channel="${payload.channel}" subcat="${t.SUB_CATEGORY}" tat="${tatLabel}"`);
      added++;
    } catch (e) {
      log(`  ERROR adding ticket=${ticketId}: ${e.message}`);
    }
  }
  return { added, skipped, enriched };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey) {
    console.error('ERROR: METABASE_API_KEY env var is required.');
    process.exit(1);
  }

  // One-time backfill of the full open chat backlog (no 14-day cap, Slack-silent).
  const BACKFILL_CHAT = process.env.BACKFILL_CHAT === 'true';

  log(`Starting Kapture → High Pain Tracker sync via Metabase…${BACKFILL_CHAT ? '  [CHAT BACKFILL MODE — no age cap, Slack silent]' : ''}`);
  const today = todayStr();

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
      -- Aged 72 hrs up to 14 days and STILL OPEN. Wider than the old 72-96h
      -- slice (so it catches open cases that slipped through that single day),
      -- but capped at 14 days to exclude the large pool of ancient, stale-open
      -- tickets that aren't live high-pain cases.
      -- Safe against duplicates: Firebase dedup by ticket ID skips cases already
      -- in the tracker, so older open cases get added once and never re-added.
      AND stm.TICKET_ADDED_TIME <  DATEADD(HOUR, -72, CURRENT_TIMESTAMP())
      AND stm.TICKET_ADDED_TIME >= DATEADD(DAY, -14, CURRENT_TIMESTAMP())
      -- Must have a valid Kapture ticket ID
      AND stm.KAPTURE_TICKET_ID IS NOT NULL
      AND stm.KAPTURE_TICKET_ID != ''
  `;

  // ── Step 1: Internet sync (SERVICE_TICKET_MODEL) ─────────────────────────
  // Skipped during a chat-only backfill so the backfill stays focused & silent.
  let internetAdded = 0, internetSkipped = 0, internetEnriched = 0;
  if (!BACKFILL_CHAT) {
    log('Running internet-ticket query (SERVICE_TICKET_MODEL)…');
    let tickets;
    try {
      tickets = await queryMetabase(sql, apiKey);
    } catch (e) {
      console.error('ERROR querying Metabase (internet):', e.message);
      process.exit(1);
    }
    log(`Qualifying internet tickets: ${tickets.length}`);
    ({ added: internetAdded, skipped: internetSkipped, enriched: internetEnriched } =
      await addTicketsToFirebase(tickets, 'cron'));
  }

  // ── Step 2: Chat sync (T_TICKETS_NEW where ticket_source = CUSTOMER_CHAT) ──
  // Open chat tickets aged >72h. Normal runs cap at 14 days to stay live; the
  // one-time BACKFILL_CHAT run drops the cap to clear the full aged backlog.
  const chatAgeCap = BACKFILL_CHAT
    ? ''
    : 'AND t.CREATED_TIME >= DATEADD(DAY, -14, CURRENT_TIMESTAMP())';

  const chatSql = `
    SELECT
      t.KAPTURE_TICKET_ID,
      t.MOBILE                                          AS CUSTOMER_MOBILE,
      c.NAME                                            AS CUSTOMER_NAME,
      ce.CURRENT_PARTNER_NAME                           AS PARTNER,
      t.TITLE                                           AS SUB_CATEGORY,
      FLOOR(DATEDIFF(MINUTE, t.CREATED_TIME, CURRENT_TIMESTAMP()) / 60) AS TAT_HOURS,
      t.STATUS                                          AS CURRENT_TICKET_STATUS,
      TO_CHAR(t.CREATED_TIME, 'DD/Mon/YYYY')            AS CREATED_DATE,
      'Chat'                                            AS CHANNEL
    FROM T_TICKETS_NEW t
    LEFT JOIN COMBINED_T_WG_CUSTOMER c
      ON c.MOBILE = t.MOBILE
    -- CSP/partner name: T_TICKETS_NEW has no partner column, so resolve it from
    -- the customer master (mobile → current partner). ~89% coverage.
    LEFT JOIN CUSTOMER_ENRICHED_DBT ce
      ON ce.MOBILE = t.MOBILE
    WHERE t.STATUS = 'OPEN'
      AND t.EXTRA_DATA:ticket_source::string = 'CUSTOMER_CHAT'
      AND t.CREATED_TIME < DATEADD(HOUR, -72, CURRENT_TIMESTAMP())
      ${chatAgeCap}
      AND t.KAPTURE_TICKET_ID IS NOT NULL
  `;

  log(`Running chat-ticket query (CUSTOMER_CHAT)${BACKFILL_CHAT ? ' [no age cap]' : ' [72h-14d]'}…`);
  let chatTickets = [];
  try {
    chatTickets = await queryMetabase(chatSql, apiKey);
  } catch (e) {
    // Don't fail the whole run on a chat-query error — internet sync already ran.
    console.error('ERROR querying Metabase (chat):', e.message);
  }
  log(`Qualifying chat tickets: ${chatTickets.length}`);
  const { added: chatAdded, skipped: chatSkipped, enriched: chatEnriched } =
    await addTicketsToFirebase(chatTickets, BACKFILL_CHAT ? 'chat-backfill' : 'chat-cron');

  const added    = internetAdded + chatAdded;
  const skipped  = internetSkipped + chatSkipped;
  const enriched = internetEnriched + chatEnriched;
  log(`Sync complete. Added: ${added} (internet ${internetAdded}, chat ${chatAdded})  Enriched: ${enriched}  Skipped: ${skipped}`);

  // ── Step 3: Notify Slack (suppressed entirely during a silent backfill) ──
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (BACKFILL_CHAT) {
    log('Backfill mode — Slack notification suppressed.');
  } else if (slackToken) {
    log('Sending Slack notification…');
    try {
      const parts = [];
      if (internetAdded > 0) parts.push(`${internetAdded} internet`);
      if (chatAdded > 0)     parts.push(`${chatAdded} chat`);
      const breakdown = parts.length ? ` (${parts.join(', ')})` : '';
      const slackRes = await httpRequest(
        'POST',
        'https://slack.com/api/chat.postMessage',
        {
          channel:  'C0AHDR8H4CC',
          username: "Shariq's Slack Agent",
          icon_url: 'https://raw.githubusercontent.com/shariqkhan-ui/hp-customer-tracker/master/shariq-agent.jpg',
          text:     added > 0
            ? `<!channel> *${added} new case(s) added*${breakdown} to the High Pain Tracker \u2014 check it here: https://shariqkhan-ui.github.io/hp-customer-tracker/`
            : `Hourly sync complete \u2014 no new cases this run (${skipped} already tracked). https://shariqkhan-ui.github.io/hp-customer-tracker/`
        },
        { 'Authorization': 'Bearer ' + slackToken }
      );
      if (slackRes.ok) {
        log('Slack notification sent successfully.');
      } else {
        log(`ERROR: Slack API returned ok=false — error: ${slackRes.error}, needed: ${slackRes.needed || 'N/A'}`);
      }
    } catch (e) {
      log('ERROR sending Slack notification: ' + e.message);
    }
  }
})();
