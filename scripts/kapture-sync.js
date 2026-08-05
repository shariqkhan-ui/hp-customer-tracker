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

// ── Finance refund sheet → /refund_sheet ─────────────────────────────────────
// The Finance team's "Form Responses 2" (published Google Sheet) is the source
// of truth for completed refunds. The CSV is ~7.6MB — far too heavy for the
// dashboard to fetch client-side — so each sync mirrors just the ticket-level
// refund-done entries into a small /refund_sheet node the Refund tab reads.
const REFUND_SHEET_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vREJtTEloJoNZdZe8EVsnmWrigVJJXT-ciwH7uNCUz34Q10Nj0h8KH3G74rHAh4d5zwerfk0uer7fZz/pub?gid=1692552304&single=true&output=csv';

function parseCSVText(s) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function syncRefundSheet() {
  log('Fetching Finance refund sheet…');
  const res = await fetch(REFUND_SHEET_CSV, { redirect: 'follow' });
  if (!res.ok) throw new Error('sheet HTTP ' + res.status);
  const rows = parseCSVText(await res.text());
  const H = rows[0].map(h => h.trim().toLowerCase());
  const iT = H.indexOf('kapture ticket id');
  const iS = H.indexOf('refund status');
  const iA = H.findIndex(h => h === 'refund amount');
  const iA2 = H.findIndex(h => h.startsWith('refund amount (plan'));
  const iR = H.indexOf('router recovered');
  if (iT < 0 || iS < 0) throw new Error('expected columns not found in sheet');
  const out = {};
  rows.slice(1).forEach(r => {
    const status = String(r[iS] || '').trim();
    if (!/refund done|refunded/i.test(status)) return;
    const t = String(r[iT] || '').replace(/\D/g, '');
    if (t.length < 6) return;
    const amt = parseFloat(String(r[iA] || '').replace(/[^\d.]/g, '')) ||
                parseFloat(String(r[iA2] || '').replace(/[^\d.]/g, '')) || 0;
    const ts = Date.parse(r[0]) || 0;
    const rec = /^y/i.test(String(r[iR] || '').trim()) ? 'Yes' : 'No';
    const prev = out[t];
    if (!prev || ts >= prev.t) out[t] = { s: status, a: amt, t: ts, p: (rec === 'Yes' || (prev && prev.p === 'Yes')) ? 'Yes' : rec };
    else if (rec === 'Yes') prev.p = 'Yes';
  });
  await fbPut('/refund_sheet', out);
  log(`Refund sheet sync: ${Object.keys(out).length} refund-done tickets mirrored to /refund_sheet.`);

  // Backfill device_picked_up from the sheet's "Router Recovered" column —
  // only where the tracker field is still empty (never overrides a human edit).
  const cases = await fbGet('/cases') || {};
  let pk = 0;
  for (const [k, c] of Object.entries(cases)) {
    if (!c || c.device_picked_up) continue;
    const e = out[String(c.ticket_no || '').replace(/\D/g, '')];
    if (e && e.p === 'Yes') { await fbPatch('/cases/' + k, { device_picked_up: 'Yes' }); pk++; }
  }
  if (pk) log(`Device pickup: set 'Yes' on ${pk} case(s) from Router Recovered.`);
}

// ── Pro-rata refund amounts (auto-compute) ───────────────────────────────────
// For every flag-era case (added ≥ 29 Jul) with no refund_amount yet:
// refund = (amount paid ÷ plan duration days) × plan days REMAINING at the
// moment the case entered the tracker. Plan looked up by the tracker mobile,
// falling back to the account's registered mobile via SERVICE_TICKET_MODEL
// (tracker mobile ≠ registered mobile for some customers). No active paid
// plan at complaint (lapsed/churned/free) → 0.
const TAT_LAUNCH_MS = Date.parse('2026-07-29T00:00:00+05:30');

async function computeProRataAmounts(apiKey) {
  const all = await fbGet('/cases') || {};
  const targets = Object.entries(all).map(([key, c]) => ({ key, c }))
    .filter(({ c }) => {
      if (!c || !c.ticket_no) return false;
      const ts = Number(c.added_at) || Number(c.owner_assigned_at) || 0;
      if (ts < TAT_LAUNCH_MS) return false;
      return c.refund_amount === undefined || c.refund_amount === null || c.refund_amount === '';
    })
    .slice(0, 300);  // per-run cap; the half-hourly cadence clears any backlog fast
  if (!targets.length) { log('Pro-rata: no cases need amounts.'); return; }
  log(`Pro-rata: computing amounts for ${targets.length} case(s)…`);

  const mobOf = c => String(c.mobile || '').replace(/\D/g, '').slice(-10);

  const fetchPlans = async (mobs) => {
    if (!mobs.length) return [];
    const sql = "SELECT MOBILE, TOTAL_PAID, PLAN_START_TIME, PLAN_END_TIME FROM DYNAMODB.HOME_ROUTER_PLAN_INFO " +
      "WHERE PLAN_END_TIME >= DATEADD(DAY, -45, CURRENT_TIMESTAMP()) AND MOBILE IN (" +
      mobs.map(m => "'" + m + "'").join(',') + ")";
    return queryMetabase(sql, apiKey);
  };
  const plansBy = {};
  const addPlans = rows => rows.forEach(r => {
    (plansBy[r.MOBILE] = plansBy[r.MOBILE] || []).push({
      paid: Number(r.TOTAL_PAID) || 0, st: Date.parse(r.PLAN_START_TIME), en: Date.parse(r.PLAN_END_TIME)
    });
  });
  addPlans(await fetchPlans([...new Set(targets.map(({ c }) => mobOf(c)).filter(m => m.length === 10))]));

  // Fallback: registered mobile for cases whose tracker mobile has no plans
  const regBy = {};
  const noPlan = targets.filter(({ c }) => !(plansBy[mobOf(c)] || []).length);
  if (noPlan.length) {
    const sql2 = "SELECT KAPTURE_TICKET_ID, CUSTOMER_MOBILE FROM PUBLIC.SERVICE_TICKET_MODEL WHERE KAPTURE_TICKET_ID IN (" +
      noPlan.map(({ c }) => "'" + String(c.ticket_no).trim() + "'").join(',') + ")";
    (await queryMetabase(sql2, apiKey)).forEach(r => {
      const reg = String(r.CUSTOMER_MOBILE || '').replace(/\D/g, '').slice(-10);
      if (reg.length === 10) regBy[String(r.KAPTURE_TICKET_ID).trim()] = reg;
    });
    addPlans(await fetchPlans([...new Set(Object.values(regBy))].filter(m => !plansBy[m])));
  }

  let set = 0, nonZero = 0;
  for (const { key, c } of targets) {
    const complaint = Number(c.added_at) || Number(c.owner_assigned_at) || 0;
    const plans = (plansBy[mobOf(c)] || []).concat(plansBy[regBy[String(c.ticket_no).trim()]] || []);
    const active = plans.filter(p => p.st <= complaint && p.en > complaint).sort((a, b) => b.st - a.st)[0];
    let amt = 0;
    if (active && active.paid > 0) {
      const dur = (active.en - active.st) / 86400000;
      const rem = (active.en - complaint) / 86400000;
      amt = Math.max(0, Math.round(active.paid / dur * rem));
    }
    await fbPatch('/cases/' + key, { refund_amount: amt });
    set++; if (amt > 0) nonZero++;
  }
  log(`Pro-rata: set refund_amount on ${set} case(s) (${nonZero} non-zero).`);
}

// ── Kapture resolution sync ──────────────────────────────────────────────────
// Stamps each flag-era case with the PFT completion from SERVICE_TICKET_MODEL
// (FINAL_RESOLVED_TIME + FINAL_RESOLVED_NAME) — feeds the "Cx closure TAT"
// report. Kapture timestamps are IST wall-clock without a zone marker.
async function syncKaptureResolution(apiKey) {
  const all = await fbGet('/cases') || {};
  const targets = Object.entries(all).filter(([, c]) => {
    if (!c || !c.ticket_no) return false;
    const ts = Number(c.added_at) || Number(c.owner_assigned_at) || 0;
    return ts >= TAT_LAUNCH_MS && !c.kapture_resolved_at;
  }).slice(0, 400);
  if (!targets.length) { log('Kapture resolution: nothing to sync.'); return; }
  const ids = targets.map(([, c]) => "'" + String(c.ticket_no).trim() + "'").join(',');
  const rows = await queryMetabase(
    'SELECT KAPTURE_TICKET_ID, FINAL_RESOLVED_TIME, FINAL_RESOLVED_NAME FROM PUBLIC.SERVICE_TICKET_MODEL ' +
    'WHERE IS_RESOLVED = 1 AND FINAL_RESOLVED_TIME IS NOT NULL AND KAPTURE_TICKET_ID IN (' + ids + ')', apiKey);
  const istMs = v => {
    const s = String(v || '').trim().replace(' ', 'T');
    if (!s) return 0;
    return Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + '+05:30') || 0;
  };
  const byT = {};
  rows.forEach(r => { byT[String(r.KAPTURE_TICKET_ID).trim()] = r; });
  let set = 0;
  for (const [k, c] of targets) {
    const m = byT[String(c.ticket_no).trim()];
    if (!m) continue;
    const ts = istMs(m.FINAL_RESOLVED_TIME);
    if (!ts) continue;
    await fbPatch('/cases/' + k, { kapture_resolved_at: ts, kapture_resolved_by: String(m.FINAL_RESOLVED_NAME || '') });
    set++;
  }
  log(`Kapture resolution: stamped ${set} case(s) with PFT completion time.`);
}

// ── Add a batch of tickets to Firebase (skip any already tracked) ────────────
async function addTicketsToFirebase(tickets, sourceLabel) {
  // Dedup within this batch — the mobile join can yield duplicate rows per ticket.
  // When duplicates exist, keep the most-complete row (has a name/partner) rather
  // than whichever happened to arrive last, so a blank row can't win.
  const score = r => (String(r.CUSTOMER_NAME || '').trim() ? 1 : 0)
                   + (String(r.PARTNER || '').trim() ? 1 : 0);
  const uniq = [...tickets.reduce((m, t) => {
    const k = String(t.KAPTURE_TICKET_ID || '').trim();
    if (!k) return m;
    const prev = m.get(k);
    if (!prev || score(t) > score(prev)) m.set(k, t);
    return m;
  }, new Map()).values()];

  let added = 0, skipped = 0, enriched = 0;
  for (const t of uniq) {
    const ticketId = String(t.KAPTURE_TICKET_ID || '').trim();
    if (!ticketId) continue;

    const newPartner = String(t.PARTNER         || '').trim();
    const newName    = String(t.CUSTOMER_NAME   || '').trim();
    const newMobile  = String(t.CUSTOMER_MOBILE || '').trim();

    const key      = ticketKey(ticketId);
    const existing = await fbGet('/cases/' + key);
    if (existing !== null) {
      // Already tracked. Don't re-add or disturb engineer/remarks — but DO backfill
      // CSP/customer details that were missing, by patching only those blank fields.
      const patch = {};
      if (newPartner && !String(existing.partner   || '').trim()) patch.partner   = newPartner;
      if (newName    && !String(existing.cust_name || '').trim()) patch.cust_name = newName;
      if (newMobile  && !String(existing.mobile    || '').trim()) patch.mobile    = newMobile;
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
    WITH nmob AS (
      -- Customer name is resolved by the last 10 digits of mobile (so a stored
      -- '+91'/leading-zero/whitespace mismatch can't make the join miss), deduped
      -- to one name per mobile. Names come from three sources in priority order via
      -- COALESCE below: the legacy COMBINED table first, then the installs model
      -- (near-complete), then the active base — because COMBINED_T_WG_CUSTOMER alone
      -- covers <1% of these customers.
      SELECT RIGHT(REGEXP_REPLACE(MOBILE, '[^0-9]', ''), 10) AS MOB,
             MAX(NAME) AS CNAME
      FROM COMBINED_T_WG_CUSTOMER
      WHERE MOBILE IS NOT NULL AND NAME IS NOT NULL AND TRIM(NAME) != ''
      GROUP BY 1
    ),
    n_inst AS (
      SELECT RIGHT(REGEXP_REPLACE(MOBILE, '[^0-9]', ''), 10) AS MOB, MAX(CUSTOMER_NAME) AS CNAME
      FROM STG_INVENTORY_MODEL_CUSTOMER_INSTALLS
      WHERE MOBILE IS NOT NULL AND CUSTOMER_NAME IS NOT NULL AND TRIM(CUSTOMER_NAME) != ''
      GROUP BY 1
    ),
    n_actv AS (
      SELECT RIGHT(REGEXP_REPLACE(MOBILE, '[^0-9]', ''), 10) AS MOB, MAX(CUSTOMER_NAME) AS CNAME
      FROM ACTIVE_CUST
      WHERE MOBILE IS NOT NULL AND CUSTOMER_NAME IS NOT NULL AND TRIM(CUSTOMER_NAME) != ''
      GROUP BY 1
    )
    SELECT
      stm.KAPTURE_TICKET_ID,
      stm.CUSTOMER_MOBILE,
      COALESCE(nmob.CNAME, n_inst.CNAME, n_actv.CNAME)  AS CUSTOMER_NAME,
      stm.CURRENT_PARTNER_NAME                          AS PARTNER,
      -- Prefer the internet-y title: tickets opened under the generic
      -- "Primary|Existing Customer" folder get re-dispositioned later, and the
      -- internet category then lives in LAST_TITLE, not FIRST_TITLE.
      CASE WHEN (
        stm.FIRST_TITLE ILIKE '%internet%'
        OR stm.FIRST_TITLE ILIKE '%slow speed%'
        OR stm.FIRST_TITLE ILIKE '%frequent disconnection%'
      ) THEN stm.FIRST_TITLE ELSE stm.LAST_TITLE END      AS SUB_CATEGORY,
      FLOOR(stm.TOTALTAT_TILLNOW_MINS_CALENDARHRS / 60) AS TAT_HOURS,
      stm.CURRENT_TICKET_STATUS,
      TO_CHAR(stm.TICKET_ADDED_TIME, 'DD/Mon/YYYY')    AS CREATED_DATE
    FROM SERVICE_TICKET_MODEL stm
    LEFT JOIN nmob   ON nmob.MOB   = RIGHT(REGEXP_REPLACE(stm.CUSTOMER_MOBILE, '[^0-9]', ''), 10)
    LEFT JOIN n_inst ON n_inst.MOB = RIGHT(REGEXP_REPLACE(stm.CUSTOMER_MOBILE, '[^0-9]', ''), 10)
    LEFT JOIN n_actv ON n_actv.MOB = RIGHT(REGEXP_REPLACE(stm.CUSTOMER_MOBILE, '[^0-9]', ''), 10)
    WHERE
      -- Internet-related sub-category. Checked on FIRST_TITLE *and* LAST_TITLE:
      -- ~1 in 4 missed tickets started as "Primary|Existing Customer" and were
      -- only later re-dispositioned to Internet Issues (visible in LAST_TITLE
      -- only) — FIRST_TITLE-only filtering silently dropped them.
      (
        stm.FIRST_TITLE ILIKE '%internet%'
        OR stm.FIRST_TITLE ILIKE '%slow speed%'
        OR stm.FIRST_TITLE ILIKE '%frequent disconnection%'
        OR stm.LAST_TITLE ILIKE '%internet%'
        OR stm.LAST_TITLE ILIKE '%slow speed%'
        OR stm.LAST_TITLE ILIKE '%frequent disconnection%'
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

  // T_TICKETS_NEW has no partner column, so CSP/partner is resolved from two
  // deduped lookups and COALESCEd: (1) the customer's current partner by mobile,
  // (2) the partner the ticket is assigned to by account. Combined ~99% coverage.
  // Lookups are GROUP BY'd to one row per key so they never fan out the tickets.
  const chatSql = `
    WITH pmob AS (
      SELECT RIGHT(REGEXP_REPLACE(MOBILE, '[^0-9]', ''), 10) AS MOB, MAX(CURRENT_PARTNER_NAME) AS PNAME
      FROM CUSTOMER_ENRICHED_DBT
      WHERE MOBILE IS NOT NULL AND CURRENT_PARTNER_NAME IS NOT NULL
      GROUP BY 1
    ),
    pacct AS (
      SELECT PARTNER_ACCOUNT_ID AS ACCT, MAX(PARTNER_NAME) AS PNAME
      FROM CUSTOMER_BASE
      WHERE PARTNER_ACCOUNT_ID IS NOT NULL AND PARTNER_NAME IS NOT NULL
      GROUP BY 1
    ),
    nmob AS (
      SELECT RIGHT(REGEXP_REPLACE(MOBILE, '[^0-9]', ''), 10) AS MOB, MAX(NAME) AS CNAME
      FROM COMBINED_T_WG_CUSTOMER
      WHERE MOBILE IS NOT NULL AND NAME IS NOT NULL AND TRIM(NAME) != ''
      GROUP BY 1
    ),
    n_inst AS (
      SELECT RIGHT(REGEXP_REPLACE(MOBILE, '[^0-9]', ''), 10) AS MOB, MAX(CUSTOMER_NAME) AS CNAME
      FROM STG_INVENTORY_MODEL_CUSTOMER_INSTALLS
      WHERE MOBILE IS NOT NULL AND CUSTOMER_NAME IS NOT NULL AND TRIM(CUSTOMER_NAME) != ''
      GROUP BY 1
    ),
    n_actv AS (
      SELECT RIGHT(REGEXP_REPLACE(MOBILE, '[^0-9]', ''), 10) AS MOB, MAX(CUSTOMER_NAME) AS CNAME
      FROM ACTIVE_CUST
      WHERE MOBILE IS NOT NULL AND CUSTOMER_NAME IS NOT NULL AND TRIM(CUSTOMER_NAME) != ''
      GROUP BY 1
    )
    SELECT
      t.KAPTURE_TICKET_ID,
      t.MOBILE                                          AS CUSTOMER_MOBILE,
      COALESCE(nmob.CNAME, n_inst.CNAME, n_actv.CNAME)  AS CUSTOMER_NAME,
      COALESCE(pmob.PNAME, pacct.PNAME)                 AS PARTNER,
      t.TITLE                                           AS SUB_CATEGORY,
      FLOOR(DATEDIFF(MINUTE, t.CREATED_TIME, CURRENT_TIMESTAMP()) / 60) AS TAT_HOURS,
      t.STATUS                                          AS CURRENT_TICKET_STATUS,
      TO_CHAR(t.CREATED_TIME, 'DD/Mon/YYYY')            AS CREATED_DATE,
      'Chat'                                            AS CHANNEL
    FROM T_TICKETS_NEW t
    LEFT JOIN pmob   ON pmob.MOB   = RIGHT(REGEXP_REPLACE(t.MOBILE, '[^0-9]', ''), 10)
    LEFT JOIN pacct  ON pacct.ACCT = t.ASSIGNED_ACCOUNT_ID
    LEFT JOIN nmob   ON nmob.MOB   = RIGHT(REGEXP_REPLACE(t.MOBILE, '[^0-9]', ''), 10)
    LEFT JOIN n_inst ON n_inst.MOB = RIGHT(REGEXP_REPLACE(t.MOBILE, '[^0-9]', ''), 10)
    LEFT JOIN n_actv ON n_actv.MOB = RIGHT(REGEXP_REPLACE(t.MOBILE, '[^0-9]', ''), 10)
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

  // ── Step 2.5: Mirror the Finance refund sheet into /refund_sheet ──
  // Failure here must never break the ticket sync.
  try { await syncRefundSheet(); } catch (e) { log('WARN: refund sheet sync failed — ' + e.message); }

  // ── Step 2.6: Auto-compute pro-rata refund amounts for new flag-era cases ──
  try { await computeProRataAmounts(apiKey); } catch (e) { log('WARN: pro-rata compute failed — ' + e.message); }

  // ── Step 2.7: Stamp Kapture PFT completion times (Cx closure TAT report) ──
  try { await syncKaptureResolution(apiKey); } catch (e) { log('WARN: Kapture resolution sync failed — ' + e.message); }


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
