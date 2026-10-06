/**
 * Weekly 48h-flag metrics recap.
 * Runs every Monday (GitHub Actions): recomputes metrics from Firebase,
 * regenerates recap.html in the repo root (served via GitHub Pages), and
 * DMs the summary + doc link to Shariq on Slack.
 *
 * Weeks are Monday-anchored in IST: "last week" = the just-completed Mon–Sun,
 * compared against the week before; "till date" = 29 Jul launch → now.
 * All percentages use matured cases (completed their full 48h window).
 */

const fs = require('fs');
const path = require('path');

const FIREBASE_DB = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const LAUNCH = Date.parse('2026-07-29T00:00:00+05:30');
const LIM = 48 * 3600000;
const NET_LIM = 52 * 3600000;   // window for the net-resolved test from the week of 28 Sep 2026 (Shariq, 6 Oct); not stated on the page
const IST = 5.5 * 3600000;
const SLACK_USER = 'U04TL31PC1Y'; // Shariq
const DOC_URL = 'https://shariqkhan-ui.github.io/hp-customer-tracker/recap.html';
// Field team's reopen-RCA sheet (CX/CSP remarks + last ping per reopened ticket)
const REFUND_SHEET_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vREJtTEloJoNZdZe8EVsnmWrigVJJXT-ciwH7uNCUz34Q10Nj0h8KH3G74rHAh4d5zwerfk0uer7fZz/pub?gid=1692552304&single=true&output=csv';
const RCA_SHEET_CSV = 'https://docs.google.com/spreadsheets/d/1cXCnazjjLfzxG4-Uyr9nrGGo4qgGbbQ-zjFZ6xG_9vk/export?format=csv&gid=0';

function parseCSVText(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const TARGET_PCT = 80; // within-48h resolution target by end of August

// ── PTL calls ────────────────────────────────────────────────────────────────
// The CSP-side call desk. Attribution follows Metabase card 12025: an Ameyo
// call on QUEUE_NAME 'PartnerSupportQueue' belongs to the CSP whose owner or
// Rohit contact number placed it. Needs METABASE_API_KEY; without it the
// column simply renders blank rather than failing the recap.
const METABASE = 'https://metabase.wiom.in';
const normName = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Why they called. Ameyo's own disposition is 88% 'wrap.timeout' (the agent
// never tagged the call), so the usable reason is the Kapture PTL ticket the
// call raised — DISPOSITION_FOLDER_LEVEL_2, deduped to the latest snapshot
// per ticket. Keyed to the CSP by CUSTOMER_CODE = partner account id.
// Kapture is the system of record for reopens. The tracker's reopened_at is
// only stamped when someone reverts a resolution remark IN THE DASHBOARD
// within 24 hours, so a ticket reopened in Kapture never reaches it — it
// catches roughly half the real reopens. This pulls FIRST_REOPENED_TIME for
// every ticket reopened since launch, so the rate can be measured properly.
async function kaptureReopens(fromISO) {
  const key = process.env.METABASE_API_KEY;
  if (!key) { console.log('METABASE_API_KEY not set — reopens fall back to the tracker field only.'); return null; }
  const map = {};
  try {
    // The reopen tag is an EVENT, not a column: TICKET_LOGS.EVENT_NAME =
    // 'TICKET_REOPENED', one event per reopen. This used to read
    // SERVICE_TICKET_MODEL.FIRST_REOPENED_TIME, which is only the FIRST reopen
    // of a ticket's life - a ticket reopened three times in September still
    // reported its July reopen - and its sibling TIMES_REOPENED is a raw count
    // of log rows that the pipeline duplicates about 94 times (one reopen reads
    // as 95). The log is deduplicated here by taking the LAST reopen per ticket.
    // Metabase caps a dataset response at 2,000 rows, so this pages - a silent
    // truncation here would quietly under-report every reopen in the doc.
    for (let off = 0; off < 40000; off += 1800) {
      const sql = `WITH re AS (
          SELECT TRY_TO_NUMBER(TASK_ID) AS TID, MAX(ADDED_TIME) AS LAST_REOPEN
          FROM PROD_DB.PUBLIC.TICKET_LOGS
          WHERE EVENT_NAME = 'TICKET_REOPENED' AND ADDED_TIME >= '${fromISO}'
          GROUP BY 1
        )
        SELECT t.KAPTURE_TICKET_ID, TO_CHAR(re.LAST_REOPEN,'YYYY-MM-DD') AS d
        FROM re JOIN PROD_DB.PUBLIC.T_TICKETS_NEW t ON t.TICKET_ID = re.TID
        ORDER BY t.KAPTURE_TICKET_ID LIMIT 1800 OFFSET ${off}`;
      const r = await fetch(METABASE + '/api/dataset', {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } }),
      }).then(x => x.json());
      if (!r.data || !r.data.rows) throw new Error(JSON.stringify(r.error || r).slice(0, 200));
      r.data.rows.forEach(([t, d]) => {
        const k = String(t || '').replace(/\D/g, '');
        if (k && (!map[k] || d > map[k])) map[k] = d;      // keep the latest reopen
      });
      if (r.data.rows.length < 1800) break;
    }
    console.log('Kapture reopen events (from the log):', Object.keys(map).length);
    return map;
  } catch (e) {
    console.error('Kapture reopen query failed (non-fatal):', e.message);
    return null;
  }
}
// Open vs closed on those tickets, counted over ALL of them — the reasons
// query below is capped at three rows per CSP and must never be summed for
// totals.
// Userbase and MG enrolment per CSP. customer_base is a daily snapshot,
// so it MUST be pinned to one date or every partner multiplies by the number
// of days held.
// Bonus actually credited to the CSP's settlement wallet, per fortnightly
// cycle. This is the live source: every bonus table in the analytics layer
// (PARTNER_BONUS_DISBURSEMENT, PARTNER_INCENTIVES, WORK_BONUS_TXNS,
// INCENTIVEVANILLA) stopped feeding between 1 and 23 June 2026, but the
// payment-settlement wallet ledger is current to the hour.
// Amounts are stored in paise. The ledger keys on a short CSP code
// (e.g. a0b9a4), so it joins out through CSP_ACCOUNT to the partner.
async function cspPayout(cycles) {
  const key = process.env.METABASE_API_KEY;
  if (!key) return null;
  const sql = `WITH acct AS (
    SELECT DISTINCT CSP_ID, NAME FROM CSP_GATEWAY_SERVICE_CSP_GATEWAY_SERVICE.CSP_ACCOUNT WHERE NAME IS NOT NULL
  ), led AS (
    SELECT CSP_ID, AMOUNT, CREATED_AT
    FROM CSP_PAYMENT_SETTLEMENT_SERVICE_CSP_PAYMENT_SETTLEMENT_SERVICE.WALLET_LEDGER_ENTRIES
    WHERE ENTRY_TYPE = 'BONUS_CREDIT' AND COALESCE(_FIVETRAN_ACTIVE, TRUE)
      AND CREATED_AT >= '2026-07-01'
  )
  SELECT acct.NAME,
    TO_CHAR(MAX(led.CREATED_AT), 'DD Mon') AS last_when,
    ROUND(MAX_BY(led.AMOUNT, led.CREATED_AT) / 100) AS last_rs,
    ${cycles.map((c, i) => `ROUND(SUM(CASE WHEN led.CREATED_AT >= '${c[1]}' AND led.CREATED_AT < '${c[2]}' THEN led.AMOUNT ELSE 0 END) / 100) AS c${i}`).join(',\n    ')}
  FROM led JOIN acct ON acct.CSP_ID = led.CSP_ID
  GROUP BY 1`;
  try {
    const r = await fetch(METABASE + '/api/dataset', {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } }),
    }).then(x => x.json());
    if (!r.data || !r.data.rows) throw new Error(JSON.stringify(r.error || r).slice(0, 200));
    const m = {};
    r.data.rows.forEach(row => {
      const k = normName(row[0]);
      if (!k) return;
      const e = m[k] || (m[k] = { cyc: cycles.map(() => 0), lastWhen: row[1], lastRs: Number(row[2]) || 0 });
      for (let i = 0; i < cycles.length; i++) e.cyc[i] += Number(row[i + 3]) || 0;
    });
    console.log('CSP bonus payout for', Object.keys(m).length, 'CSPs');
    return m;
  } catch (e) {
    console.error('CSP payout query failed (non-fatal):', e.message);
    return null;
  }
}
// Wiom Hub is where a refund is actually raised, approved and paid, so it is
// the system of record for the money. The tracker and the Finance sheet record
// what the desk BELIEVES was paid; this table records what the payment system
// did. Keyed on the customer's number. Rows are SCD-versioned by Fivetran, so
// only the active version of each request counts.
async function hubRefunds() {
  const key = process.env.METABASE_API_KEY;
  if (!key) { console.log('METABASE_API_KEY not set - Wiom Hub refunds unavailable.'); return null; }
  const sql = `SELECT MOBILE, STATUS, REFUND_STATUS,
      COALESCE(APPROVED_REFUND_AMOUNT, REFUND_AMOUNT) AS AMT,
      TO_CHAR(COALESCE(APPROVED_TIME, REQUESTED_TIME), 'YYYY-MM-DD') AS WHEN_,
      UTR, REMARKS
    FROM PROD_DB.CUSTOMER_JAVA_PUBLIC.T_PLAN_REFUND_REQUEST
    WHERE COALESCE(_FIVETRAN_ACTIVE, TRUE)`;
  try {
    const r = await fetch(METABASE + '/api/dataset', {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } }),
    }).then(x => x.json());
    if (!r.data || !r.data.rows) throw new Error(JSON.stringify(r.error || r).slice(0, 200));
    const m = {};
    r.data.rows.forEach(([mob, st, rs, amt, when, utr, rem]) => {
      const k = String(mob || '').replace(/\D/g, '').slice(-10);
      if (k.length !== 10) return;
      const e = { st: String(st || '').trim(), rs: String(rs || '').trim(), amt: Number(amt) || 0, when: when || '', utr: String(utr || '').trim(), rem: String(rem || '').trim() };
      if (!m[k] || (e.when || '') >= (m[k].when || '')) m[k] = e;
    });
    console.log('Wiom Hub refund requests for', Object.keys(m).length, 'customers');
    return m;
  } catch (e) {
    console.error('Wiom Hub refund query failed (non-fatal):', e.message);
    return null;
  }
}
async function cspProfile() {
  const key = process.env.METABASE_API_KEY;
  if (!key) return null;
  const sql = `WITH d AS (SELECT MAX(DATE) AS md FROM customer_base)
  SELECT cb.PARTNER_NAME,
         MAX(cb.PAYING_CUSTOMERS) AS paying,
         MAX(cb.ACTIVE_R15_CUSTOMERS) AS r15,
         MAX(CASE WHEN mg.PARTNER_ID IS NOT NULL THEN 1 ELSE 0 END) AS mg
  FROM customer_base cb
  CROSS JOIN d
  LEFT JOIN PROD_DB.PUBLIC.MICROZONE_MG_CSPS mg
    ON CAST(mg.PARTNER_ID AS STRING) = CAST(cb.PARTNER_ACCOUNT_ID AS STRING)
  WHERE cb.DATE = d.md AND cb.PARTNER_NAME IS NOT NULL
  GROUP BY 1`;
  try {
    const r = await fetch(METABASE + '/api/dataset', {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } }),
    }).then(x => x.json());
    if (!r.data || !r.data.rows) throw new Error(JSON.stringify(r.error || r).slice(0, 200));
    const m = {};
    r.data.rows.forEach(([name, paying, r15, mg]) => {
      const k = normName(name);
      if (k) m[k] = { paying: Number(paying) || 0, r15: Number(r15) || 0, mg: Number(mg) === 1 };
    });
    console.log('CSP profiles (userbase + MG) for', Object.keys(m).length, 'CSPs');
    return m;
  } catch (e) {
    console.error('CSP profile query failed (non-fatal):', e.message);
    return null;
  }
}
// Which city a CSP belongs to, from hierarchy_base CLUSTER: Delhi covers
// NCR (Ghaziabad, Noida, Faridabad, Gurgaon), Mumbai is Mumbai, and every
// other cluster is a UP city (Meerut, Agra, Bareilly, Lucknow, Prayagraj,
// Gorakhpur) — Bharat.
async function cspCityByName() {
  const key = process.env.METABASE_API_KEY;
  if (!key) return null;
  const sql = `SELECT DISTINCT PARTNER_NAME, CLUSTER FROM hierarchy_base WHERE dedup_flag = 1 AND PARTNER_NAME IS NOT NULL`;
  try {
    const r = await fetch(METABASE + '/api/dataset', {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } }),
    }).then(x => x.json());
    if (!r.data || !r.data.rows) throw new Error(JSON.stringify(r.error || r).slice(0, 200));
    const m = {};
    r.data.rows.forEach(([name, cluster]) => {
      const k = normName(name); if (!k) return;
      const cl = String(cluster || '').trim().toLowerCase();
      m[k] = cl === 'delhi' ? 'Delhi/NCR' : cl === 'mumbai' ? 'Mumbai' : cl ? 'Bharat' : '';
    });
    console.log('CSP city map for', Object.keys(m).length, 'CSPs');
    return m;
  } catch (e) {
    console.error('CSP city query failed (non-fatal):', e.message);
    return null;
  }
}
async function ptlStatusByPartner(from, to) {
  const key = process.env.METABASE_API_KEY;
  if (!key) return null;
  const d = t => new Date(t + IST).toISOString().slice(0, 10);
  const sql = `WITH pb AS (
    SELECT DISTINCT partner_account_id, partner_name FROM hierarchy_base WHERE dedup_flag = 1
  ), t AS (
    SELECT REGEXP_REPLACE(CAST(CUSTOMER_CODE AS STRING), '\.0$', '') AS acct, TRIM(STATUS) AS status,
           TO_DATE(CREATED_DATE, 'DD/MM/YYYY') AS cd
    FROM PROD_DB.PUBLIC.KAPTURE_PARTNER_TICKETS_REPORT
    WHERE TO_DATE(CREATED_DATE, 'DD/MM/YYYY') >= '${d(from)}'
      AND TO_DATE(CREATED_DATE, 'DD/MM/YYYY') <  '${d(to)}'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TICKET_NO ORDER BY INGESTED_AT DESC) = 1
  )
  SELECT pb.partner_name,
         COUNT_IF(t.status ILIKE 'Pending') AS open_n,
         COUNT_IF(t.status ILIKE 'Complete') AS closed_n,
         MAX(CASE WHEN t.status ILIKE 'Pending' THEN DATEDIFF(day, t.cd, CURRENT_DATE) END) AS oldest_open
  FROM t JOIN pb ON CAST(pb.partner_account_id AS STRING) = t.acct
  GROUP BY 1`;
  try {
    const r = await fetch(METABASE + '/api/dataset', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } }),
    }).then(x => x.json());
    if (!r.data || !r.data.rows) throw new Error(JSON.stringify(r.error || r).slice(0, 200));
    const map = {};
    r.data.rows.forEach(([name, o, c, oldest]) => {
      const k = normName(name);
      if (k) map[k] = { open: Number(o) || 0, closed: Number(c) || 0, oldest: Number(oldest) || 0 };
    });
    console.log('PTL ticket status fetched for', Object.keys(map).length, 'CSPs');
    return map;
  } catch (e) {
    console.error('PTL status query failed (non-fatal):', e.message);
    return null;
  }
}
async function ptlReasonsByPartner(from, to) {
  const key = process.env.METABASE_API_KEY;
  if (!key) return null;
  const d = t => new Date(t + IST).toISOString().slice(0, 10);
  const sql = `WITH pb AS (
    SELECT DISTINCT partner_account_id, partner_name FROM hierarchy_base WHERE dedup_flag = 1
  ), t AS (
    SELECT REGEXP_REPLACE(CAST(CUSTOMER_CODE AS STRING), '\.0$', '') AS acct,
           NULLIF(TRIM(DISPOSITION_FOLDER_LEVEL_2), '') AS reason,
           TRIM(STATUS) AS status
    FROM PROD_DB.PUBLIC.KAPTURE_PARTNER_TICKETS_REPORT
    WHERE TO_DATE(CREATED_DATE, 'DD/MM/YYYY') >= '${d(from)}'
      AND TO_DATE(CREATED_DATE, 'DD/MM/YYYY') <  '${d(to)}'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TICKET_NO ORDER BY INGESTED_AT DESC) = 1
  )
  SELECT pb.partner_name, COALESCE(t.reason, 'Not categorised') AS reason, COUNT(*) AS n
  FROM t JOIN pb ON CAST(pb.partner_account_id AS STRING) = t.acct
  GROUP BY 1, 2
  QUALIFY ROW_NUMBER() OVER (PARTITION BY pb.partner_name ORDER BY COUNT(*) DESC) <= 3`;
  try {
    const r = await fetch(METABASE + '/api/dataset', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } }),
    }).then(x => x.json());
    if (!r.data || !r.data.rows) throw new Error(JSON.stringify(r.error || r).slice(0, 200));
    const map = {};
    r.data.rows.forEach(([name, reason, n]) => {
      const k = normName(name);
      if (!k) return;
      (map[k] = map[k] || []).push({ reason, n: Number(n) || 0 });
    });
    Object.values(map).forEach(v => v.sort((a, b) => b.n - a.n));
    console.log('PTL ticket reasons fetched for', Object.keys(map).length, 'CSPs');
    return map;
  } catch (e) {
    console.error('PTL reasons query failed (non-fatal):', e.message);
    return null;
  }
}
async function ptlCallsByPartner(periods) {
  const key = process.env.METABASE_API_KEY;
  if (!key) { console.log('METABASE_API_KEY not set — PTL calls column left blank.'); return null; }
  const ts = t => new Date(t + IST).toISOString().slice(0, 19).replace('T', ' ');
  const buckets = periods.map((p, i) =>
    `COUNT_IF(ct >= '${ts(p.from)}' AND ct < '${ts(p.to)}') AS p${i}`).join(', ');
  const sql = `WITH pb AS (
    SELECT partner_account_id, partner_name, partner_mobile AS mobile FROM hierarchy_base WHERE dedup_flag = 1
    UNION ALL
    SELECT partner_account_id, partner_name, rohit_contact FROM hierarchy_base WHERE dedup_flag = 1
  ), c AS (
    SELECT pb.partner_name AS pn, a.CALL_TIME AS ct
    FROM PROD_DB.PUBLIC.AMEYO_CALL_DETAILS_REPORT a
    JOIN pb ON a.PHONE = pb.mobile
    WHERE a.QUEUE_NAME = 'PartnerSupportQueue'
      AND a.CALL_TIME >= '${ts(periods[periods.length - 1].from)}'
      AND a.CALL_TIME <  '${ts(periods[periods.length - 1].to)}'
  )
  SELECT pn, ${buckets} FROM c GROUP BY pn`;
  try {
    const r = await fetch(METABASE + '/api/dataset', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } }),
    }).then(x => x.json());
    if (!r.data || !r.data.rows) throw new Error(JSON.stringify(r.error || r).slice(0, 200));
    const map = {};
    r.data.rows.forEach(row => {
      const k = normName(row[0]);
      if (!k) return;
      const arr = map[k] || (map[k] = periods.map(() => 0));
      for (let i = 0; i < periods.length; i++) arr[i] += Number(row[i + 1]) || 0;
    });
    console.log('PTL calls fetched for', Object.keys(map).length, 'CSPs');
    return map;
  } catch (e) {
    console.error('PTL calls query failed (non-fatal):', e.message);
    return null;
  }
}

const MON = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{4})$/);
  if (m) { const mo = MON[m[2].toLowerCase()]; if (mo !== undefined) return new Date(+m[3], mo, +m[1]); }
  m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}
const trim = v => (v == null ? '' : String(v)).trim();
const PING = ['ping up', 'internet working', 'internet up', 'speed up', 'link up'];
function getStatus(c) {
  if (trim(c.cx_verdict) === 'Not Resolved') return 'Unresolved';   // Cx team overrules a resolved remark (30 Sep)
  if (trim(c.migration_date) !== '') return 'Migrated';
  const g = trim(c.remarks).toLowerCase();
  if (g === 'resolved by old partner' || g === 'resolved by old csp') return 'Ping Up';
  const sc = trim(c.subcat).toLowerCase();
  if (['internet supply down', 'recharge done but no internet'].some(s => sc.includes(s)) && PING.some(k => g.includes(k))) return 'Ping Up';
  return 'Unresolved';
}
function startTs(c) {
  let t = Number(c.added_at) || 0;
  if (!t) { const d = parseDate(c.case_added_on); t = d ? d.getTime() : 0; }
  if (!t) t = Number(c.owner_assigned_at) || 0;
  return t;
}
// caseStartTs (index.html:2926) — the clock the 48-hr flag actually runs on.
function clockTs(c) {
  let t = Number(c.added_at) || Number(c.owner_assigned_at) || 0;
  if (!t) { const d = parseDate(c.case_added_on); t = d ? d.getTime() : 0; }
  return t >= LAUNCH ? t : 0;
}
const isMatured = c => { const t = clockTs(c); return t > 0 && (Date.now() - t) >= LIM; };
// The moment a case's 48-hour window closed. The tracker's Weekly Review tab
// cohorts on this, not on the date the case arrived: a case added on Friday
// matures on Sunday and belongs to the week it matured in. Every weekly number
// in this doc uses it, so the doc and the tab always agree.
const maturedAt = c => { const t = clockTs(c); return t > 0 ? t + LIM : 0; };
// Router pinged AFTER the complaint -> the line came back, nothing owed.
const pingedAfter = c => Number(c.last_ping_at) > 0 && Number(c.last_ping_at) > startTs(c);
// Cases that matured before 28 Sep 2026 keep the earlier 48-hr test, so published weeks do not move (Shariq, 6 Oct).
const NET_LIM_FROM = Date.UTC(2026, 8, 28) - IST;
const netLimFor = c => (maturedAt(c) >= NET_LIM_FROM ? NET_LIM : LIM);
function resolvedWithin48(c) {
  if (getStatus(c) === 'Unresolved') return false;
  const s = startTs(c), rt = Number(c.remarks_updated_at) || 0;
  const lim = netLimFor(c);
  if (rt > 0) return (rt - s) <= lim;
  const md = parseDate(c.migration_date);
  if (md) return (md.getTime() + 86399000 - s) <= lim;
  return null;
}

function fmtD(ts) {
  const d = new Date(ts + IST);
  return d.getUTCDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
}
const inr = v => '₹' + Math.round(v).toLocaleString('en-IN');
const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';

(async () => {
  const NOW = Date.now();
  const [casesRaw, sheet, sheetMob, aiRaw] = await Promise.all([
    fetch(FIREBASE_DB + '/cases.json').then(r => r.json()),
    fetch(FIREBASE_DB + '/refund_sheet.json').then(r => r.json()).catch(() => ({})),
    fetch(FIREBASE_DB + '/refund_sheet_mob.json').then(r => r.json()).catch(() => ({})),
    fetch(FIREBASE_DB + '/cases/__action_items__.json').then(r => r.json()).catch(() => ({})),
  ]);
  const dig = v => String(v || '').replace(/\D/g, '');
  // /refund_sheet_mob is a mirror the sync writes; on 22 Sep it was wiped when
  // Finance overwrote the "Register number" header and the sync put an empty
  // object. Read the sheet directly rather than silently under-counting every
  // refund that only matches on the customer's number.
  let sheetMobLive = sheetMob;
  if (!sheetMobLive || !Object.keys(sheetMobLive).length) {
    try {
      const rows = parseCSVText(await fetch(REFUND_SHEET_CSV, { redirect: 'follow' }).then(r => r.text()));
      const HH = rows[0].map(h => h.trim().toLowerCase());
      const iS = HH.indexOf('refund status');
      const iA = HH.findIndex(h => h === 'refund amount');
      const iA2 = HH.findIndex(h => h.startsWith('refund amount (plan'));
      let mobCols = HH.map((h, i) => (h.startsWith('register number') ? i : -1)).filter(i => i >= 0);
      if (!mobCols.length) mobCols = [23];   // column X, whatever its header now says
      const m = {};
      rows.slice(1).forEach(r => {
        if (!/refund done|refunded/i.test(String(r[iS] || ''))) return;
        const amt = parseFloat(String(r[iA] || '').replace(/[^\d.]/g, '')) ||
                    parseFloat(String(r[iA2] || '').replace(/[^\d.]/g, '')) || 0;
        const t = Date.parse(r[0]) || 0;
        mobCols.forEach(i => {
          const k = String(r[i] || '').replace(/\D/g, '').slice(-10);
          if (k.length === 10 && (!m[k] || t >= m[k].t)) m[k] = { s: 'Refund Done', a: amt, t };
        });
      });
      sheetMobLive = m;
      console.log('refund_sheet_mob missing in Firebase — rebuilt', Object.keys(m).length, 'numbers from the sheet');
    } catch (e) { console.error('refund sheet fallback failed (non-fatal):', e.message); }
  }
  // Finance-sheet match by Kapture ticket OR the customer's registered number
  const sheetEntry = c => (sheet && sheet[dig(c.ticket_no)]) ||
    (sheetMobLive && sheetMobLive[dig(c.mobile).slice(-10)]) || null;
  let era = Object.entries(casesRaw)
    .filter(([k]) => !k.startsWith('__'))
    .map(([, c]) => c)
    .filter(c => c && c.ticket_no && startTs(c) >= LAUNCH);
  // (CUT is applied just below, once the week slices are known.)

  // Weeks are the TRACKER's own buckets (index.html weekSliceOf): calendar
  // slices 1-7 / 8-14 / 15-21 / 22-end. Those drive the dashboard's Week
  // filter and every Reports column, so the recap has to use them too.
  // Intake stops at the end of the most recent Saturday — an unworked
  // Sunday/Monday arrival must not drag a week's numbers down.
  const MN2 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const istNow = new Date(NOW + IST);
  const istMs = (y, m, day) => Date.UTC(y, m, day) - IST;
  const istMidnight = istMs(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  const CUT = NOW; // this moment — every case that has matured up to now counts, today included (Shariq, 6 Oct)
  const cutLabel = fmtD(CUT - 1);
  function sliceOf(ts) {
    const d = new Date(ts + IST);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const ranges = [[1, 7], [8, 14], [15, 21], [22, lastDay]];
    let wi = 4, a = 22, b = lastDay;
    for (let i = 0; i < 4; i++) { if (day >= ranges[i][0] && day <= ranges[i][1]) { wi = i + 1; a = ranges[i][0]; b = ranges[i][1]; break; } }
    return { id: y * 10000 + m * 100 + wi, key: MN2[m] + ' W' + wi, from: istMs(y, m, a), to: istMs(y, m, b + 1) };
  }
  // Review weeks, oldest first: the three completed Monday-to-Sunday weeks
  // before the week the doc is generated in. Rolls on its own every Monday
  // (6 Oct 2026: the hand-set September windows had not moved, so the 5 Oct
  // doc still showed 7-27 Sep). Each entry is [label, first day inclusive,
  // first day AFTER the window]. The current part-week is deliberately absent.
  const DAY = 86400000;
  const thisMon = istMidnight - ((istNow.getUTCDay() + 6) % 7) * DAY;   // Monday 00:00 IST of the current week
  // Week 1 runs to the end of yesterday (Shariq, 6 Oct: "for this week too
  // till 5th Oct"): on the Monday cron that is Mon-Sun; on a Tuesday run the
  // Monday just gone is included too.
  const WEEKS = [3, 2, 1].map(i => ['Week ' + i, thisMon - i * 7 * DAY, i === 1 ? Math.max(thisMon, istMidnight) : thisMon - (i - 1) * 7 * DAY]);
  const periods = WEEKS.map(([key, from, to]) => ({ key, from, to }))
    .concat([{ key: 'Since launch', from: LAUNCH, to: CUT }]);
  periods.forEach(pp => { pp.to = Math.min(pp.to, CUT); pp.label = fmtD(pp.from) + ' – ' + fmtD(pp.to - 1); });
  const LASTCOL = periods.length - 1;
  // Why a reopened case came back. Two sources: the field team's reopen RCA
  // sheet (the customer's own account and what the CSP said), and Kapture's
  // record of who reopened the ticket. Sheet failure must not kill the recap.
  const reopReason = {};
  const reopRcaRows = [];
  try {
    const sh = parseCSVText(await fetch(RCA_SHEET_CSV, { redirect: 'follow' }).then(r => r.text()));
    const H = sh[0].map(h => h.trim().toLowerCase());
    const col = n => H.findIndex(h => h === n);
    const iT = col('ticket no'), iCx = col('cx remarks'), iCsp = col('csp remarks'), iP = col('last ping time');
    const iA = col('added at (time)'), iM = col('mobile'), iN = col('customer name'),
          iC = col('csp'), iS = col('sub-category'), iSt = col('status');
    sh.slice(1).forEach(r => {
      const t = String(r[iT] || '').replace(/\D/g, '');
      if (t) reopReason[t] = { cx: trim(r[iCx]), csp: trim(r[iCsp]), ping: trim(r[iP]), status: iSt >= 0 ? trim(r[iSt]) : '' };
      if (t) reopRcaRows.push({
        t, when: trim(r[iA]), mobile: trim(r[iM]), cust: trim(r[iN]), cspName: trim(r[iC]),
        subcat: trim(r[iS]), cx: trim(r[iCx]), csp: trim(r[iCsp]), status: iSt >= 0 ? trim(r[iSt]) : '',
      });
    });
    console.log('reopen RCA rows:', Object.keys(reopReason).length);
  } catch (e) { console.error('reopen RCA sheet unreadable (non-fatal):', e.message); }

  const hub = await hubRefunds();
  const hubOf = c => (hub && hub[dig(c.mobile).slice(-10)]) || null;
  // APPROVED covers both SUCCESS (money out) and INITIATED (approved, in
  // flight). REJECTED and PENDING are not a refund.
  const hubPaid = c => { const h = hubOf(c); return !!h && h.st === 'APPROVED'; };
  const ptl = await ptlCallsByPartner(periods);
  // Kapture's reopen event log is no longer used by any number on the page
  // (reopens are the tracker's own stamp) and the query on TICKET_LOGS can hang
  // for many minutes, so it is not fetched.
  const kReop = null;
  const kWho = await (async () => {
    const key = process.env.METABASE_API_KEY;
    if (!key) return {};
    const sql = `SELECT KAPTURE_TICKET_ID, TO_CHAR(FIRST_REOPENED_TIME,'DD Mon HH24:MI') AS t,
        COALESCE(NULLIF(TRIM(FIRST_REOPENED_BY_ROLE),''),'not recorded') AS role
      FROM PROD_DB.PUBLIC.SERVICE_TICKET_MODEL
      WHERE FIRST_REOPENED_TIME >= '2026-08-20'`;
    try {
      const r = await fetch(METABASE + '/api/dataset', {
        method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } }),
      }).then(x => x.json());
      const m = {};
      (r.data && r.data.rows || []).forEach(([t, when, role]) => {
        const k = String(t || '').replace(/\D/g, ''); if (k) m[k] = { when, role };
      });
      return m;
    } catch (e) { console.error('reopen-by query failed (non-fatal):', e.message); return {}; }
  })();
  // A reopen counts when the ticket came back AFTER we marked it resolved.
  // A Kapture reopen dated on or before our resolution is usually why the case
  // reached this tracker in the first place, not a failure of our fix.
  const dayOf = ms => new Date(Number(ms) + IST).toISOString().slice(0, 10);
  // Per Shariq (28 Sep): the doc's numbers must line up with last Monday's
  // doc, whose Reopened row counted the tracker's own reopen stamp. So the
  // net deduction is that same stamp, and nothing else: Resolved minus the
  // Reopened row is the Net row. Kapture's event log, which also catches
  // reopens the tracker never stamped, is kept only as a side note.
  const reopenedAfter = c => Number(c.reopened_at) > 0;      // dashboard-stamped
  const reopenedInKapture = c => {
    if (!kReop) return false;
    const d = kReop[dig(c.ticket_no)];
    if (!d) return false;
    const rt = Number(c.remarks_updated_at) || 0;
    return rt > 0 && d > dayOf(rt);
  };
  const ptlWhy = await ptlReasonsByPartner(LAUNCH, CUT);
  const ptlSt = await ptlStatusByPartner(LAUNCH, CUT);
  const cspProf = await cspProfile();
  const cspCity = await cspCityByName();
  // The two fortnightly cycles the review compares.
  // Bonus is credited on the 1st and the 16th, so the credit DATE is the payout date,
  // not the earning window: the 16-31 Aug cycle lands on 1 Sep and the 1-15 Sep
  // cycle lands on 16 Sep. Windowing by earning dates shifts every figure a cycle early.
  // Rolled from the cut date: the two most recent credit dates (1st / 16th)
  // on or before the cut, each with its earning window as the label.
  const PAY_CYCLES = (() => {
    const out = [];
    const d = new Date(CUT + IST);
    let y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    const MN3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const iso = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
    const push = (yy, mm, credit) => {           // credit day 1 => earned 16-end of previous month; 16 => earned 1-15 of this month
      if (credit === 16) out.push(['1-15 ' + MN3[mm], iso(yy, mm, 16), iso(yy, mm, 17)]);
      else { const pm = (mm + 11) % 12, py = mm === 0 ? yy - 1 : yy; out.push(['16-' + new Date(Date.UTC(py, pm + 1, 0)).getUTCDate() + ' ' + MN3[pm], iso(yy, mm, 1), iso(yy, mm, 2)]); }
    };
    while (out.length < 2) {
      if (day > 16) { push(y, m, 16); day = 16; }
      else if (day > 1) { push(y, m, 1); day = 1; }
      else { m -= 1; if (m < 0) { m = 11; y -= 1; } day = 31; }
    }
    return out.reverse();
  })();
  const cspPay = await cspPayout(PAY_CYCLES);
  era = era.filter(c => startTs(c) < CUT);

  // A reopen is a case WE marked resolved that came back down (reopened_at).
  // source='reopened-cron' is an INTAKE label — Kapture already showed the
  // ticket reopened when the cron pulled it in — and counting it here inflated
  // the rate ~7x. It is reported separately instead.
  const reopTs = c => Number(c.reopened_at) || 0;
  const isReop = c => reopTs(c) > 0;
  // Money actually paid beats money computed: the Hub amount wins wherever
  // there is one, then the tracker's pro-rata, then the Finance sheet.
  const amtOf = c => (hubPaid(c) && hubOf(c).amt)
    ? hubOf(c).amt
    : ((c.refund_amount !== '' && c.refund_amount != null && !isNaN(Number(c.refund_amount)))
      ? Number(c.refund_amount)
      : (sheetEntry(c) ? Number(sheetEntry(c).a) || 0 : 0));
  // Wiom Hub is the source of truth for a refund (Shariq, 22 Sep): it is where
  // the payment is raised, approved and sent, and the sync marks a case
  // Refund Done as soon as the Hub approves it. The Finance sheet and the
  // tracker's own fields are the FALLBACK, for refunds the Hub never saw. Any
  // of them makes a case refunded; the reconciliation section below counts
  // each refund against its best source so the fallback's size is visible.
  const isDone = c => !!sheetEntry(c) || trim(c.cx_action) === 'Refund Done' || trim(c.refund_action) === 'Refund Done' || hubPaid(c);
  const cameInAsReopen = c => ['reopened-cron', 'reopened-log-cron', 'csp-resolved-cron'].includes(String(c.source));
  const RES_REMARKS = ['resolved by old partner', 'resolved by old csp'];
  const isResRemark = c => RES_REMARKS.includes(trim(c.remarks).toLowerCase()) || trim(c.migration_date) !== '';
  const stats = list => {
    const matured = list;               // the cohort is already matured-only
    const m = matured.length;
    // "Resolved" the way the tracker's Weekly Review reads it: the case is not
    // Unresolved now, whenever it was closed. The 48-hour question is the row
    // below it, not this one.
    const res = matured.filter(c => getStatus(c) !== 'Unresolved').length;              // gross
    // Per Shariq (28 Sep): every resolution number in this doc is NET of
    // reopened. A case we closed that the customer had to raise again was not
    // resolved, whatever the ticket says, so it comes straight back out.
    const resNet = matured.filter(c => getStatus(c) !== 'Unresolved' && !reopenedAfter(c)).length;
    // NET of reopened: resolutions later reopened don't count
    const w48 = matured.filter(c => resolvedWithin48(c) === true && !reopenedAfter(c)).length;
    const w48g = matured.filter(c => resolvedWithin48(c) === true).length; // gross
    const unresM = matured.filter(c => getStatus(c) === 'Unresolved').length;
    const late = matured.filter(c => getStatus(c) !== 'Unresolved' && resolvedWithin48(c) !== true).length;
    const resolvedAll = list.filter(c => getStatus(c) !== 'Unresolved').length;
    const pend = matured.filter(c => getStatus(c) === 'Unresolved' && !isDone(c));
    const pendAmt = pend.reduce((a, c) => a + (Number(c.refund_amount) || 0), 0);
    const done = list.filter(isDone);
    const doneAmt = done.reduce((a, c) => a + amtOf(c), 0);
    // Breached-scoped refund done — THE refund-done metric everywhere (matches
    // the funnel's Refund stage); doneN/doneAmt keep the all-in count for notes.
    const doneBrL = matured.filter(c => getStatus(c) === 'Unresolved' && isDone(c));
    const doneBrAmt = doneBrL.reduce((a, c) => a + amtOf(c), 0);
    // Refund-eligible = breached AND the router never pinged again.
    const eligL = matured.filter(c => getStatus(c) === 'Unresolved' && !pingedAfter(c));
    const paidL = done.filter(c => amtOf(c) > 0);
    const paidAmt = paidL.reduce((a, c) => a + amtOf(c), 0);
    const eligPaidL = eligL.filter(isDone);
    const eligPaidAmt = eligPaidL.reduce((a, c) => a + amtOf(c), 0);
    const cspSet = new Set(matured.filter(c => getStatus(c) === 'Unresolved').map(c => trim(c.partner) || '(unknown)'));
    const recPaidL = matured.filter(c => getStatus(c) === 'Unresolved' && pingedAfter(c) && isDone(c));
    const recPaidAmt = recPaidL.reduce((a, c) => a + amtOf(c), 0);
    return { n: list.length, m, res, resNet, w48, w48g, unresM, late, resolvedAll, pendN: pend.length, pendAmt, doneN: done.length, doneAmt, doneBr: doneBrL.length, doneBrAmt,
      elig: eligL.length, cameBack: unresM - eligL.length, paidN: paidL.length, paidAmt, csps: cspSet.size,
      eligPaidN: eligPaidL.length, eligPaidAmt, recPaidN: recPaidL.length, recPaidAmt };
  };
  // ── Funnel extras (till date) ─────────────────────────────────────────────
  const countBy = (list, keyFn) => {
    const map = {};
    list.forEach(c => { const k = keyFn(c) || '(no remark yet)'; map[k] = (map[k] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  };
  const maturedTD = era.filter(c => { const m = maturedAt(c); return m > 0 && m < CUT; });   // same cohort as the week table's since-launch column
  const breached = maturedTD.filter(c => getStatus(c) === 'Unresolved');
  const unresReasons = countBy(breached, c => trim(c.remarks));
  const breachedDone = breached.filter(isDone);
  const breachedDoneAmt = breachedDone.reduce((a, c) => a + amtOf(c), 0);
  const breachedPend = breached.filter(c => !isDone(c));
  const breachedPendAmt = breachedPend.reduce((a, c) => a + (Number(c.refund_amount) || 0), 0);
  const closure = countBy(breached, c => trim(c.kapture_status) || 'Not yet synced');
  // Ageing of the unresolved bucket — time slots since the case was added
  const AGE_SLOTS = [
    ['2 – 4 days', 2, 4], ['4 – 7 days', 4, 7], ['7 – 14 days', 7, 14], ['14 – 21 days', 14, 21], ['21+ days', 21, Infinity],
  ];
  const ageing = AGE_SLOTS.map(([label, lo, hi]) => [label, breached.filter(c => {
    const d = (NOW - startTs(c)) / 86400000; return d >= lo && d < hi;
  }).length]).filter(([, n]) => n > 0);
  // Reopened % week-on-week: every Mon-anchored week since launch; reopens
  // counted among that week's gross ≤48h resolutions (cohort by added date).
  const launchIst = new Date(LAUNCH + IST);
  const launchMon = Date.UTC(launchIst.getUTCFullYear(), launchIst.getUTCMonth(), launchIst.getUTCDate() - ((launchIst.getUTCDay() + 6) % 7)) - IST;
  const wowWeeks = [];
  for (let f = launchMon; f < NOW; f += 7 * 86400000) wowWeeks.push({ from: Math.max(f, LAUNCH), to: f + 7 * 86400000 });
  const reopWow = wowWeeks.map(w => {
    const cohort = era.filter(c => { const t = startTs(c); return t >= w.from && t < w.to; });
    const mat = cohort.filter(c => (NOW - startTs(c)) >= LIM);
    const g = mat.filter(c => resolvedWithin48(c) === true).length;
    const rp = mat.filter(c => resolvedWithin48(c) === true && isReop(c)).length;
    return { label: fmtD(w.from) + ' – ' + fmtD(w.to - 1) + (cohort.length > mat.length ? '*' : ''), g, rp, m: mat.length };
  });
  const reopWowHtml = `<section>
<h2>Reopened % — week on week</h2>
<p class="sub">Reopens counted among each week's gross ≤48-hr resolutions (cohort by the week the case was added). * = current week, cohort not fully matured.</p>
<div class="tablewrap"><table>
<thead><tr><th>Metric</th>${reopWow.map(w => `<th>${w.label}</th>`).join('')}</tr></thead>
<tbody>
<tr><td>Resolved ≤ 48 hrs (gross)</td>${reopWow.map(w => `<td>${w.g || '-'}</td>`).join('')}</tr>
<tr><td>Reopened among those</td>${reopWow.map(w => `<td${w.rp ? ' class="b"' : ''}>${w.rp || '-'}</td>`).join('')}</tr>
<tr><td><b>Reopened %</b></td>${reopWow.map(w => `<td class="b"><b>${pct(w.rp, w.g)}</b></td>`).join('')}</tr>
<tr><td>Net resolution %</td>${reopWow.map(w => `<td class="g">${pct(w.g - w.rp, w.m)}</td>`).join('')}</tr>
</tbody></table></div>
</section>`;
  // Reopened funnel: all era reopens, reasons, and re-resolution confirmed by PFT
  // Three legitimate reopen counts exist and they must be shown together, or
  // the page contradicts the tracker. The dashboard's "Reopened < 24 Hrs" card
  // counts every case ever stamped; this doc is scoped to the 48-hr flag era;
  // and only a subset of era reopens were within-48hr resolutions, which is
  // the number the funnel's "net of reopened" arithmetic uses.
  const reopensAllTime = Object.entries(casesRaw).filter(([k]) => !k.startsWith('__'))
    .map(([, c]) => c).filter(c => c && c.ticket_no && isReop(c)).length;
  const reopens = era.filter(isReop);
  const reopReasons = countBy(reopens, c => trim(c.remarks));
  const reopPftDone = reopens.filter(c => trim(c.kapture_status) === 'Completed').length;
  const reopStillOpen = reopens.filter(c => trim(c.kapture_status) !== 'Completed' && trim(c.kapture_status) !== 'Closed').length;
  const resolvedAllTD = era.filter(c => getStatus(c) !== 'Unresolved').length;

  // ── Reopened cases — RCA: render the field team's RCA sheet AS-IS ─────────
  // (per Shariq 26 Aug: the RCA table is exactly the sheet's cases, nothing
  // tracker-derived). Sheet failure must never kill the recap.
  const escH = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let rcaLedger = '';
  try {
    const csv = await fetch(RCA_SHEET_CSV, { redirect: 'follow' }).then(r => r.text());
    const sh = parseCSVText(csv);
    const SH = sh[0].map(h => h.trim().toLowerCase());
    const col = name => SH.findIndex(h => h === name);
    const iT = col('ticket no'), iM = col('mobile'), iC = col('csp'), iCx = col('cx remarks'),
          iCsp = col('csp remarks'), iPing = col('last ping time'), iG = col('ground remarks'), iSt = col('status');
    const rows = sh.slice(1).filter(r => trim(r[iT]));
    const stCell = r => { const v = iSt >= 0 ? trim(r[iSt]) : ''; return `<td class="${!v ? '' : /unresolved/i.test(v) ? 'b' : 'g'}">${escH(v) || '—'}</td>`; };
    const ledgerRows = rows.map(r =>
      `<tr><td>${escH(trim(r[iT]))}</td><td>${escH(trim(r[iM]))}</td><td>${escH(trim(r[iC]))}</td><td style="white-space:normal">${escH(trim(r[iCx]) || '—')}</td><td style="white-space:normal">${escH(trim(r[iCsp]) || '—')}</td><td style="white-space:normal">${escH(trim(r[iG]) || '—')}</td><td>${escH(trim(r[iPing]) || '—')}</td>${stCell(r)}</tr>`
    ).join('\n');
    // Bucketize the RCA: counts + % by CX-remark bucket, CSP-side sub-buckets
    const bucketOf = (list, idx, blankLabel) => {
      const m = {};
      list.forEach(r => { const k = trim(r[idx]) || blankLabel; m[k] = (m[k] || 0) + 1; });
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    const cxBuckets = bucketOf(rows, iCx, '(CX remark not filled)');
    const cspBuckets = bucketOf(rows.filter(r => trim(r[iCsp])), iCsp, '');
    const bucketRows =
      cxBuckets.map(([k, n]) => `<tr><td style="white-space:normal">${escH(k)}</td><td>${n}</td><td>${pct(n, rows.length)}</td><td style="text-align:left">Customer-side read</td></tr>`).join('\n') +
      (cspBuckets.length ? '\n<tr><td><i>CSP-side reasons (where filled)</i></td><td></td><td></td><td style="text-align:left"></td></tr>\n' +
        cspBuckets.map(([k, n]) => `<tr><td style="padding-left:34px;white-space:normal">↳ ${escH(k)}</td><td>${n}</td><td>${pct(n, rows.length)}</td><td style="text-align:left"></td></tr>`).join('\n') : '');
    rcaLedger = `<section>
<h2>Reopened cases — RCA (${rows.length} cases)</h2>
<p class="sub">The field team's reopen RCA, straight from the <a href="https://docs.google.com/spreadsheets/d/1cXCnazjjLfzxG4-Uyr9nrGGo4qgGbbQ-zjFZ6xG_9vk/edit?gid=0" style="color:var(--accent-ink)">Reopen RCA sheet</a> — refreshed automatically every Monday.</p>
<div class="tablewrap" style="margin-bottom:14px"><table>
<thead><tr><th>RCA bucket</th><th>Cases</th><th>%</th><th style="text-align:left">Side</th></tr></thead>
<tbody>
<tr><td><b>Total reopened cases in RCA</b></td><td><b>${rows.length}</b></td><td><b>100%</b></td><td style="text-align:left"></td></tr>
${bucketRows}
</tbody></table></div>
<div class="tablewrap" style="max-height:480px;overflow:auto"><table style="min-width:900px">
<thead><tr><th>Ticket No</th><th>Mobile</th><th>CSP</th><th style="text-align:left">CX Remarks</th><th style="text-align:left">CSP Remarks</th><th style="text-align:left">Ground Remarks</th><th>Last Ping Time</th><th>Status</th></tr></thead>
<tbody>
${ledgerRows}
</tbody></table></div>
</section>`;
  } catch (e) {
    console.error('RCA sheet render failed (non-fatal):', e.message);
    rcaLedger = '';
  }

  // ── CSP breach & resolution status: top 10 by breached, worst rate first,
  // with the ground team's RCA from the "CSP RCA" tab of the same sheet
  // (columns: CSP | Pending Reason | Current Status). Tab missing → columns
  // render empty with a hint, the section itself always builds from Firebase.
  const inRange = (r) => era.filter(c => { const m = maturedAt(c); return m > 0 && m >= r.from && m < r.to; });
  // Reopens are an EVENT: counted in the week they came back, against the
  // resolutions marked in that same week.
  function reopStats(r) {
    const back = era.filter(c => { const t = reopTs(c); return t >= r.from && t < r.to; });
    const resMarked = era.filter(c => { const t = Number(c.remarks_updated_at) || 0; return t >= r.from && t < r.to && isResRemark(c); });
    const intake = era.filter(c => { const t = startTs(c); return t >= r.from && t < r.to && cameInAsReopen(c); });
    return { reopWeek: back.length, resWeek: resMarked.length, intake: intake.length };
  }
  // Per Shariq (28 Sep): the three rows must add up on the page. Net resolved
  // IS Resolved minus the Reopened row - the reopens that came back down in
  // that week - and nothing subtler. The same rule feeds the headline, tiles,
  // banner, Slack line and the city cut, so every net figure on the doc is the
  // arithmetic a reader can check from the table.
  const S = periods.map(pp => {
    const x = Object.assign(stats(inRange(pp)), reopStats(pp));
    x.resNet = x.w48g;   // resolved inside 48 hrs and still resolved: a case that came back down and stayed down is already not counted
    return x;
  });

  // "Last week" is the week that just ended for the review — the current
  // slice up to yesterday (index 3), not the last fully-closed calendar slice.
  const LW = LASTCOL - 1;   // Week 1, the week just reviewed
  const sWB = S[LW - 1];     // the week before it
  const sLW = S[LW];         // last week
  // ── Resolution status by city: Delhi/NCR, Mumbai, Bharat (UP cities) ──
  const CITIES = ['Delhi/NCR', 'Mumbai', 'Bharat'];
  const cityOf = c => (cspCity && cspCity[normName(c.partner)]) || '';
  const cityStats = (pp) => {
    const all = inRange(pp);
    const by = {};
    const reopIn = f => era.filter(c => { const t = reopTs(c); return t >= pp.from && t < pp.to && f(c); }).length;
    const net = (x, f) => { x.resNet = x.w48g; return x; };
    CITIES.forEach(k => { by[k] = net(stats(all.filter(c => cityOf(c) === k)), c => cityOf(c) === k); });
    by.unmapped = net(stats(all.filter(c => !cityOf(c))), c => !cityOf(c));
    by.all = net(stats(all), () => true);
    return by;
  };
  const cityByP = periods.map(pp => cityStats(pp));
  const cityCols = periods.map(pp => `<th>${pp.key}<br><span style="font-weight:400;font-size:12px">(${pp.label})</span></th>`).join('');
  const cityCell = (v, m, cls) => `<td${cls ? ` class="${cls}"` : ''}>${v.toLocaleString('en-IN')} (${pct(v, m)})</td>`;
  const cityGroup = (label, key) => `<tr><td style="text-align:left" colspan="${periods.length + 1}"><b>${label}</b></td></tr>
<tr><td style="text-align:left;padding-left:20px">Cases matured</td>${cityByP.map(by => `<td>${by[key].m.toLocaleString('en-IN')}</td>`).join('')}</tr>
<tr><td style="text-align:left;padding-left:20px">Resolved</td>${cityByP.map(by => cityCell(by[key].res, by[key].m, '')).join('')}</tr>
<tr><td style="text-align:left;padding-left:20px"><b>Net resolved</b></td>${cityByP.map(by => cityCell(by[key].resNet, by[key].m, 'g')).join('')}</tr>
<tr><td style="text-align:left;padding-left:20px">Unresolved</td>${cityByP.map(by => cityCell(by[key].unresM, by[key].m, 'b')).join('')}</tr>`;
  const cityHtml = cspCity ? `<section>
<h2>Resolution status, city-wise</h2>
<p class="sub">The same matured-case arithmetic as the week-wise table, cut by the CSP's city from the partner hierarchy. Delhi/NCR includes Ghaziabad, Noida, Faridabad and Gurgaon; Bharat is every UP city (Meerut, Agra, Bareilly, Lucknow, Prayagraj, Gorakhpur). Net resolved is the cases resolved inside the 48 hrs and still resolved, exactly as in the week-wise table.</p>
<div class="tablewrap"><table>
<thead><tr><th style="text-align:left">City</th>${cityCols}</tr></thead>
<tbody>
${CITIES.map(k => cityGroup(k === 'Bharat' ? 'Bharat (UP cities)' : k, k)).join('\n')}
${cityGroup('All', 'all')}
</tbody></table></div>
${cityByP.some(by => by.unmapped.m) ? `<p class="sub" style="margin-top:8px">All is every matured case, the same as the week-wise table. ${periods.map((pp, i) => cityByP[i].unmapped.m ? `${pp.key}: ${cityByP[i].unmapped.m}` : '').filter(Boolean).join(' · ')} of those belong to CSPs not yet in the partner hierarchy, so they are in All but in no city row.</p>` : ''}
</section>` : `<section><h2>Resolution status, city-wise</h2><p class="sub">The partner hierarchy did not return this run, so the city cut is not available.</p></section>`;
  const sTD = S[LASTCOL];    // since launch

  const wowRes = (sLW.m && sWB.m) ? (sLW.resNet / sLW.m - sWB.resNet / sWB.m) * 100 : 0;
  // The tracker's tab compares against the previous TWO weeks pooled, so the
  // doc states that figure too rather than quietly disagreeing with the tab.
  const pooledPrev = [S[LW - 2], S[LW - 1]].filter(Boolean);
  const pooledM = pooledPrev.reduce((a, x) => a + x.m, 0);
  const pooledR = pooledPrev.reduce((a, x) => a + x.resNet, 0);
  const wowPooled = (pooledM && sLW.m) ? (sLW.resNet / sLW.m - pooledR / pooledM) * 100 : 0;
  const addedTD = era.length;
  const addedLW = era.filter(c => { const t = startTs(c); return t >= periods[LW].from && t < periods[LW].to; }).length;
  const avgPerDay = Math.round(addedTD / Math.max(1, Math.ceil((NOW - LAUNCH) / 86400000)));
  const wbLabel = periods[LW - 1].key + ' (' + periods[LW - 1].label + ')';
  const lwLabel = periods[LW].key + ' (' + periods[LW].label + ')';
  const tdLabel = '29 Jul – ' + cutLabel;

  const NL = String.fromCharCode(10);
  // ── Refund cases funnel ───────────────────────────────────────────────────
  // Descends from the week-wise table's own since-launch column, so every line
  // here ties to a line there: received -> matured -> unresolved -> eligible,
  // then the eligible cases split by the tracker's Refund Action status. Each
  // case lands in exactly one bucket, so the buckets sum back to eligible.
  const escR = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // ── CSPs that were resolving and have stopped ──────────────────────────
  // Same matured-case arithmetic as the week-wise table, per CSP. "Earlier"
  // is launch up to the end of Week 3; "recent" is the last two weeks. A CSP
  // qualifies when it had a real track record (5+ matured cases, 70%+
  // resolved) and its recent rate has fallen by 20 pp or more on 3+ cases.
  // Ranked by the size of the drop, then by how many customers are down.
  const stoppedHtml = (() => {
    const recFrom = periods[LASTCOL - 2].from, recTo = periods[LASTCOL - 1].to;
    const byCsp = {};
    era.forEach(c => {
      const m = maturedAt(c); if (!(m > 0 && m < CUT)) return;
      const name = trim(c.partner) || '(unknown)';
      const k = normName(name); if (!k) return;
      const e = byCsp[k] || (byCsp[k] = { name, early: { n: 0, r: 0 }, rec: { n: 0, r: 0, down: [] } });
      const res = getStatus(c) !== 'Unresolved';
      if (m >= recFrom && m < recTo) { e.rec.n++; if (res) e.rec.r++; else e.rec.down.push(c); }
      else if (m < recFrom) { e.early.n++; if (res) e.early.r++; }
    });
    const rows = Object.values(byCsp).map(e => {
      const eR = e.early.n ? e.early.r / e.early.n * 100 : 0;
      const rR = e.rec.n ? e.rec.r / e.rec.n * 100 : 0;
      return Object.assign(e, { eR, rR, drop: eR - rR });
    }).filter(e => e.early.n >= 5 && e.eR >= 70 && e.rec.n >= 3 && e.drop >= 20)
      .sort((a, b) => b.drop - a.drop || b.rec.down.length - a.rec.down.length)
      .slice(0, 10);
    const T = rows.reduce((a, e) => ({ en: a.en + e.early.n, er: a.er + e.early.r, rn: a.rn + e.rec.n, rr: a.rr + e.rec.r, down: a.down + e.rec.down.length }), { en: 0, er: 0, rn: 0, rr: 0, down: 0 });
    const estate = era.filter(c => { const m = maturedAt(c); return m >= recFrom && m < recTo; });
    const estRes = estate.filter(c => getStatus(c) !== 'Unresolved').length;
    const estDown = estate.length - estRes;
    const restN = estate.length - T.rn, restR = estRes - T.rr;
    const ageD = c => Math.floor((NOW - startTs(c)) / 86400000);
    const tk = c => `<a href="https://wiomin.kapturecrm.com/nui/tickets/all/5/-1/0/detail/957486452/${escR(trim(c.ticket_no))}?query=${escR(trim(c.ticket_no))}" target="_blank" rel="noopener">${escR(trim(c.ticket_no))}</a> <span style="color:var(--muted)">${ageD(c)}d</span>`;
    const earlyLabel = fmtD(LAUNCH) + ' \u2013 ' + fmtD(recFrom - 1), recLabel = fmtD(recFrom) + ' \u2013 ' + fmtD(recTo - 1);
    const body = rows.length ? rows.map((e, i) => `<tr>` +
      `<td>${i + 1}</td>` +
      `<td style="text-align:left;white-space:normal"><b>${escR(e.name)}</b></td>` +
      `<td style="text-align:left;font-weight:400">${escR(cityOf({ partner: e.name }) || '\u2014')}</td>` +
      `<td>${e.early.n}</td><td class="g">${e.early.r} (${pct(e.early.r, e.early.n)})</td>` +
      `<td>${e.rec.n}</td><td class="b">${e.rec.r} (${pct(e.rec.r, e.rec.n)})</td>` +
      `<td class="b"><b>\u2212${e.drop.toFixed(1)} pp</b></td>` +
      `<td class="b"><b>${e.rec.down.length}</b></td>` +
      `<td style="text-align:left;font-weight:400;white-space:normal;font-size:12.5px">${e.rec.down.sort((a, b) => startTs(a) - startTs(b)).map(tk).join(', ')}</td>` +
      `</tr>`).join('\n') :
      `<tr><td colspan="10" style="text-align:left;font-weight:400">No CSP with a 70%+ track record on 5+ cases has dropped 20 pp or more on 3+ cases in ${recLabel}.</td></tr>`;
    return `<section>
<h2>CSPs that were resolving and have stopped \u2014 top ${rows.length || 10}</h2>
<p class="sub">Each CSP's resolved rate on the cases that matured up to ${fmtD(recFrom - 1)} against the last two weeks (${recLabel}), overall resolution as in the Resolved row. Listed when the CSP had a real track record \u2014 5 or more matured cases, 70% or more resolved \u2014 and the recent rate has fallen by 20 pp or more on 3 or more cases. Ranked by the size of the drop, then by customers still down. The still-down tickets are the ones to raise with the CSP.</p>
<div class="tablewrap"><table style="min-width:1000px">
<thead><tr><th>#</th><th style="text-align:left">CSP</th><th style="text-align:left">City</th><th>Cases<br><span style="font-weight:400;font-size:12px">${earlyLabel}</span></th><th>Resolved<br><span style="font-weight:400;font-size:12px">earlier</span></th><th>Cases<br><span style="font-weight:400;font-size:12px">${recLabel}</span></th><th>Resolved<br><span style="font-weight:400;font-size:12px">recent</span></th><th>Drop</th><th>Still down</th><th style="text-align:left">Still-down tickets</th></tr></thead>
<tbody>
${body}
${rows.length ? `<tr class="tot"><td class="tot"></td><td class="tot" style="text-align:left"><b>These ${rows.length} together</b></td><td class="tot"></td><td class="tot"><b>${T.en}</b></td><td class="tot"><b>${T.er} (${pct(T.er, T.en)})</b></td><td class="tot"><b>${T.rn}</b></td><td class="tot"><b>${T.rr} (${pct(T.rr, T.rn)})</b></td><td class="tot"><b>−${(T.er / T.en * 100 - T.rr / T.rn * 100).toFixed(1)} pp</b></td><td class="tot"><b>${T.down}</b></td><td class="tot" style="text-align:left;font-weight:400">${pct(T.down, estDown)} of the ${estDown} customers still down from ${recLabel}</td></tr>` : ''}
</tbody></table></div>
${rows.length ? `<p class="sub" style="margin-top:10px"><b>Overall impact.</b> In ${recLabel} the estate resolved <b>${estRes} of ${estate.length} (${pct(estRes, estate.length)})</b>. These ${rows.length} CSPs account for ${T.rn} of those cases and <b>${T.down} of the ${estDown} customers still down (${pct(T.down, estDown)})</b>. Without them the rest of the estate resolved ${restR} of ${restN} (${pct(restR, restN)}); had they kept their earlier rate of ${pct(T.er, T.en)}, roughly <b>${Math.max(0, Math.round(T.rn * T.er / T.en) - T.rr)} more customers</b> would be up and the estate would read about <b>${pct(estRes + Math.max(0, Math.round(T.rn * T.er / T.en) - T.rr), estate.length)}</b> instead of ${pct(estRes, estate.length)}.</p>` : ''}
</section>`;
  })();
  const maturedAll = maturedTD;
  const unresAll = maturedAll.filter(c => getStatus(c) === 'Unresolved');
  const pingedBack = unresAll.filter(c => pingedAfter(c));
  const eligAll = unresAll.filter(c => !pingedAfter(c));
  const amtRA = amtOf;
  // Inside the eligible set, split on the only question that matters first —
  // was the customer paid? Then break the unpaid ones down by what is blocking
  // them. Refunded + not refunded = eligible, exactly.
  const eligPaid = eligAll.filter(isDone);
  const eligUnpaid = eligAll.filter(c => !isDone(c));
  const raEffective = c => {
    const manual = trim(c.refund_action);
    if (manual && manual !== 'Refund Done') return manual;
    if (c.refund_amount !== '' && c.refund_amount != null && Number(c.refund_amount) === 0) return 'Amount 0 \u2014 refund not possible';
    return 'Refund Pending';
  };
  const NOTHING = ['Amount 0 \u2014 refund not possible', 'Amount <10 \u2014 refund not possible', 'Duplicate ticket',
    'Refund not demanded by Cx', 'Refund not required', 'EXIT partner \u2014 refund by Kapil',
    'CSP resolved \u2014 removed from PFT list', 'Ping up'];
  // A case with a reason recorded against it is not "refund pending" - the
  // desk has looked at it and parked it. Only cases with no reason are a
  // genuine backlog, so they get their own bucket rather than being folded in
  // and inflating the number.
  const BLOCKED = ['Cx DNP 3', 'Pickup ticket not created by Cx', 'PFT process miss', '120 hr not crossed'];
  const grp = {
    'Nothing payable': { n: 0, amt: 0, sub: {} },
    'Parked with a reason recorded': { n: 0, amt: 0, sub: {} },
    'Refund pending \u2014 no reason recorded': { n: 0, amt: 0, sub: {} },
  };
  eligUnpaid.forEach(c => {
    const k = raEffective(c);
    const g = NOTHING.includes(k) ? 'Nothing payable'
      : BLOCKED.includes(k) ? 'Parked with a reason recorded'
      : 'Refund pending \u2014 no reason recorded';
    const e = grp[g];
    e.n++; e.amt += amtRA(c);
    const t = e.sub[k] || (e.sub[k] = { n: 0, amt: 0 });
    t.n++; t.amt += amtRA(c);
  });
  const E = eligAll.length;
  // "120 hr not crossed" is the refund desk's own waiting period, not the 48-hr
  // one, so it can legitimately sit inside a matured-cases funnel. It is only
  // valid while the case really is under 120 hrs, so count the ones that have
  // since aged past it and say so on the row.
  const hrsOld = c => (NOW - clockTs(c)) / 3600000;
  const stale120 = eligUnpaid.filter(c => trim(c.refund_action) === '120 hr not crossed' && hrsOld(c) > 120);
  const oldest120 = stale120.length ? Math.round(Math.max(...stale120.map(hrsOld))) : 0;
  const subNote = k => {
    if (k !== '120 hr not crossed') return '';
    const n = eligUnpaid.filter(c => trim(c.refund_action) === '120 hr not crossed').length;
    if (!stale120.length) return 'The desk waits 120 hrs before paying, and these are still inside that window';
    return `<b>Flag is stale</b> \u2014 ${stale120.length} of ${n} are now past 120 hrs (oldest ${oldest120} hrs). The 120-hr wait is a separate clock from the 48-hr promise, but these have long since crossed it`;
  };
  // Where the rest of the refunds went. These three add back to the week-wise
  // table's "Customers refunded", so the two tables reconcile on the page.
  const isDoneAll = maturedAll.filter(isDone);
  const donePinged = isDoneAll.filter(c => getStatus(c) === 'Unresolved' && pingedAfter(c));
  const doneResolved = isDoneAll.filter(c => getStatus(c) !== 'Unresolved');
  const sumA = list => list.reduce((a, c) => a + amtRA(c), 0);
  const stage = (label, n, base, note, cls) =>
    `<tr><td class="${cls || ''}"><b>${label}</b></td><td class="${cls || ''}"><b>${n.toLocaleString('en-IN')}</b></td><td class="${cls || ''}">${base ? pct(n, base) : '100%'}</td><td></td><td style="text-align:left;font-weight:400">${note}</td></tr>`;
  // ── CSPs that were resolving and have stopped ───────────────────────────
  // Not the worst CSPs by volume - the ones whose own record has turned. A CSP
  // that never resolved is a known quantity; a CSP that resolved all summer and
  // stopped this week is a new fault, and it is the one the meeting can still
  // fix by asking what changed. Bar: at least 5 matured cases before the review
  // week at 75% or better, then at least 2 this week at 50% or worse.
  // The week under review, in milliseconds - used here and by the reopen and
  // refund blocks further down.
  const lwFrom = periods[LASTCOL - 1].from, lwTo = periods[LASTCOL - 1].to;
  const partnerOf = c => trim(c.partner) || '(unknown)';
  const isResolvedNow = c => getStatus(c) !== 'Unresolved';
  const ageD = c => Math.round((NOW - clockTs(c)) / 86400000);
  // A CSP with two cases and one pending is not a CSP that has stopped working
  // - at that volume it is the coin landing tails (Shariq, 28 Sep). So instead
  // of a flat threshold, ask the only question worth asking: if this CSP were
  // still working at its own historical rate, how likely is a week this bad?
  // binomTail gives that probability; anything a quiet week could produce by
  // chance (p >= 0.05) is not listed at all.
  //
  // Worked: 1 of 2 against a 90% record is a 1-in-5 fluke - not listed.
  //         1 of 5 against the same record is 1-in-2,000 - listed.
  const binomAtMost = (k, n, p) => {
    const q = Math.min(0.99, Math.max(0.01, p));
    let term = Math.pow(1 - q, n), acc = 0;
    for (let i = 0; i <= k; i++) {
      if (i > 0) term *= ((n - i + 1) / i) * (q / (1 - q));
      acc += term;
    }
    return Math.min(1, acc);
  };
  const binomAtLeast = (k, n, p) => 1 - (k > 0 ? binomAtMost(k - 1, n, p) : 0);
  const odds = pv => (pv <= 0 ? 'certain' : '1 in ' + Math.round(1 / pv).toLocaleString('en-IN'));
  const STOP_MIN_BEFORE = 8;      // enough history to have a rate worth testing
  const STOP_MIN_NOW = 3;         // enough cases this week to judge
  const STOP_MIN_DOWN = 2;        // and at least two customers actually waiting
  const STOP_P = 0.05;
  // What is being done about them - agreed in the meeting, not a tracker field.
  const STOP_ACTION = 'With transition team';
  const tally = (list) => {
    const m = {};
    list.forEach(c => {
      const k = partnerOf(c);
      const e = m[k] || (m[k] = { n: 0, r: 0, open: [] });
      e.n++; if (isResolvedNow(c)) e.r++; else e.open.push(c);
    });
    return m;
  };
  const beforeG = tally(maturedAll.filter(c => maturedAt(c) < lwFrom));
  const weekG = tally(maturedAll.filter(c => maturedAt(c) >= lwFrom && maturedAt(c) < lwTo));
  const stopped = Object.keys(weekG)
    .filter(k => beforeG[k] && beforeG[k].n >= STOP_MIN_BEFORE && weekG[k].n >= STOP_MIN_NOW)
    .map(k => ({ k, b: beforeG[k], w: weekG[k], rb: beforeG[k].r / beforeG[k].n, rw: weekG[k].r / weekG[k].n }))
    .map(x => Object.assign(x, { pv: binomAtMost(x.w.r, x.w.n, x.rb) }))
    .filter(x => x.rw < x.rb && x.w.open.length >= STOP_MIN_DOWN && x.pv < STOP_P)
    .sort((a, b) => a.pv - b.pv || b.w.open.length - a.w.open.length);
  const stopOpen = stopped.reduce((a, x) => a + x.w.open.length, 0);
  const stopTix = list => list.sort((x, y) => ageD(y) - ageD(x))
    .map(c => `<a href="https://wiomin.kapturecrm.com/nui/tickets/all/5/-1/0/detail/957486452/${escR(trim(c.ticket_no))}?query=${escR(trim(c.ticket_no))}" target="_blank" rel="noopener">${escR(trim(c.ticket_no))}</a> <span style="color:var(--muted)">${ageD(c)}d</span>`).join(', ');
  const stopRows = stopped.map(x => {
    const nk = normName(x.k);
    const prof = cspProf && cspProf[nk];
    const calls = ptl && ptl[nk] ? ptl[nk][LASTCOL] : null;
    const stx = ptlSt && ptlSt[nk];
    const reasons = {};
    x.w.open.forEach(c => { const r = trim(c.remarks) || '(no remark yet)'; reasons[r] = (reasons[r] || 0) + 1; });
    const reasonTxt = Object.entries(reasons).sort((a, b) => b[1] - a[1])
      .map(([r, n]) => escR(r) + (Object.keys(reasons).length > 1 ? ` <span style="color:var(--muted)">(${n})</span>` : '')).join('<br>');
    return `<tr><td style="text-align:left;white-space:normal"><b>${escR(x.k)}</b></td>` +
      `<td>${prof ? prof.paying.toLocaleString('en-IN') : '\u2014'}</td>` +
      `<td>${prof ? (prof.mg ? '<span class="pillmg">Enrolled</span>' : '<span style="color:var(--muted)">Not enrolled</span>') : '\u2014'}</td>` +
      `<td class="g">${x.b.r} / ${x.b.n} <span style="color:var(--muted)">(${(x.rb * 100).toFixed(0)}%)</span></td>` +
      `<td class="b">${x.w.r} / ${x.w.n} <span style="color:var(--muted)">(${(x.rw * 100).toFixed(0)}%)</span></td>` +
      `<td class="b"><b>\u2212${((x.rb - x.rw) * 100).toFixed(0)} pp</b></td>` +
      `<td>${odds(x.pv)}</td>` +
      `<td style="text-align:left;white-space:normal;font-weight:400">${reasonTxt || '<span style="color:var(--muted)">\u2014</span>'}</td>` +
      `<td>${calls == null ? '\u2014' : calls}</td>` +
      `<td>${stx ? `<span class="${stx.open ? 'b' : ''}">${stx.open}</span> / ${stx.closed}` : '\u2014'}</td>` +
      `<td class="${cspPay && cspPay[nk] && !cspPay[nk].cyc[0] ? 'b' : ''}">${inr(cspPay && cspPay[nk] ? cspPay[nk].cyc[0] : 0)}</td>` +
      `<td class="${cspPay && cspPay[nk] && !cspPay[nk].cyc[1] ? 'b' : ''}">${inr(cspPay && cspPay[nk] ? cspPay[nk].cyc[1] : 0)}</td>` +
      `<td style="white-space:nowrap">${cspPay && cspPay[nk] ? `${escR(cspPay[nk].lastWhen)} <span style="color:var(--muted)">${inr(cspPay[nk].lastRs)}</span>` : '<span class="pend">\u2014</span>'}</td>` +
      `<td style="text-align:left;white-space:normal;font-weight:400">${STOP_ACTION}</td>` +
      `<td style="text-align:left;white-space:normal;font-weight:400;font-size:12px">${x.w.open.length ? stopTix(x.w.open) : '<span style="color:var(--muted)">\u2014</span>'}</td></tr>`;
  }).join(NL);
  const stopPayUnpaid = stopped.filter(x => { const q = cspPay && cspPay[normName(x.k)]; return !q || (!q.cyc[0] && !q.cyc[1]); }).length;
  const estateCyc = [0, 1].map(i => cspPay ? Object.values(cspPay).filter(v => v.cyc[i] > 0).length : 0);
  const cspBlockHtml = `<section>
<h2>CSP watchlist: who stopped, who came back</h2>
<p class="sub">These are not the biggest failures on the list \u2014 they are the ones whose own record turned, and only where the week is too bad to be luck. One pending ticket out of two proves nothing at that volume, so each CSP here is measured against <b>its own</b> earlier rate: at least ${STOP_MIN_BEFORE} cases before ${fmtD(lwFrom)}, at least ${STOP_MIN_NOW} this week, at least ${STOP_MIN_DOWN} customers still waiting, and a week this bad happening by chance less often than 1 in 20. <b>${stopped.length} CSP${stopped.length === 1 ? '' : 's'}</b> clear that bar, holding <b>${stopOpen} customers still down</b>. A CSP that never resolved is a known quantity; one that resolved all summer and stopped last week is a new fault, and the meeting can still ask what changed. <b>All of them are with the transition team.</b></p>
<div class="tablewrap"><table style="min-width:1280px">
<thead><tr><th style="text-align:left">CSP</th><th>Userbase<br><span style="font-weight:400;opacity:.85">paying</span></th><th>MG<br><span style="font-weight:400;opacity:.85">enrolment</span></th><th>Before ${fmtD(lwFrom)}<br><span style="font-weight:400;opacity:.85">resolved</span></th><th>${periods[LASTCOL - 1].key}<br><span style="font-weight:400;opacity:.85">resolved</span></th><th>Drop</th><th>Chance it is<br><span style="font-weight:400;opacity:.85">a quiet week</span></th><th style="text-align:left">What the ground said on the open ones</th><th>PTL calls</th><th>PTL tickets<br><span style="font-weight:400;opacity:.85">open / closed</span></th><th>Bonus paid<br><span style="font-weight:400;opacity:.85">${PAY_CYCLES[0][0]} cycle</span></th><th>Bonus paid<br><span style="font-weight:400;opacity:.85">${PAY_CYCLES[1][0]} cycle</span></th><th>Last bonus<br><span style="font-weight:400;opacity:.85">paid</span></th><th style="text-align:left">Action</th><th style="text-align:left">Customers still down</th></tr></thead>
<tbody>
${stopped.length ? stopRows : '<tr><td colspan="15" style="text-align:left">No CSP\'s week was bad enough to rule out ordinary variation. Nothing to escalate.</td></tr>'}
${stopped.length ? `<tr class="tot"><td class="tot" style="text-align:left"><b>These ${stopped.length} together</b></td><td class="tot"><b>${stopped.reduce((a, x) => { const q = cspProf && cspProf[normName(x.k)]; return a + (q ? q.paying : 0); }, 0).toLocaleString('en-IN')}</b></td><td class="tot"><b>${stopped.filter(x => { const q = cspProf && cspProf[normName(x.k)]; return q && q.mg; }).length} enrolled</b></td><td class="tot g"><b>${stopped.reduce((a, x) => a + x.b.r, 0)} / ${stopped.reduce((a, x) => a + x.b.n, 0)} (${pct(stopped.reduce((a, x) => a + x.b.r, 0), stopped.reduce((a, x) => a + x.b.n, 0))})</b></td><td class="tot b"><b>${stopped.reduce((a, x) => a + x.w.r, 0)} / ${stopped.reduce((a, x) => a + x.w.n, 0)} (${pct(stopped.reduce((a, x) => a + x.w.r, 0), stopped.reduce((a, x) => a + x.w.n, 0))})</b></td><td class="tot"></td><td class="tot"></td><td class="tot" style="text-align:left"><b>${stopOpen} customers still down</b></td><td class="tot"><b>${stopped.reduce((a, x) => a + ((ptl && ptl[normName(x.k)]) ? ptl[normName(x.k)][LASTCOL] : 0), 0)}</b></td><td class="tot"></td><td class="tot"><b>${inr(stopped.reduce((a, x) => a + ((cspPay && cspPay[normName(x.k)]) ? cspPay[normName(x.k)].cyc[0] : 0), 0))}</b></td><td class="tot"><b>${inr(stopped.reduce((a, x) => a + ((cspPay && cspPay[normName(x.k)]) ? cspPay[normName(x.k)].cyc[1] : 0), 0))}</b></td><td class="tot" style="text-align:left"><b>${STOP_ACTION}</b></td><td class="tot"></td></tr>` : ''}
</tbody></table></div>
<p class="sub" style="margin-top:10px">Bonus paid is what actually reached the CSP's settlement wallet (BONUS_CREDIT on the payment-settlement ledger, current to the hour): the ${PAY_CYCLES[0][0]} cycle is the credit dated ${fmtD(Date.parse(PAY_CYCLES[0][1] + 'T00:00:00+05:30'))}, the ${PAY_CYCLES[1][0]} cycle the credit dated ${fmtD(Date.parse(PAY_CYCLES[1][1] + 'T00:00:00+05:30'))}. The analytics bonus tables stopped feeding in June, so this reads the ledger the money moved through. ${cspPay ? `<b>${stopPayUnpaid} of these ${stopped.length} have had nothing credited in either cycle.</b> Across the estate the ${PAY_CYCLES[1][0]} cycle has credited ${estateCyc[1].toLocaleString('en-IN')} CSPs so far against ${estateCyc[0].toLocaleString('en-IN')} for the cycle before.` : 'Bonus figures are unavailable this run \u2014 the ledger query did not return.'}</p>
</section>`;


  // ── CSPs that were failing and have come back ───────────────────────────
  // The mirror of the table above, and the one the meeting asked for by name:
  // a CSP that was not resolving last week and resolved everything it was
  // handed this week. Judged against LAST WEEK rather than the whole record,
  // because that is the turn being claimed; its longer record sits in its own
  // column so a one-week bounce cannot pass as a fixed CSP. The last column is
  // the honest test - whether it also went back for the customers it had
  // already left down.
  // Same test in the other direction: a CSP that scrapes 2 out of 2 after a bad
  // week has done nothing a coin could not do. To be called revived, the week
  // has to be too good to come from its own earlier rate.
  const REV_MIN_BEFORE = 8;   // a failing RECORD, not one unlucky week
  const REV_WAS = 0.5;        // was resolving half or fewer of them
  const REV_MIN = 3;          // enough cases this week to judge
  const REV_NOW = 0.8;        // and a genuinely clean week
  const REV_P = 0.05;
  const prevWeekG = tally(maturedAll.filter(c => {
    const m = maturedAt(c);
    return m >= periods[LASTCOL - 2].from && m < periods[LASTCOL - 2].to;
  }));
  const oldBreach = {};
  maturedAll.filter(c => maturedAt(c) < lwFrom && resolvedWithin48(c) !== true).forEach(c => {
    const k = partnerOf(c);
    const e = oldBreach[k] || (oldBreach[k] = { b: 0, down: [] });
    e.b++; if (!isResolvedNow(c)) e.down.push(c);
  });
  const revived = Object.keys(weekG)
    .filter(k => beforeG[k] && beforeG[k].n >= REV_MIN_BEFORE && weekG[k].n >= REV_MIN)
    .map(k => ({ k, l: prevWeekG[k] || { n: 0, r: 0 }, w: weekG[k], b: beforeG[k], old: oldBreach[k] || { b: 0, down: [] } }))
    .map(x => Object.assign(x, { pv: binomAtLeast(x.w.r, x.w.n, x.b.r / x.b.n) }))
    .filter(x => x.b.r / x.b.n <= REV_WAS && x.w.r / x.w.n >= REV_NOW && x.pv < REV_P)
    .sort((a, b) => a.pv - b.pv || b.w.n - a.w.n);
  const revCases = revived.reduce((a, x) => a + x.w.n, 0);
  const revRes = revived.reduce((a, x) => a + x.w.r, 0);
  const revOldDown = revived.reduce((a, x) => a + x.old.down.length, 0);
  const revOldB = revived.reduce((a, x) => a + x.old.b, 0);
  const revRows = revived.map(x => {
    const nk = normName(x.k);
    const prof = cspProf && cspProf[nk];
    const calls = ptl && ptl[nk] ? ptl[nk][LASTCOL] : null;
    const down = x.old.down.length;
    return `<tr><td style="text-align:left;white-space:normal"><b>${escR(x.k)}</b></td>` +
      `<td>${prof ? prof.paying.toLocaleString('en-IN') : '\u2014'}</td>` +
      `<td>${prof ? (prof.mg ? '<span class="pillmg">Enrolled</span>' : '<span style="color:var(--muted)">Not enrolled</span>') : '\u2014'}</td>` +
      `<td class="b">${x.b.r} / ${x.b.n} <span style="color:var(--muted)">(${pct(x.b.r, x.b.n)})</span></td>` +
      `<td class="g">${x.w.r} / ${x.w.n} <span style="color:var(--muted)">(${(x.w.r / x.w.n * 100).toFixed(0)}%)</span></td>` +
      `<td class="g"><b>+${((x.w.r / x.w.n - x.b.r / x.b.n) * 100).toFixed(0)} pp</b></td>` +
      `<td>${odds(x.pv)}</td>` +
      `<td>${x.l.n ? x.l.r + ' / ' + x.l.n : '\u2014'}</td>` +
      `<td class="${down ? 'b' : 'g'}">${x.old.b ? (x.old.b - down) + ' / ' + x.old.b : '\u2014'}</td>` +
      `<td>${calls == null ? '\u2014' : calls}</td>` +
      `<td class="${cspPay && cspPay[nk] && !cspPay[nk].cyc[0] ? 'b' : ''}">${inr(cspPay && cspPay[nk] ? cspPay[nk].cyc[0] : 0)}</td>` +
      `<td class="${cspPay && cspPay[nk] && !cspPay[nk].cyc[1] ? 'b' : ''}">${inr(cspPay && cspPay[nk] ? cspPay[nk].cyc[1] : 0)}</td>` +
      `<td style="white-space:nowrap">${cspPay && cspPay[nk] ? `${escR(cspPay[nk].lastWhen)} <span style="color:var(--muted)">${inr(cspPay[nk].lastRs)}</span>` : '<span class="pend">\u2014</span>'}</td>` +
      `<td style="text-align:left;white-space:normal;font-weight:400">${down
        ? `<span style="color:var(--bad)">Clean week, but ${down} older customer${down === 1 ? '' : 's'} still down</span>`
        : '<span style="color:var(--good)">Clean week, nothing left behind</span>'}</td>` +
      `<td style="text-align:left;white-space:normal;font-weight:400;font-size:12px">${down ? stopTix(x.old.down) : '<span style="color:var(--muted)">\u2014</span>'}</td></tr>`;
  }).join(NL);
  const revivedHtml = `<div style="margin-top:26px">
<h3 style="font-size:15.5px;margin:0 0 5px">The other way: CSPs that were failing and have come back</h3>
<p class="sub">The mirror of the table above, held to the same test and the same volumes: a CSP that had <b>at least ${REV_MIN_BEFORE} cases before ${fmtD(lwFrom)} and was resolving half or fewer of them</b>, then took at least ${REV_MIN} this week and cleared ${(REV_NOW * 100).toFixed(0)}% — a week too good to come from the rate it was running at, not a lucky 2 out of 2.${revived.length ? ` <b>${revived.length} CSP${revived.length === 1 ? '' : 's'}</b> cleared it, resolving <b>${revCases ? revRes + ' of ' + revCases : '0'}</b> cases between them. The column on the right is the real test: whether they also went back for the customers they had already left down.` : ' <b>No CSP cleared it this week.</b> Nobody on the failing list had both the volume and the week to show a real turn — which is its own answer when the meeting asks whether the push is working.'}</p>
${revived.length ? `<div class="tablewrap"><table style="min-width:1280px">
<thead><tr><th style="text-align:left">CSP</th><th>Userbase<br><span style="font-weight:400;opacity:.85">paying</span></th><th>MG<br><span style="font-weight:400;opacity:.85">enrolment</span></th><th>Record before<br><span style="font-weight:400;opacity:.85">${fmtD(lwFrom)}</span></th><th>${periods[LASTCOL - 1].key}<br><span style="font-weight:400;opacity:.85">resolved</span></th><th>Move</th><th>Chance it is<br><span style="font-weight:400;opacity:.85">a lucky week</span></th><th>Last week</th><th>Old breached cases<br><span style="font-weight:400;opacity:.85">fixed since</span></th><th>PTL calls</th><th>Bonus paid<br><span style="font-weight:400;opacity:.85">${PAY_CYCLES[0][0]} cycle</span></th><th>Bonus paid<br><span style="font-weight:400;opacity:.85">${PAY_CYCLES[1][0]} cycle</span></th><th>Last bonus<br><span style="font-weight:400;opacity:.85">paid</span></th><th style="text-align:left">Where they stand</th><th style="text-align:left">Older customers still down</th></tr></thead>
<tbody>
${revRows}
</tbody></table></div>
<p class="sub" style="margin-top:10px">Read the last two columns together before calling any of these fixed: on this week's work they are clean, but of the ${revOldB} cases they had already breached before ${fmtD(lwFrom)} they have gone back and fixed ${revOldB - revOldDown}. ${revOldDown ? `${revOldDown} of those customers are still down today, and they are named on the row.` : ''} A CSP is worth taking off the watchlist when both columns are clean two weeks running.</p>` : ''}
</div>`;

  // ── Last week's CSPs, followed forward ──────────────────────────────────
  // The question on the table is whether the CSPs that were not resolving have
  // come back. This answers it by name: take every case that was STILL OPEN
  // when its 48 hours ran out last week, group by the CSP holding it, and read
  // two things since — how many of those same cases the CSP has gone back and
  // fixed, and how it is doing on the cases it picked up this week.
  const nowW = inRange(periods[LASTCOL - 1]);
  const prevW = inRange(periods[LASTCOL - 2]);
  const isResC = c => getStatus(c) !== 'Unresolved';
  const cspKey = c => trim(c.partner) || '(unknown)';
  const breachedLW = prevW.filter(c => resolvedWithin48(c) !== true);
  const fixedLW = breachedLW.filter(isResC);
  const daysOld = c => Math.round((NOW - clockTs(c)) / 86400000);
  const cspTrack = {};
  breachedLW.forEach(c => {
    const k = cspKey(c);
    const e = cspTrack[k] || (cspTrack[k] = { b: 0, f: 0, tw: 0, twr: 0, oldest: 0, open: [] });
    e.b++;
    if (isResC(c)) e.f++; else { e.open.push(c); e.oldest = Math.max(e.oldest, daysOld(c)); }
  });
  nowW.forEach(c => {
    const k = cspKey(c);
    const e = cspTrack[k] || (cspTrack[k] = { b: 0, f: 0, tw: 0, twr: 0, oldest: 0, open: [] });
    e.tw++; if (isResC(c)) e.twr++;
  });
  const trackRows = Object.entries(cspTrack).filter(([, e]) => e.b > 0)
    .sort((a, b) => (b[1].b - b[1].f) - (a[1].b - a[1].f) || b[1].b - a[1].b);
  const trackTop = trackRows.slice(0, 15);
  const sumT = (list, f) => list.reduce((a, x) => a + f(x[1]), 0);
  const quietCsps = trackRows.filter(([, e]) => e.tw === 0).length;
  const standing = e => {
    if (e.b === e.f) return ['<span style="color:var(--good)">Cleared the backlog</span>', 'g'];
    if (e.tw && e.twr / e.tw >= 0.8) return ['<span style="color:var(--accent-ink)">Working the new ones, old ones still down</span>', ''];
    if (e.tw === 0) return ['<span style="color:var(--muted)">No case this week; old ones still down</span>', 'b'];
    return ['<b style="color:var(--bad)">Still not resolving</b>', 'b'];
  };
  const tix = list => list.sort((x, y) => daysOld(y) - daysOld(x)).slice(0, 6)
    .map(c => `<a href="https://wiomin.kapturecrm.com/nui/tickets/all/5/-1/0/detail/957486452/${escR(trim(c.ticket_no))}?query=${escR(trim(c.ticket_no))}" target="_blank" rel="noopener">${escR(trim(c.ticket_no))}</a> <span style="color:var(--muted)">${daysOld(c)}d</span>`).join(', ');
  const trackTopBody = trackTop.map(([k, e]) => {
    const [txt, cls] = standing(e);
    return `<tr><td style="text-align:left;white-space:normal"><b>${escR(k)}</b></td>` +
      `<td><b>${e.b}</b></td><td class="${e.f ? 'g' : ''}">${e.f}</td>` +
      `<td class="${e.b - e.f ? 'b' : 'g'}">${e.b - e.f}</td>` +
      `<td class="${e.oldest >= 14 ? 'b' : ''}">${e.oldest ? e.oldest + 'd' : '\u2014'}</td>` +
      `<td>${e.tw || '\u2014'}</td>` +
      `<td class="${e.tw ? (e.twr / e.tw >= 0.77 ? 'g' : 'b') : ''}">${e.tw ? e.twr + ' (' + pct(e.twr, e.tw) + ')' : '\u2014'}</td>` +
      `<td style="text-align:left;white-space:normal;font-weight:400">${txt}</td>` +
      `<td style="text-align:left;white-space:normal;font-weight:400;font-size:12px">${e.open.length ? tix(e.open) : '<span style="color:var(--muted)">\u2014</span>'}</td></tr>`;
  }).join(NL);
  const twAllRes = nowW.filter(isResC).length;
  const trackTopTw = sumT(trackTop, e => e.tw), trackTopTwr = sumT(trackTop, e => e.twr);
  const whyHtml = `<section>
<h2>Last week's CSPs \u2014 where they stand now</h2>
<p class="sub">Resolved (overall) went from <b>${pct(prevW.filter(isResC).length, prevW.length)}</b> (${periods[LASTCOL - 2].label}) to <b>${pct(twAllRes, nowW.length)}</b> (${periods[LASTCOL - 1].label}), and the question is whether the CSPs that were not resolving have come back. This follows them by name. <b>${breachedLW.length}</b> of last week's ${prevW.length} matured cases were still open when their 48 hours ran out, spread across <b>${trackRows.length} CSPs</b>. Since then those CSPs have gone back and fixed <b>${fixedLW.length} (${pct(fixedLW.length, breachedLW.length)})</b> of them; <b>${breachedLW.length - fixedLW.length} are still down today</b>. ${quietCsps} of the ${trackRows.length} CSPs had no case at all this week. The ${trackTop.length} carrying the most still-down cases are below, with the tickets themselves.</p>
<div class="tablewrap"><table style="min-width:1180px">
<thead><tr><th style="text-align:left">CSP</th><th>Open at 48 hrs<br><span style="font-weight:400;opacity:.85">last week</span></th><th>Fixed since</th><th>Still down</th><th>Oldest</th><th>Cases this week</th><th>Resolved this week</th><th style="text-align:left">Where they stand</th><th style="text-align:left">Still-down tickets</th></tr></thead>
<tbody>
${trackTopBody}
<tr class="tot"><td class="tot" style="text-align:left"><b>These ${trackTop.length} together</b></td><td class="tot"><b>${sumT(trackTop, e => e.b)}</b></td><td class="tot"><b>${sumT(trackTop, e => e.f)}</b></td><td class="tot"><b>${sumT(trackTop, e => e.b - e.f)}</b></td><td class="tot"></td><td class="tot"><b>${trackTopTw}</b></td><td class="tot"><b>${trackTopTwr}${trackTopTw ? ' (' + pct(trackTopTwr, trackTopTw) + ')' : ''}</b></td><td class="tot" style="text-align:left"><b>vs ${pct(twAllRes, nowW.length)} across all CSPs this week</b></td><td class="tot"></td></tr>
</tbody></table></div>
<p class="sub" style="margin-top:10px"><b>They have not been revived.</b> ${pct(breachedLW.length - fixedLW.length, breachedLW.length)} of the cases they left open last week are still open \u2014 ${breachedLW.length - fixedLW.length} customers who have now been down since the week before last, the oldest ${Math.max(0, ...breachedLW.filter(c => !isResC(c)).map(daysOld))} days. On the cases they picked up this week the ${trackTop.length} biggest of them resolved ${trackTopTwr} of ${trackTopTw}${trackTopTw ? ' (' + pct(trackTopTwr, trackTopTw) + ')' : ''}, against ${pct(twAllRes, nowW.length)} across all CSPs. The week's higher number is not coming from these CSPs going back to work; it is coming from the rest of the estate, and ${quietCsps} of these ${trackRows.length} simply had no case this week to be judged on.</p>
<p class="sub" style="margin-top:10px">The list to work in the meeting is the <b>Still down</b> column: those tickets are named on each row and have had a fortnight. Every one of them is a customer who complained, waited out the 48-hour promise, and is still waiting.</p>
</section>`;

  // How many reopens the tracker's tab pulls into this week from an earlier
  // one (case matured this week, came back down before the week started).
  const reopPrevSpill = era.filter(c => {
    const m = maturedAt(c), t = reopTs(c);
    return m >= lwFrom && m < lwTo && t > 0 && t < lwFrom;
  }).length;

  // ── Refund status for the week under review ─────────────────────────────
  // Same split the tracker's Weekly Review tab shows, so the two tie exactly:
  // of the week's matured cases, the eligible ones, then paid vs not paid with
  // the reason the desk recorded against each unpaid case.
  const lwMat = inRange(periods[LASTCOL - 1]);
  const lwElig = lwMat.filter(c => getStatus(c) === 'Unresolved' && !pingedAfter(c));
  const lwPaidL = lwElig.filter(isDone);
  const lwUnpaidL = lwElig.filter(c => !isDone(c));
  const lwReasonOf = c => {
    const m = trim(c.refund_action);
    if (m) return m;
    if (c.refund_amount !== '' && c.refund_amount != null && Number(c.refund_amount) === 0) return 'Amount 0 \u2014 refund not possible';
    return 'No reason recorded';
  };
  const lwTally = {};
  lwUnpaidL.forEach(c => { const k = lwReasonOf(c); lwTally[k] = (lwTally[k] || 0) + 1; });
  const weekRefundHtml = `<section>
<h2>Refund status \u2014 ${periods[LASTCOL - 1].key}</h2>
<p class="sub">The ${lwElig.length} refund-eligible cases out of the ${lwMat.length} that matured in ${periods[LASTCOL - 1].label}. Refunded plus not refunded add back to that number exactly, and every unpaid case carries the reason the desk recorded against it.</p>
<div class="tablewrap"><table>
<thead><tr><th style="text-align:left">Status</th><th>Cases</th><th>%</th><th>Amount</th></tr></thead>
<tbody>
<tr><td><b>Refund-eligible</b></td><td><b>${lwElig.length}</b></td><td><b>100%</b></td><td></td></tr>
<tr><td>Refunded</td><td class="g">${lwPaidL.length}</td><td class="g">${pct(lwPaidL.length, lwElig.length)}</td><td class="g">${inr(lwPaidL.reduce((a, c) => a + amtOf(c), 0))}</td></tr>
<tr><td>Not refunded</td><td class="b">${lwUnpaidL.length}</td><td class="b">${pct(lwUnpaidL.length, lwElig.length)}</td><td></td></tr>
${Object.entries(lwTally).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
  `<tr><td style="padding-left:34px;font-weight:400">${escR(k)}</td><td>${n}</td><td>${pct(n, lwElig.length)}</td><td></td></tr>`).join(NL)}
</tbody></table></div>
</section>`;

  // The week's reopens in full - a handful of cases, so show them rather than
  // summarising. These are the resolutions that did not hold.
  // A reopen belongs to the week it CAME BACK, not the week its case matured.
  // The tracker's tab reads it the other way and pulls in reopens from the
  // week before, which double-reports them: the 12 Sep reopen on ticket
  // 788875570106 was already in last Monday's doc.
  const lwReopCases = era.filter(c => { const t = reopTs(c); return t >= lwFrom && t < lwTo; });
  // The field team writes each reopen up in the RCA sheet the day they work
  // it, so the sheet's own "Added At" date is what scopes this to the week.
  // Matching on the tracker cohort instead would miss reopens on cases
  // received in an earlier week, which is most of them.
  const dmy = v => {
    const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) - IST : 0;
  };
  const reopWeekRows = reopRcaRows.filter(r => { const t = dmy(r.when); return t >= lwFrom && t < lwTo; });
  // Status of a reopened case = the field team's Status column in the RCA
  // sheet (Unresolved / Ping Up / Migrated), per Shariq 28 Sep.
  const reopStatusCls = rr => !rr || !rr.status ? '' : /unresolved/i.test(rr.status) ? 'b' : 'g';
  // The Reopened RCA: the remark the case was closed on when that is a reason
  // (SmartFiber: no router / inventory); a resolution remark such as 'Resolved
  // by Old CSP' says nothing about why it came back, so then the customer's
  // own account from the RCA sheet is used.
  const reopRcaOf = (c, rr) => {
    const closed = trim(c.remarks);
    if (closed && !isResRemark(c)) return closed;
    return rr && rr.cx ? rr.cx : '';
  };
  const reopSheetSummary = (statuses) => {
    const known = statuses.filter(Boolean);
    const down = known.filter(x => /unresolved/i.test(x)).length;
    const up = known.length - down;
    const miss = statuses.length - known.length;
    return `Status per the RCA sheet: <b>${up}</b> back up, <b class="${down ? 'b' : ''}">${down}</b> still down${miss ? `, ${miss} not in the sheet yet` : ''}.`;
  };
  // If the sheet has no rows for the week, say so. Silently dropping the
  // section makes an unfilled sheet look like a week with no reopens.
  const rcaLatest = reopRcaRows.map(r => dmy(r.when)).filter(Boolean).sort((x, y) => x - y).pop();
  const lwReopCount = S[LASTCOL - 1].reopWeek;
  let reopSnapHtml;
  if (lwReopCases.length) {
    // The tracker holds everything the meeting needs on a reopen: the remark
    // the case was closed on is the RCA. The RCA sheet fills in the customer's
    // own account where the field team has written it up.
    reopSnapHtml = `<section>
<h2>Reopened cases \u2014 ${periods[LASTCOL - 1].key}</h2>
<p class="sub">${lwReopCases.length} resolution${lwReopCases.length === 1 ? '' : 's'} came back down in ${periods[LASTCOL - 1].label}, of the ${S[LASTCOL - 1].w48g} net resolved that week (${pct(lwReopCases.length, S[LASTCOL - 1].w48g)}). The Reopened RCA is the reason recorded against the case: the remark it was closed on where that is a reason, otherwise the customer's own account from the <a href="https://docs.google.com/spreadsheets/d/1cXCnazjjLfzxG4-Uyr9nrGGo4qgGbbQ-zjFZ6xG_9vk/edit?gid=0" style="color:var(--accent-ink)">reopen RCA sheet</a>.</p>
<div class="tablewrap"><table style="min-width:980px">
<thead><tr><th>Ticket</th><th>Mobile</th><th style="text-align:left">CSP</th><th style="text-align:left">Sub-category</th><th>Status (RCA sheet)</th><th style="text-align:left">Reopened RCA</th></tr></thead>
<tbody>
${lwReopCases.map(c => {
  const t = dig(c.ticket_no);
  const rr = reopReason[t];
  return `<tr>` +
    `<td><a href="https://wiomin.kapturecrm.com/nui/tickets/all/5/-1/0/detail/957486452/${escR(trim(c.ticket_no))}?query=${escR(trim(c.ticket_no))}" target="_blank" rel="noopener">${escR(trim(c.ticket_no))}</a></td>` +
    `<td style="font-size:12.5px">${escR(trim(c.mobile))}</td>` +
    `<td style="text-align:left;font-weight:400;white-space:normal">${escR(trim(c.partner))}</td>` +
    `<td style="text-align:left;font-weight:400;white-space:normal;font-size:12.5px">${escR(trim(c.subcat))}</td>` +
    `<td class="${reopStatusCls(rr)}">${rr && rr.status ? escR(rr.status) : '<span style="color:var(--muted);font-weight:400">not in sheet</span>'}</td>` +
    `<td style="text-align:left;white-space:normal"><b>${escR(reopRcaOf(c, rr)) || '<span style="color:var(--muted);font-weight:400">not written up</span>'}</b></td>` +
    `</tr>`;
}).join(NL)}
</tbody></table></div>
<p class="sub" style="margin-top:10px">${reopSheetSummary(lwReopCases.map(c => (reopReason[dig(c.ticket_no)] || {}).status))}</p>
<p class="sub" style="margin-top:6px">The tracker's Weekly Review tab shows ${S[LASTCOL - 1].reopWeek + (reopPrevSpill || 0)} for this week because it counts a reopen in the week the case matured. ${reopPrevSpill ? `${reopPrevSpill} of those came back down before ${fmtD(lwFrom)} and ${reopPrevSpill === 1 ? 'was' : 'were'} already reported last Monday, so ${reopPrevSpill === 1 ? 'it is counted in its' : 'they are counted in their'} own week here.` : ''}</p>
</section>`;
  } else if (!reopWeekRows.length) {
    // Say the sheet is empty. Dropping the section silently reads as "no
    // reopens this week", which is a different and much rosier claim.
    reopSnapHtml = `<section>
<h2>Reopened cases \u2014 ${periods[LASTCOL - 1].key}</h2>
<p class="sub"><b>No resolution came back down in ${periods[LASTCOL - 1].label}.</b> The reopen RCA sheet has no entries for the week either \u2014 its most recent row is dated ${rcaLatest ? fmtD(rcaLatest) : 'unknown'}.</p>
</section>`;
  } else {
    reopSnapHtml = `<section>
<h2>Reopened cases \u2014 ${periods[LASTCOL - 1].key}</h2>
<p class="sub">The ${reopWeekRows.length} customers whose case reopened in ${periods[LASTCOL - 1].label}, with the reason each gave, straight from the field team's reopen RCA sheet.</p>
<div class="tablewrap"><table style="min-width:980px">
<thead><tr><th>Ticket</th><th>Mobile</th><th style="text-align:left">Customer</th><th style="text-align:left">CSP</th><th style="text-align:left">Sub-category</th><th>Status</th><th style="text-align:left">Reopened RCA</th></tr></thead>
<tbody>
${reopWeekRows.map(r => `<tr>` +
  `<td><a href="https://wiomin.kapturecrm.com/nui/tickets/all/5/-1/0/detail/957486452/${escR(r.t)}?query=${escR(r.t)}" target="_blank" rel="noopener">${escR(r.t)}</a></td>` +
  `<td style="font-size:12.5px">${escR(r.mobile)}</td>` +
  `<td style="text-align:left;font-weight:400;white-space:normal">${escR(r.cust)}</td>` +
  `<td style="text-align:left;font-weight:400;white-space:normal">${escR(r.cspName)}</td>` +
  `<td style="text-align:left;font-weight:400;white-space:normal;font-size:12.5px">${escR(r.subcat)}</td>` +
  `<td class="${reopStatusCls(r)}">${escR(r.status) || '<span style="color:var(--muted);font-weight:400">not filled</span>'}</td>` +
  `<td style="text-align:left;white-space:normal"><b>${escR(r.cx || r.csp) || '<span style="color:var(--muted);font-weight:400">not filled</span>'}</b></td>` +
  `</tr>`).join(NL)}
</tbody></table></div>
<p class="sub" style="margin-top:10px">${reopSheetSummary(reopWeekRows.map(r => r.status))}</p>
<p class="sub" style="margin-top:6px">The RCA is the customer's own account from the sheet, or the CSP's where the customer's is not filled. The CSP has recorded <b>&ldquo;Internet Working&rdquo;</b> on ${reopWeekRows.filter(r => /internet working/i.test(r.csp)).length} of the ${reopWeekRows.length}.</p>
</section>`;
  }

  // ── Refund pending, reconciled across every surface ─────────────────────
  // The same words mean different sets in different places and the meeting
  // kept re-asking which number was right. Both are correct for what they
  // count, so the bridge between them is shown rather than one being picked:
  // the tracker's Refund card calls every breached case eligible, this doc and
  // the tracker's Weekly Review tab drop the ones whose line came back on.
  // "Parked" is the card's own test - a Refund Action reason is recorded, or
  // the amount computed to zero.
  const trackerSaysDone = c => !!sheetEntry(c) || trim(c.cx_action) === 'Refund Done' || trim(c.refund_action) === 'Refund Done';
  const parkedOf = c => {
    const ra = trim(c.refund_action);
    return (ra !== '' && ra !== 'Refund Done') ||
      (c.refund_amount !== '' && c.refund_amount != null && Number(c.refund_amount) === 0);
  };
  // Each row must show what that surface actually displays: the tracker and
  // its Weekly Review tab do not read Wiom Hub, so they are split on the
  // tracker's own test, and only this doc's rows count a Hub payment.
  const split = (list, doneFn) => {
    const fn = doneFn || isDone;
    const done = list.filter(fn);
    const rest = list.filter(c => !fn(c));
    const park = rest.filter(parkedOf);
    const pend = rest.filter(c => !parkedOf(c));
    return { n: list.length, done, park, pend };
  };
  const cardAll = split(unresAll, trackerSaysDone);   // the tracker's Refund card
  const docAll = split(eligAll);                     // this doc, Wiom Hub included
  const cardWk = split(lwMat.filter(c => getStatus(c) === 'Unresolved'), trackerSaysDone);
  const docWk = split(lwElig, trackerSaysDone);      // the tracker's Weekly Review tab
  const pingedPaid = pingedBack.filter(isDone).length;
  // The desk's reason values carry both dash characters, which splits the same
  // reason into two rows wherever they are tallied. Normalised here, and the
  // count of affected cases is stated so it can be cleaned at source.
  const normReason = v => trim(v).replace(/\s*[-\u2013\u2014]\s*/g, ' \u2014 ');
  const reasonTally = {};
  eligUnpaid.forEach(c => {
    const ra = trim(c.refund_action);
    const k = normReason(ra && ra !== 'Refund Done' ? ra
      : ((c.refund_amount !== '' && c.refund_amount != null && Number(c.refund_amount) === 0)
        ? 'Amount 0 \u2014 refund not possible' : 'No reason recorded'));
    reasonTally[k] = (reasonTally[k] || 0) + 1;
  });
  const hyphenVariants = eligUnpaid.filter(c => /\s-\s/.test(trim(c.refund_action))).length;
  // What the Hub says about the eligible set, and the cases where the two
  // records disagree - paid there, never marked here.
  const hubElig = eligAll.filter(c => hubOf(c));
  const hubApproved = eligAll.filter(hubPaid);
  const hubRejected = eligAll.filter(c => { const h = hubOf(c); return h && h.st === 'REJECTED'; });
  const hubPending = eligAll.filter(c => { const h = hubOf(c); return h && h.st === 'PENDING'; });
  const hubOnly = hubApproved.filter(c => !trackerSaysDone(c));
  const refundedAll = eligAll.filter(isDone);
  const srcHub = refundedAll.filter(hubPaid);
  const srcSheet = refundedAll.filter(c => !hubPaid(c) && !!sheetEntry(c));
  const srcTracker = refundedAll.filter(c => !hubPaid(c) && !sheetEntry(c));
  const hubAmt = list => list.reduce((a, c) => a + (hubOf(c) ? hubOf(c).amt : 0), 0);
  const surfaceRow = (name, sp, note) =>
    `<tr><td style="text-align:left;white-space:normal">${name}</td>` +
    `<td><b>${sp.n.toLocaleString('en-IN')}</b></td>` +
    `<td class="g">${sp.done.length.toLocaleString('en-IN')} (${pct(sp.done.length, sp.n)})</td>` +
    `<td>${sp.park.length.toLocaleString('en-IN')} (${pct(sp.park.length, sp.n)})</td>` +
    `<td class="b"><b>${sp.pend.length.toLocaleString('en-IN')} (${pct(sp.pend.length, sp.n)})</b></td>` +
    `<td class="b">${inr(sumA(sp.pend))}</td>` +
    `<td style="text-align:left;white-space:normal;font-weight:400">${note}</td></tr>`;
  const refundTriangleHtml = `<section>
<h2>Refund pending \u2014 the same number on every surface</h2>
<p class="sub"><b>Wiom Hub is the source of truth for a refund</b> — it is where the payment is raised, approved and sent — and the sync marks a case Refund Done the moment the Hub approves it, so nobody has to key it in twice. The Finance sheet and the tracker's own fields are kept as a fallback, for refunds the Hub never saw. Four records still carry a refund status and they do not match, because they count different sets. Neither is wrong; this is the bridge between them, so the meeting can stop re-deriving it. <b>Pending</b> everywhere below means the same thing: eligible, not refunded, and <b>no reason recorded against it</b> \u2014 the genuine backlog. <b>Parked</b> means the desk has looked at it and written down why it is not being paid (Cx DNP, pickup ticket not raised, PFT process miss, 120 hrs not crossed, amount computed as \u20b90).</p>
<div class="tablewrap"><table style="min-width:900px">
<thead><tr><th style="text-align:left">Step</th><th>Cases</th><th style="text-align:left">What it is</th></tr></thead>
<tbody>
<tr><td><b>Unresolved past 48 hrs, since 29 Jul</b></td><td><b>${unresAll.length.toLocaleString('en-IN')}</b></td><td style="text-align:left;font-weight:400">Every breached case. The tracker's Refund card calls all of these eligible</td></tr>
<tr><td>\u2212 line came back on after the complaint</td><td>${pingedBack.length.toLocaleString('en-IN')}</td><td style="text-align:left;font-weight:400">Recovered after the breach, so nothing is owed \u2014 ${pingedPaid} of them were refunded anyway</td></tr>
<tr class="tot"><td class="tot"><b>= Refund-eligible</b></td><td class="tot"><b>${eligAll.length.toLocaleString('en-IN')}</b></td><td class="tot" style="text-align:left;font-weight:400"><b>What this doc and the tracker's Weekly Review tab call eligible</b></td></tr>
</tbody></table></div>
<div class="tablewrap" style="margin-top:14px"><table style="min-width:1020px">
<thead><tr><th style="text-align:left">Where you see it</th><th>Eligible</th><th>Refunded</th><th>Reason recorded<br><span style="font-weight:400;opacity:.85">parked + nothing payable</span></th><th>Pending<br><span style="font-weight:400;opacity:.85">no reason</span></th><th>Pending \u20b9</th><th style="text-align:left">Scope</th></tr></thead>
<tbody>
${surfaceRow("Tracker \u2192 Refund card (<i>Eligible / Pending / Parked / Done</i>)", cardAll, 'Since 29 Jul, no ping filter')}
${surfaceRow('This doc \u2014 funnel and tiles', docAll, 'Since 29 Jul, line never came back, <b>Wiom Hub counted</b>')}
${surfaceRow("Tracker \u2192 Weekly Review tab, section 4", docWk, `${periods[LASTCOL - 1].label} only, line never came back`)}
${surfaceRow('The same week without the ping filter', cardWk, `${periods[LASTCOL - 1].label} only`)}
</tbody></table></div>
<p class="sub" style="margin-top:10px">So the honest headline is <b>${docAll.pend.length} customers, ${inr(sumA(docAll.pend))}</b>: eligible, still down, and nobody has written down why they have not been paid. The tracker's card reads ${cardAll.pend.length} because it also counts the ${pingedBack.length} whose line recovered. Everything else in the gap has a reason against it — that column is the funnel's <i>parked</i> and <i>nothing payable</i> rows added together. This doc's row is lower than the tracker's for one more reason: it counts a refund Wiom Hub has already paid even where nobody marked it in the tracker, which is ${hubOnly.length} cases.${hyphenVariants ? ` One cleanup at source: ${hyphenVariants} cases carry a reason typed with a plain hyphen where the dropdown uses a dash, which splits the same reason into two rows wherever it is tallied \u2014 they are merged below.` : ''}</p>
<div class="tablewrap" style="margin-bottom:14px"><table style="min-width:820px">
<thead><tr><th style="text-align:left">Where each refund is recorded</th><th>Cases</th><th>Amount</th><th style="text-align:left">Read</th></tr></thead>
<tbody>
<tr><td><b>Refunded, of the ${eligAll.length} eligible</b></td><td><b>${refundedAll.length}</b></td><td><b>${inr(sumA(refundedAll))}</b></td><td></td></tr>
<tr><td>↳ <b>Wiom Hub</b> — the payment itself</td><td class="g">${srcHub.length}</td><td class="g">${inr(sumA(srcHub))}</td><td style="text-align:left;font-weight:400">The source of truth: raised, approved and sent in t_plan_refund_request</td></tr>
<tr><td>↳ Finance sheet only <span style="font-weight:400;color:var(--muted)">(fallback)</span></td><td>${srcSheet.length}</td><td>${inr(sumA(srcSheet))}</td><td style="text-align:left;font-weight:400">Finance records it as paid and the Hub has no matching request — worth confirming the money went out</td></tr>
<tr><td>↳ Tracker field only <span style="font-weight:400;color:var(--muted)">(fallback)</span></td><td>${srcTracker.length}</td><td>${inr(sumA(srcTracker))}</td><td style="text-align:left;font-weight:400">Marked by hand in the tracker; neither the Hub nor Finance carries it</td></tr>
</tbody></table></div>
<div class="tablewrap" style="margin-bottom:14px"><table style="min-width:900px">
<thead><tr><th style="text-align:left">Wiom Hub — <span style="font-weight:400;opacity:.85">t_plan_refund_request, where the money actually moves</span></th><th>Cases</th><th>Amount</th><th style="text-align:left">Read</th></tr></thead>
<tbody>
<tr><td><b>Eligible cases with a refund raised in the Hub</b></td><td><b>${hubElig.length}</b></td><td>${inr(hubAmt(hubElig))}</td><td style="text-align:left;font-weight:400">Of the ${eligAll.length} refund-eligible, matched on the customer's number</td></tr>
<tr><td>↳ Approved — paid or in flight</td><td class="g">${hubApproved.length}</td><td class="g">${inr(hubAmt(hubApproved))}</td><td style="text-align:left;font-weight:400">Counted as refunded in every figure in this doc</td></tr>
<tr><td>↳ Rejected in the Hub</td><td class="b">${hubRejected.length}</td><td>${inr(hubAmt(hubRejected))}</td><td style="text-align:left;font-weight:400">Raised and turned down — the customer is still owed nothing through this route</td></tr>
<tr><td>↳ Waiting for approval</td><td>${hubPending.length}</td><td>${inr(hubAmt(hubPending))}</td><td style="text-align:left;font-weight:400">Raised, not yet approved</td></tr>
<tr${hubOnly.length ? ' class="tot"' : ''}><td${hubOnly.length ? ' class="tot"' : ''}><b>Paid in the Hub, never marked in the tracker</b></td><td${hubOnly.length ? ' class="tot b"' : ' class="g"'}><b>${hubOnly.length}</b></td><td${hubOnly.length ? ' class="tot"' : ''}>${inr(hubAmt(hubOnly))}</td><td style="text-align:left;font-weight:400"${hubOnly.length ? ' class="tot"' : ''}>${hubOnly.length ? 'The customer has their money; the tracker still reads them as unpaid. Named below — mark them off.' : 'Every Hub refund is reflected in the tracker'}</td></tr>
</tbody></table></div>
${hubOnly.length ? `<div class="tablewrap" style="margin-bottom:14px"><table style="min-width:900px">
<thead><tr><th>Ticket</th><th>Mobile</th><th style="text-align:left">CSP</th><th>Paid in Hub</th><th>Amount</th><th>Hub status</th><th style="text-align:left">What the tracker says</th></tr></thead>
<tbody>
${hubOnly.sort((a, b) => (hubOf(b).when || '').localeCompare(hubOf(a).when || '')).map(c => {
  const h = hubOf(c);
  return `<tr><td><a href="https://wiomin.kapturecrm.com/nui/tickets/all/5/-1/0/detail/957486452/${escR(trim(c.ticket_no))}?query=${escR(trim(c.ticket_no))}" target="_blank" rel="noopener">${escR(trim(c.ticket_no))}</a></td>` +
    `<td style="font-size:12.5px">${escR(trim(c.mobile))}</td>` +
    `<td style="text-align:left;font-weight:400;white-space:normal">${escR(trim(c.partner))}</td>` +
    `<td>${escR(h.when)}</td><td class="g">${inr(h.amt)}</td>` +
    `<td>${escR(h.rs || h.st)}</td>` +
    `<td style="text-align:left;font-weight:400;white-space:normal">${escR(trim(c.refund_action)) || escR(trim(c.cx_action)) || '<span style="color:var(--muted)">nothing recorded</span>'}</td></tr>`;
}).join(NL)}
</tbody></table></div>` : ''}
<div class="tablewrap"><table>
<thead><tr><th style="text-align:left">Why an eligible case has not been paid</th><th>Cases</th><th>% of eligible</th></tr></thead>
<tbody>
${Object.entries(reasonTally).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
  `<tr><td style="text-align:left;white-space:normal"${k === 'No reason recorded' ? ' class="b"' : ''}>${escR(k)}</td><td${k === 'No reason recorded' ? ' class="b"' : ''}>${n}</td><td>${pct(n, eligAll.length)}</td></tr>`).join(NL)}
</tbody></table></div>
</section>`;

  // ── Refunds, in one section ─────────────────────────────────────────────
  // Four refund sections ran down the page - the week, the funnel, the
  // reconciliation, the month-on-month. In a big meeting that reads as noise
  // (Shariq, 28 Sep). One table now answers it: of the customers owed money,
  // how many were paid, how many are parked with a reason, and how many are a
  // genuine backlog. The rest is folded behind a disclosure for whoever wants
  // to audit it.
  const refundsHtml = () => {
    // One funnel, two columns: the week just reviewed and since launch. Every
    // line descends from the one above it and each amount sits beside its
    // count. The rows tie to the week-wise table: Cases matured, Unresolved,
    // line came back, Refund-eligible and Customers refunded are the same
    // numbers there.
    const wkAll = lwMat, tdAll = maturedAll;
    const F = list => {
      const unres = list.filter(c => getStatus(c) === 'Unresolved');
      const back = unres.filter(c => pingedAfter(c));
      const elig = unres.filter(c => !pingedAfter(c));
      const sp = split(elig);
      return { m: list.length, unres, back, elig, done: sp.done, park: sp.park, pend: sp.pend, notDone: elig.filter(c => !isDone(c)) };
    };
    const wk = F(wkAll), td = F(tdAll);
    const cell = (l, base, cls, money) =>
      `<td class="${cls || ''}">${l.length.toLocaleString('en-IN')}${base ? ' <span style="color:var(--muted)">(' + pct(l.length, base) + ')</span>' : ''}</td>` +
      `<td class="${cls || ''}">${money ? inr(sumA(l)) : ''}</td>`;
    const line = (label, pick, baseOf, cls, money, note) =>
      `<tr><td class="${cls || ''}" style="text-align:left">${label}</td>${cell(pick(wk), baseOf(wk), cls, money)}${cell(pick(td), baseOf(td), cls, money)}<td style="text-align:left;font-weight:400">${note}</td></tr>`;
    const avg = list => (list.length ? inr(sumA(list) / list.length) : '\u2014');
    return `<section>
<h2>Refunds</h2>
<p class="sub">One funnel, read straight down: of the cases that matured, how many were still down at 48 hrs, how many of those never came back (owed a refund), and whether they were paid. <b>Pending</b> means owed, unpaid, and nobody has written down why.</p>
<div class="tablewrap"><table style="min-width:900px">
<thead><tr><th style="text-align:left">Stage</th><th>${periods[LASTCOL - 1].key} <span style="font-weight:400;opacity:.85">(${periods[LASTCOL - 1].label})</span></th><th>Amount</th><th>Since launch <span style="font-weight:400;opacity:.85">(${periods[LASTCOL].label})</span></th><th>Amount</th><th style="text-align:left">Read</th></tr></thead>
<tbody>
<tr><td style="text-align:left"><b>Cases matured</b></td><td><b>${wk.m.toLocaleString('en-IN')}</b></td><td></td><td><b>${td.m.toLocaleString('en-IN')}</b></td><td></td><td style="text-align:left;font-weight:400">Crossed the 48-hr mark in the period</td></tr>
${line('Unresolved at 48 hrs', x => x.unres, x => x.m, 'b', false, 'Still down when the 48 hrs ran out')}
${line('\u21b3 Line came back on later', x => x.back, x => x.unres.length, '', false, 'Recovered after the breach, nothing owed')}
${line('<b>\u21b3 Refund-eligible \u2014 owed a refund</b>', x => x.elig, x => x.m, '', true, 'Still down and no ping since the complaint; % of cases matured, as in the week-wise table')}
${line('<b>Refunded</b>', x => x.done, x => x.elig.length, 'g', true, 'Wiom Hub, the Finance sheet or the tracker')}
${line('Not refunded', x => x.notDone, x => x.elig.length, '', true, 'Split below')}
${line('\u21b3 Parked with a reason', x => x.park, x => x.elig.length, '', true, 'Cx DNP, pickup not raised, PFT miss, amount \u20b90')}
${line('<b>\u21b3 Pending \u2014 no reason recorded</b>', x => x.pend, x => x.elig.length, 'b', true, 'The backlog to work')}
<tr><td style="text-align:left"><b>Average paid per customer</b></td><td></td><td><b>${avg(wk.done)}</b></td><td></td><td><b>${avg(td.done)}</b></td><td style="text-align:left;font-weight:400">Pro-rata on the days of plan left when the customer complained</td></tr>
</tbody></table></div>
<p class="sub" style="margin-top:10px">Of the ${td.done.length} refunded since launch, <b>${srcHub.length}</b> came through Wiom Hub, where the money actually moves; ${srcSheet.length} are recorded by Finance with no request in the Hub, and ${srcTracker.length} were marked by hand in the tracker.</p>
</section>`;
  };

  // Month-on-month view of why a refund has not been paid. Cohorted by the
  // month the case was added, over every eligible case that is still unpaid.
  const monthsBack = [];
  {
    const d = new Date(NOW + IST);
    for (let i = 2; i >= 0; i--) {
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
      monthsBack.push({
        key: MN2[m.getUTCMonth()] + ' ' + String(m.getUTCFullYear()).slice(2),
        from: Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1) - IST,
        to: Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1) - IST,
      });
    }
  }
  const momReasons = {};
  eligUnpaid.forEach(c => {
    const k = raEffective(c), t = clockTs(c);
    const mi = monthsBack.findIndex(m => t >= m.from && t < m.to);
    if (mi < 0) return;
    const row = momReasons[k] || (momReasons[k] = monthsBack.map(() => 0));
    row[mi]++;
  });
  const momRows = Object.entries(momReasons)
    .sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0))
    .map(([k, arr]) => `<tr><td style="text-align:left">${escR(k)}</td>` +
      arr.map(v => `<td>${v || '-'}</td>`).join('') +
      `<td class="tot"><b>${arr.reduce((x, y) => x + y, 0)}</b></td></tr>`).join(NL);
  const momTotals = monthsBack.map((_, i) => Object.values(momReasons).reduce((a, arr) => a + arr[i], 0));
  const momHtml = `<section>
<h2>Why a refund is still unpaid \u2014 month on month</h2>
<p class="sub">Every refund-eligible case that has not been paid, by the month the case was added. A reason recorded against a case means the desk has looked at it; the rows with no reason are the genuine backlog.</p>
<div class="tablewrap"><table style="min-width:560px">
<thead><tr><th style="text-align:left">Reason</th>${monthsBack.map(m => `<th>${m.key}</th>`).join('')}<th class="tot">Total</th></tr></thead>
<tbody>
${momRows}
<tr class="tot"><td class="tot" style="text-align:left"><b>Total</b></td>${momTotals.map(v => `<td class="tot"><b>${v}</b></td>`).join('')}<td class="tot"><b>${momTotals.reduce((a, b) => a + b, 0)}</b></td></tr>
</tbody></table></div>
</section>`;

  const refundFunnel = `<section>
<h2>Refund cases funnel</h2>
<p class="sub">Reads straight down from the Since-launch column above: received &rarr; matured &rarr; unresolved &rarr; refund-eligible, then whether the eligible customers were paid. Refunded plus not-refunded add back to the eligible line exactly.</p>
<div class="tablewrap"><table>
<thead><tr><th style="text-align:left">Stage</th><th>Cases</th><th>%</th><th>Amount</th><th style="text-align:left">What happened</th></tr></thead>
<tbody>
${stage('Cases received', era.length, 0, 'Since 29 Jul, up to ' + cutLabel)}
${stage('Matured', maturedAll.length, era.length, 'Completed the full 48-hour window')}
${stage('Unresolved at 48 hrs', unresAll.length, maturedAll.length, 'Breached the promise', 'b')}
<tr><td style="padding-left:34px;font-weight:400">&#8627; Line came back later (ping seen)</td><td>${pingedBack.length.toLocaleString('en-IN')}</td><td>${pct(pingedBack.length, unresAll.length)}</td><td></td><td style="text-align:left;font-weight:400">Recovered after the breach, nothing owed</td></tr>
${stage('Refund-eligible &mdash; no ping since the complaint', E, unresAll.length, 'The customer is still down and is owed money', 'b')}
<tr><td class="g" style="padding-left:20px"><b>Refunded</b></td><td class="g"><b>${eligPaid.length.toLocaleString('en-IN')}</b></td><td class="g"><b>${pct(eligPaid.length, E)}</b></td><td>${inr(sumA(eligPaid))}</td><td style="text-align:left;font-weight:400">Paid, per the tracker or the Finance sheet</td></tr>
<tr><td class="b" style="padding-left:20px"><b>Not refunded</b></td><td class="b"><b>${eligUnpaid.length.toLocaleString('en-IN')}</b></td><td class="b"><b>${pct(eligUnpaid.length, E)}</b></td><td>${inr(sumA(eligUnpaid))}</td><td style="text-align:left;font-weight:400">Split below by what is blocking it</td></tr>
${['Refund pending \u2014 no reason recorded', 'Parked with a reason recorded', 'Nothing payable'].map(g => {
  const t = grp[g];
  if (!t || !t.n) return '';
  return `<tr><td style="padding-left:38px"><b>${g}</b></td><td><b>${t.n.toLocaleString('en-IN')}</b></td><td><b>${pct(t.n, E)}</b></td><td>${inr(t.amt)}</td><td></td></tr>` + NL +
    Object.entries(t.sub).sort((x, y) => y[1].n - x[1].n).map(([k, v]) =>
      `<tr><td style="padding-left:64px;font-weight:400">${escR(k)}</td><td>${v.n.toLocaleString('en-IN')}</td><td>${pct(v.n, E)}</td><td>${inr(v.amt)}</td><td style="text-align:left;font-weight:400">${subNote(k)}</td></tr>`).join(NL);
}).join(NL)}
</tbody></table></div>

</section>`;


  // ── Last meeting's action items ───────────────────────────────────────────
  // Live from the tracker's Action Items tab — nothing typed by hand.
  const escA = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // Only what is still open. Closed items were being carried week after week
  // long after they were done; they stay in the tracker's Action Items tab,
  // which is the record, and come back here the moment one is reopened.
  // Open items, plus anything closed since the start of the week under
  // review, so the meeting sees what got done before it drops off the page.
  const aiItems = Object.entries(aiRaw || {})
    .filter(([, v]) => v && v.item && (trim(v.status) !== 'Done' || (Number(v.updated_at) || 0) >= periods[LW].from))
    .sort((a, b) => (a[1].created_at || 0) - (b[1].created_at || 0));
  const aiHtml = `<section>
<h2>Action items</h2>
<p class="sub">Open items, plus those closed since ${fmtD(periods[LW].from)}, live from the tracker's Action Items tab. Older closed items are not repeated here — the tab holds the full record.</p>
<div class="tablewrap"><table>
<thead><tr><th style="width:26px">#</th><th style="text-align:left">Action item</th><th>Owner</th><th>Due</th><th>Status</th><th style="text-align:left">Where it landed</th></tr></thead>
<tbody>
${aiItems.length ? aiItems.map(([, v], i) =>
  `<tr><td style="text-align:left;color:var(--muted);font-weight:400">${i + 1}</td>` +
  `<td style="text-align:left;white-space:normal">${escA(v.item)}</td>` +
  `<td style="font-weight:400">${escA(v.owner) || '—'}</td>` +
  `<td style="font-weight:400">${escA(v.due) || '—'}</td>` +
  `<td class="${v.status === 'Done' ? 'g' : 'b'}">${escA(v.status || 'Open')}</td>` +
  `<td style="text-align:left;white-space:normal;font-weight:400">${escA(v.notes) || '<i style="color:var(--muted)">no closing note yet</i>'}</td></tr>`
).join(String.fromCharCode(10)) : '<tr><td colspan="6" style="text-align:left">Nothing open, and nothing closed this week.</td></tr>'}
</tbody></table></div>
</section>`;


  // ── Comment / action-item box ───────────────────────────────────────────
  // The doc is read in the meeting, and until now anything raised there had to
  // be typed into the tracker afterwards - which is how items went missing.
  // This posts straight into the same Firebase nodes the tracker reads, so an
  // action item raised here shows up in the Action Items tab immediately and in
  // next Monday's doc, and a comment is visible to whoever opens the page next.
  const commentBox = [
    '<button id="fabBtn" title="Add an action item or a comment">&#128172; Add action item / comment</button>',
    '<div id="fabPanel" role="dialog" aria-label="Add an action item or comment">',
    '  <div class="fabHead"><b>Raise it here</b><button id="fabClose" aria-label="Close">&times;</button></div>',
    '  <div class="fabTabs"><button class="fabTab on" data-kind="action">Action item</button><button class="fabTab" data-kind="comment">Comment</button></div>',
    '  <label>Your name<input id="fabWho" placeholder="who is raising this"></label>',
    '  <label id="fabTextLbl">The action<textarea id="fabText" rows="3" placeholder="what needs to be done"></textarea></label>',
    '  <div class="fabRow" id="fabActionOnly">',
    '    <label>Owner<input id="fabOwner" placeholder="who owns it"></label>',
    '    <label>Due<input id="fabDue" type="date"></label>',
    '  </div>',
    '  <button id="fabSave">Save</button>',
    '  <div id="fabMsg"></div>',
    '  <div id="fabList"></div>',
    '</div>',
  ].join('\n');
  const commentScript = [
    '<script>(function(){',
    '  var FB = "' + FIREBASE_DB + '";',
    '  var kind = "action";',
    '  var $ = function(id){ return document.getElementById(id); };',
    '  var panel = $("fabPanel"), btn = $("fabBtn");',
    '  function show(v){ panel.style.display = v ? "flex" : "none"; if (v) { $("fabWho").value = localStorage.getItem("hpRecapWho") || "Shariq"; loadList(); } }',
    '  btn.onclick = function(){ show(panel.style.display !== "flex"); };',
    '  $("fabClose").onclick = function(){ show(false); };',
    '  Array.prototype.forEach.call(document.querySelectorAll(".fabTab"), function(t){',
    '    t.onclick = function(){',
    '      Array.prototype.forEach.call(document.querySelectorAll(".fabTab"), function(x){ x.className = "fabTab"; });',
    '      t.className = "fabTab on"; kind = t.getAttribute("data-kind");',
    '      $("fabActionOnly").style.display = kind === "action" ? "flex" : "none";',
    '      $("fabTextLbl").firstChild.nodeValue = kind === "action" ? "The action" : "Your comment";',
    '      $("fabText").placeholder = kind === "action" ? "what needs to be done" : "what you want to flag";',
    '      loadList();',
    '    };',
    '  });',
    '  function esc(v){ return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }',
    '  function loadList(){',
    '    var node = kind === "action" ? "/cases/__action_items__.json" : "/cases/__recap_comments__.json";',
    '    fetch(FB + node).then(function(r){ return r.json(); }).then(function(j){',
    '      var rows = Object.keys(j || {}).map(function(k){ return j[k]; })',
    '        .filter(function(v){ return v && (v.item || v.text); })',
    '        .sort(function(a, b){ return (b.created_at || 0) - (a.created_at || 0); }).slice(0, 6);',
    '      $("fabList").innerHTML = rows.length',
    '        ? "<div class=\'fabListHd\'>Latest</div>" + rows.map(function(v){',
    '            return "<div class=\'fabItem\'><b>" + esc(v.item || v.text) + "</b><span>" + esc(v.owner || v.by || "") +',
    '              (v.status ? " &middot; " + esc(v.status) : "") + "</span></div>"; }).join("")',
    '        : "<div class=\'fabListHd\'>Nothing yet</div>";',
    '    }).catch(function(){ $("fabList").innerHTML = ""; });',
    '  }',
    '  $("fabSave").onclick = function(){',
    '    var text = $("fabText").value.trim(), who = $("fabWho").value.trim();',
    '    if (!text) { $("fabMsg").textContent = "Write something first."; return; }',
    '    if (!who)  { $("fabMsg").textContent = "Add your name so the owner knows who raised it."; return; }',
    '    localStorage.setItem("hpRecapWho", who);',
    '    $("fabSave").disabled = true; $("fabMsg").textContent = "Saving...";',
    '    var node, body;',
    '    if (kind === "action") {',
    '      node = "/cases/__action_items__.json";',
    '      body = { item: text, owner: $("fabOwner").value.trim() || who, due: $("fabDue").value || "",',
    '               status: "Open", notes: "", created_at: Date.now(), created_by: who, source: "weekly doc" };',
    '    } else {',
    '      node = "/cases/__recap_comments__.json";',
    '      body = { text: text, by: who, created_at: Date.now(), week: "WEEKLABEL" };',
    '    }',
    '    fetch(FB + node, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })',
    '      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })',
    '      .then(function(){',
    '        $("fabMsg").textContent = kind === "action" ? "Saved - it is in the tracker\'s Action Items tab now." : "Saved.";',
    '        $("fabText").value = ""; $("fabSave").disabled = false; loadList();',
    '      })',
    '      .catch(function(e){ $("fabMsg").textContent = "Could not save (" + e.message + ") - tell Shariq."; $("fabSave").disabled = false; });',
    '  };',
    '})();<\/script>',
  ].join('\n').replace('WEEKLABEL', periods[LASTCOL - 1].label);
  const commentCss = [
    '#fabBtn{position:fixed;right:22px;bottom:22px;z-index:60;background:var(--head);color:#fff;border:none;border-radius:999px;padding:13px 20px;font:600 14px/1 "Segoe UI",system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.18);cursor:pointer}',
    '#fabBtn:hover{background:var(--head2)}',
    '#fabPanel{display:none;position:fixed;right:22px;bottom:78px;z-index:60;width:330px;max-height:78vh;overflow:auto;flex-direction:column;gap:9px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:15px;box-shadow:0 14px 40px rgba(0,0,0,.18)}',
    '#fabPanel label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;flex:1}',
    '#fabPanel input,#fabPanel textarea{font:14px/1.45 "Segoe UI",system-ui,sans-serif;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);width:100%}',
    '.fabHead{display:flex;justify-content:space-between;align-items:center;font-size:15px}',
    '.fabHead button{background:none;border:none;font-size:20px;line-height:1;cursor:pointer;color:var(--muted)}',
    '.fabTabs{display:flex;gap:6px}',
    '.fabTab{flex:1;padding:7px;border:1px solid var(--border);background:var(--bg);border-radius:8px;font:600 12.5px "Segoe UI",system-ui,sans-serif;color:var(--ink2);cursor:pointer}',
    '.fabTab.on{background:var(--good-soft);border-color:var(--good);color:var(--good)}',
    '.fabRow{display:flex;gap:8px}',
    '#fabSave{background:var(--head);color:#fff;border:none;border-radius:9px;padding:10px;font:700 14px "Segoe UI",system-ui,sans-serif;cursor:pointer}',
    '#fabSave:disabled{opacity:.6}',
    '#fabMsg{font-size:12.5px;color:var(--ink2);min-height:16px}',
    '.fabListHd{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-top:4px}',
    '.fabItem{font-size:12.5px;border-top:1px solid var(--border);padding:6px 0;color:var(--ink2)}',
    '.fabItem b{display:block;font-weight:600;color:var(--ink)}',
    '.fabItem span{color:var(--muted)}',
    '@media print{#fabBtn,#fabPanel{display:none !important}}',
  ].join('\n');

  // ── Headlines ───────────────────────────────────────────────────────────
  // The doc is read in a big room now. Four lines at the top, each a number and
  // what it means; everything below is the evidence for them.
  const stillDown = breachedLW.length - fixedLW.length;
  const headlines = [
    [pct(sLW.resNet, sLW.m),
     `net resolved of the ${sLW.m.toLocaleString('en-IN')} cases that matured this week \u2014 ${wowRes >= 0 ? 'up' : 'down'} ${Math.abs(wowRes).toFixed(1)} pp on the week before, against the ${TARGET_PCT}% target. ${sLW.reopWeek} came back down in the week and a case that stays down is not counted as resolved; ${sLW.unresM} customers are still down.`,
     wowRes >= 0 ? 'good' : 'bad'],
    [stillDown.toLocaleString('en-IN'),
     `customers from LAST week are still down today. Their CSPs have gone back for only ${fixedLW.length} of ${breachedLW.length}, and ${quietCsps} of the ${trackRows.length} CSPs holding them took no new case this week at all.`,
     'bad'],
    [docAll.pend.length.toLocaleString('en-IN'),
     `refund-eligible customers (${inr(sumA(docAll.pend))}) have nothing written against them \u2014 the real backlog. Everything else unpaid has a reason recorded.`,
     docAll.pend.length ? 'bad' : 'good'],
    [stopped.length ? String(stopped.length) : 'None',
     stopped.length
       ? `CSP${stopped.length === 1 ? '' : 's'} stopped resolving at a rate luck cannot explain \u2014 ${stopped.map(x => escR(x.k)).join(', ')}. ${revived.length ? revived.length + ' came back.' : 'None came back.'}`
       : `CSP stopped resolving at a rate luck cannot explain this week${revived.length ? ', and ' + revived.length + ' came back' : ', and none came back'}.`,
     stopped.length ? 'bad' : 'good'],
  ];
  const headlineHtml = `<section class="heads">
${headlines.map(([n, txt, tone]) => `<div class="head ${tone}"><div class="headn">${n}</div><div class="headt">${txt}</div></div>`).join(NL)}
</section>`;

  // ── HTML doc ──
  const row = (label, f, cls) =>
    `<tr><td>${label}</td>` + S.map((st, i) =>
      `<td class="${i === LASTCOL ? 'tot ' : ''}${cls || ''}">${f(st)}</td>`).join('') + '</tr>';
  const cols = periods.map((pp, i) =>
    `<th${i === LASTCOL ? ' class="tot"' : ''}>${pp.key}<br><span style="font-weight:400;opacity:.85">${pp.label}</span></th>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>48-Hour TAT — Weekly Metrics Recap</title>
<style>
:root{--bg:#faf7f9;--surface:#fff;--surface2:#f4eef2;--ink:#241a21;--ink2:#5d4f58;--muted:#8a7a83;--border:#e6dce2;--accent-ink:#a30f66;--good:#1a7f37;--good-soft:#e6f4ea;--bad:#c2410c;--bad-soft:#ffe9dd;--head:#D9008D;--head2:#A3006A}
*{box-sizing:border-box}body{background:var(--bg);color:var(--ink);font:16px/1.6 "Segoe UI",system-ui,sans-serif;margin:0;padding:0 20px 64px}
.wrap{max-width:900px;margin:0 auto}header{padding:44px 0 6px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent-ink);margin:0 0 10px}
h1{font-size:clamp(24px,5vw,34px);margin:0 0 10px;letter-spacing:-.02em}
.meta{font-size:13px;color:var(--muted);margin-bottom:6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:20px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:15px 17px 12px}
.tile .label{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.tile .value{font-size:31px;font-weight:750;margin-top:6px;font-variant-numeric:tabular-nums}
.tile .note{font-size:12.5px;color:var(--ink2);margin-top:3px}
section{margin-top:34px}h2{font-size:18px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px;margin:0 0 14px}
.tablewrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border);background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:620px}
th{background:var(--head);color:#fff;font-weight:700;padding:9px 14px;text-align:right;font-size:12px;white-space:nowrap}
th:first-child{text-align:left}th.tot{background:var(--head2)}
td{padding:9px 14px;border-bottom:1px solid var(--border);color:var(--ink2);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td:first-child{text-align:left;color:var(--ink);font-weight:600;white-space:normal}
tr:last-child td{border-bottom:none}td.g{color:var(--good);font-weight:750}td.b{color:var(--bad);font-weight:750}td.tot{background:var(--surface2);font-weight:700}
details.more{margin-top:14px;border-top:1px solid var(--border);padding-top:10px}
details.more>summary{cursor:pointer;font-size:13px;font-weight:700;color:var(--accent-ink);list-style:none}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary::before{content:'▸ ';}
details.more[open]>summary::before{content:'▾ ';}
details.more section{margin-top:18px}
details.more h2{font-size:15px}
.heads{margin:20px 0 4px;display:grid;gap:10px}
.head{display:flex;gap:16px;align-items:baseline;background:var(--surface);border:1px solid var(--border);border-left:5px solid var(--muted);border-radius:10px;padding:13px 17px}
.head.good{border-left-color:var(--good)}.head.bad{border-left-color:var(--bad)}
.headn{font-size:27px;font-weight:750;font-variant-numeric:tabular-nums;min-width:112px;color:var(--ink)}
.head.good .headn{color:var(--good)}.head.bad .headn{color:var(--bad)}
.headt{font-size:14.5px;color:var(--ink2);line-height:1.5}
.pillmg{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--good-soft);color:var(--good);font-size:11px;font-weight:700}\n${commentCss}\n.notes{border-top:1px solid var(--border);margin-top:40px;padding-top:14px;font-size:12.5px;color:var(--muted)}
</style></head><body><div class="wrap">
<header>
<p class="eyebrow">HP Customer Tracker · 48-Hour TAT Flag</p>
<h1>Weekly metrics recap</h1>
<p class="meta">Generated ${fmtD(NOW)} ${new Date(NOW + IST).getUTCFullYear()} · matured cases only (completed their full 48-hour window) · auto-refreshed every Monday</p>
<div style="background:var(--good-soft);border:1px solid var(--good);border-radius:10px;padding:12px 16px;margin-top:14px;font-size:14.5px">
🎯 <b>Target: ${TARGET_PCT}% net resolved.</b>
This week resolved <b>${pct(sLW.res, sLW.m)}</b>, net resolved <b>${pct(sLW.resNet, sLW.m)}</b> &middot; since launch resolved <b>${pct(sTD.res, sTD.m)}</b>, net resolved <b>${pct(sTD.resNet, sTD.m)}</b> — ${(TARGET_PCT - sTD.resNet / sTD.m * 100) > 0 ? `<b style="color:var(--bad)">${(TARGET_PCT - sTD.resNet / sTD.m * 100).toFixed(1)} pp to go</b>` : '<b style="color:var(--good)">target met</b>'}.
</div>
<div class="tiles">
<div class="tile"><div class="label">Net resolved</div><div class="value" style="color:var(--good)">${sLW.resNet.toLocaleString('en-IN')} (${pct(sLW.resNet, sLW.m)})</div><div class="note">of the ${sLW.m.toLocaleString('en-IN')} cases that matured in ${periods[LW].label} &middot; resolved ${sLW.res.toLocaleString('en-IN')} (${pct(sLW.res, sLW.m)}) in all, ${(sLW.res - sLW.w48g).toLocaleString('en-IN')} of them late &middot; ${sLW.reopWeek} came back down in the week &middot; since launch ${pct(sTD.resNet, sTD.m)}</div></div>
<div class="tile"><div class="label">Unresolved</div><div class="value" style="color:var(--bad)">${sLW.unresM.toLocaleString('en-IN')} (${pct(sLW.unresM, sLW.m)})</div><div class="note">still down when the 48 hrs ran out &middot; of those, <b>${sLW.cameBack}</b> came back on later &middot; since launch ${sTD.unresM.toLocaleString('en-IN')} (${pct(sTD.unresM, sTD.m)})</div></div>
<div class="tile"><div class="label">Cases matured last week</div><div class="value">${sLW.m.toLocaleString('en-IN')}</div><div class="note">crossed the 48-hr mark in ${periods[LW].label} &middot; <b>${addedLW} added</b> that week &middot; since launch ${addedTD.toLocaleString('en-IN')} added, avg <b>~${avgPerDay}/day</b></div></div>
<div class="tile" style="border-color:var(--bad)"><div class="label">Refund pending</div><div class="value" style="color:var(--bad)">${inr(grp['Refund pending \u2014 no reason recorded'] ? grp['Refund pending \u2014 no reason recorded'].amt : 0)}</div><div class="note"><b>${grp['Refund pending \u2014 no reason recorded'] ? grp['Refund pending \u2014 no reason recorded'].n : 0} cases (${pct(grp['Refund pending \u2014 no reason recorded'] ? grp['Refund pending \u2014 no reason recorded'].n : 0, E)})</b> of the ${E} refund-eligible, not yet paid</div></div>
<div class="tile" style="border-color:var(--good)"><div class="label">Refunded to eligible customers</div><div class="value" style="color:var(--good)">${inr(sumA(eligPaid))}</div><div class="note"><b>${eligPaid.length} cases (${pct(eligPaid.length, E)})</b> of the ${E} refund-eligible &middot; <b>${periods[LW].key}: ${sLW.eligPaidN} (${inr(sLW.eligPaidAmt)})</b></div></div>
<div class="tile" style="border-color:var(--accent-ink)"><div class="label">Reopened</div><div class="value" style="color:var(--accent-ink)">${sLW.reopWeek} (${pct(sLW.reopWeek, sLW.w48g)})</div><div class="note">resolutions that came back down in ${periods[LW].label}, of the ${sLW.w48g} net resolved &middot; since launch ${sTD.reopWeek}</div></div>
<div class="tile"><div class="label">Week-over-week</div><div class="value" style="color:${wowRes >= 0 ? 'var(--good)' : 'var(--bad)'}">${wowRes >= 0 ? '+' : ''}${wowRes.toFixed(1)} pp</div><div class="note">Net resolved: <b>${pct(sWB.resNet, sWB.m)}</b> (${wbLabel}) → <b>${pct(sLW.resNet, sLW.m)}</b> (${lwLabel}) &middot; ${wowPooled >= 0 ? '+' : ''}${wowPooled.toFixed(1)} pp against the previous two weeks pooled, which is the comparison the tracker's tab makes</div></div>
</div>
</header>
${aiHtml}
<section>
<h2>Week-wise numbers</h2>
<p class="sub">Counted in the week each case's 48-hour window closed. <b>Resolved</b> is the overall rate, whenever the case was closed. <b>Net resolved</b> is the cases resolved within the promise window that are still resolved: a case that came back down and stayed down is not counted. Net is what every headline on this page carries, and every column including the earlier weeks is on that basis, so the trend is like-for-like. Cases maturing after ${cutLabel} are not in yet.</p>
<div class="tablewrap"><table>
<thead><tr><th>Metric</th>${cols}</tr></thead>
<tbody>
${row('<b>Cases matured — crossed 48 hrs</b>', s => s.m.toLocaleString('en-IN'))}
${row('Resolved', s => s.res.toLocaleString('en-IN') + ' (' + pct(s.res, s.m) + ')')}
${row('<span style="font-weight:400;color:var(--muted)">— of those, resolved late</span>', s => '<span style="color:var(--muted)">' + (s.res - s.w48g).toLocaleString('en-IN') + ' (' + pct(s.res - s.w48g, s.m) + ')</span>')}
${row('<b>Net resolved</b> <span style="font-weight:400;color:var(--muted)">(resolved within the promise window and still resolved = Resolved minus the row above)</span>', s => s.resNet.toLocaleString('en-IN') + ' (' + pct(s.resNet, s.m) + ')', 'g')}
${row('<b>Reopened</b> <span style="font-weight:400;color:var(--muted)">(came back down in this week)</span>', s => s.reopWeek + ' (' + pct(s.reopWeek, s.w48g) + ')', 'b')}
${row('<b>Unresolved</b>', s => s.unresM.toLocaleString('en-IN') + ' (' + pct(s.unresM, s.m) + ')', 'b')}
${row('— of those, the line came back on later', s => s.cameBack.toLocaleString('en-IN') + ' (' + pct(s.cameBack, s.unresM) + ')')}
${row('<b>Refund-eligible</b> <span style="font-weight:400;color:var(--muted)">(still down, no ping since the complaint)</span>', s => s.elig.toLocaleString('en-IN') + ' (' + pct(s.elig, s.m) + ')', 'b')}
${row('Customers refunded <span style="font-weight:400;color:var(--muted)">(of those eligible)</span>', s => s.eligPaidN.toLocaleString('en-IN') + ' (' + pct(s.eligPaidN, s.elig) + ')', 'g')}
${row('<b>Average amount paid to a customer</b>', s => (s.eligPaidN ? inr(s.eligPaidAmt / s.eligPaidN) : '—'))}
${row('<b>Total amount refunded to eligible customers</b>', s => inr(s.eligPaidAmt), 'g')}
${row('Refunds paid on cases that had already recovered', s => s.recPaidN.toLocaleString('en-IN') + ' (' + inr(s.recPaidAmt) + ')')}
${row('CSPs contributing to the unresolved cases', s => s.csps.toLocaleString('en-IN'))}
</tbody></table></div>
<p class="sub" style="margin-top:10px">A further ${S.slice(0, 3).map(x => x.intake).join(' / ')} cases (Week 3 / Week 2 / Week 1) arrived already reopened in Kapture. That is an intake label, not a resolution of ours that came back, so it is excluded from the reopened rate above.</p>
${(() => {
  // Age at resolution (Shariq, 6 Oct): hours from the case entering the
  // tracker to the resolving remark, for every resolved case in each column.
  const hrsOf = c => { const st = startTs(c), rt = Number(c.remarks_updated_at) || 0; if (rt > 0 && st > 0) return (rt - st) / 3600000; const md = parseDate(c.migration_date); return md ? (md.getTime() + 86399000 - st) / 3600000 : null; };
  const BANDS = [['\u2264 24 hrs', 0, 24], ['24 \u2013 48 hrs', 24, 48], ['48 \u2013 52 hrs', 48, 52], ['52 \u2013 72 hrs', 52, 72], ['72 \u2013 96 hrs', 72, 96], ['96 hrs +', 96, 1e9]];
  const cols = periods.map(pp => inRange(pp).filter(c => getStatus(c) !== 'Unresolved').map(hrsOf).filter(h => h !== null));
  const cell = (list, lo, hi) => { const n = list.filter(h => h >= lo && h < hi).length; return `<td>${n.toLocaleString('en-IN')} <span style="color:var(--muted)">(${pct(n, list.length)})</span></td>`; };
  const med = list => { if (!list.length) return '\u2014'; const a = [...list].sort((x, y) => x - y); return a[Math.floor(a.length / 2)].toFixed(1) + ' hrs'; };
  return `<p class="sub" style="margin-top:14px"><b>Age at resolution</b> \u2014 hours from the case entering the tracker to the resolving remark, for the resolved cases in each column.</p>
<div class="tablewrap"><table>
<thead><tr><th>Hours to resolution</th>${periods.map(pp => `<th>${pp.key}<br><span style="font-weight:400;font-size:12px">${pp.label}</span></th>`).join('')}</tr></thead>
<tbody>
${BANDS.map(([lab, lo, hi]) => `<tr><td style="text-align:left">${lab}</td>${cols.map(l => cell(l, lo, hi)).join('')}</tr>`).join('\n')}
<tr><td style="text-align:left"><b>Resolved cases</b></td>${cols.map(l => `<td><b>${l.length.toLocaleString('en-IN')}</b></td>`).join('')}</tr>
<tr><td style="text-align:left">Median</td>${cols.map(l => `<td>${med(l)}</td>`).join('')}</tr>
</tbody></table></div>
`;
})()}
</section>
${reopSnapHtml}
${refundsHtml()}
${whyHtml}
${stoppedHtml}
${cityHtml}
<div class="notes">Source: live Firebase behind hp-customer-tracker-production-a471.up.railway.app. Resolution per the tracker's own status logic; timing proxied from the remark timestamp. Refund pending = refund-eligible, not refunded, and no reason recorded; amounts pro-rata on the plan days left, or the Wiom Hub amount where it paid. Weeks are Monday-anchored (Mon–Sun, IST) and cohorted by the week a case matured, which is how the tracker's Weekly Review tab counts; the window closes at the moment the doc is generated, so cases that matured today are in. A reopen is a resolution of ours that came back down, as stamped by the tracker (reopened_at), counted in the week it came back. Net resolved = resolved within the promise window and still resolved; a case that came back down and stayed down is not counted. Every refund figure on this page is on the same matured-up-to-yesterday cohort as the week-wise table, and a case counts as refunded when Wiom Hub, the Finance sheet or the tracker says so.</div>
</div>
${commentBox}
${commentScript}
</body></html>`;

  const outPath = path.join(__dirname, '..', 'recap.html');
  // Park the figures the dashboard cannot compute itself (they need Metabase)
  // so the in-tracker Weekly Review tab can show bonus per CSP.
  try {
    const snap = { generated_at: NOW, cycles: PAY_CYCLES.map(c => c[0]), bonus: {} };
    if (cspPay) Object.entries(cspPay).forEach(([k, v]) => {
      snap.bonus[k] = { c0: v.cyc[0], c1: v.cyc[1], lastWhen: v.lastWhen, lastRs: v.lastRs };
    });
    await fetch(FIREBASE_DB + '/cases/__snapshot__.json', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snap),
    }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    console.log('snapshot written for', Object.keys(snap.bonus).length, 'CSPs');
  } catch (e) { console.error('snapshot write failed (non-fatal):', e.message); }

  fs.writeFileSync(outPath, html);
  console.log('recap.html written:', html.length, 'bytes');

  // ── Slack DM ──
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { console.log('SLACK_BOT_TOKEN not set — skipping DM.'); return; }
  const text =
    `📊 *48h TAT — Weekly Recap* (${lwLabel}) — full funnel\n` +
    `• Received since 29 Jul: *${sTD.n.toLocaleString('en-IN')}* → matured ${sTD.m.toLocaleString('en-IN')} → resolved *${sTD.res.toLocaleString('en-IN')}* (${pct(sTD.res, sTD.m)}) → net resolved *${sTD.resNet.toLocaleString('en-IN')}* (${pct(sTD.resNet, sTD.m)}) → breached ${breached.length} (${pct(breached.length, sTD.m)})\n` +
    `• Last week: *${pct(sLW.resNet, sLW.m)}* net resolved vs ${pct(sWB.resNet, sWB.m)} the week before (${wowRes >= 0 ? '+' : ''}${wowRes.toFixed(1)} pp)\n` +
    `• Refund on breached: done ${breachedDone.length} (${inr(breachedDoneAmt)}) · pending *${breachedPend.length}* (*${inr(breachedPendAmt)}*)\n` +
    `• Reopened: *${reopensAllTime}* in the tracker all-time, ${reopens.length} since launch, ${sTD.reopWeek} of them since-launch resolutions that came back · top reason: ${reopReasons[0] ? reopReasons[0][0] + ' (' + reopReasons[0][1] + ')' : '—'} · re-resolved & PFT-confirmed ${reopPftDone}, still open ${reopStillOpen}\n` +
    `🎯 Target: ${TARGET_PCT}% net resolved — this week ${pct(sLW.resNet, sLW.m)}, since launch ${pct(sTD.resNet, sTD.m)}${(TARGET_PCT - sTD.resNet / sTD.m * 100) > 0 ? ' (' + (TARGET_PCT - sTD.resNet / sTD.m * 100).toFixed(1) + ' pp to go)' : ' — met ✅'}\n` +
    `📄 Full funnel doc: ${DOC_URL}`;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + token },
    body: JSON.stringify({
      channel: SLACK_USER,
      username: "Shariq's Slack Agent",
      icon_url: 'https://raw.githubusercontent.com/shariqkhan-ui/hp-customer-tracker/master/shariq-agent.jpg',
      text,
    }),
  }).then(r => r.json());
  if (res.ok) console.log('Slack DM sent to', SLACK_USER);
  else console.error('Slack DM FAILED:', res.error, res.needed || '');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
