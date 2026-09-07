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
const IST = 5.5 * 3600000;
const SLACK_USER = 'U04TL31PC1Y'; // Shariq
const DOC_URL = 'https://shariqkhan-ui.github.io/hp-customer-tracker/recap.html';
// Field team's reopen-RCA sheet (CX/CSP remarks + last ping per reopened ticket)
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
  SELECT pb.partner_name, COALESCE(t.reason, 'Not categorised') AS reason, COUNT(*) AS n,
         COUNT_IF(t.status ILIKE 'Pending') AS open_n, COUNT_IF(t.status ILIKE 'Complete') AS closed_n
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
    r.data.rows.forEach(([name, reason, n, openN, closedN]) => {
      const k = normName(name);
      if (!k) return;
      (map[k] = map[k] || []).push({ reason, n: Number(n) || 0, open: Number(openN) || 0, closed: Number(closedN) || 0 });
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
// Router pinged AFTER the complaint -> the line came back, nothing owed.
const pingedAfter = c => Number(c.last_ping_at) > 0 && Number(c.last_ping_at) > startTs(c);
function resolvedWithin48(c) {
  if (getStatus(c) === 'Unresolved') return false;
  const s = startTs(c), rt = Number(c.remarks_updated_at) || 0;
  if (rt > 0) return (rt - s) <= LIM;
  const md = parseDate(c.migration_date);
  if (md) return (md.getTime() + 86399000 - s) <= LIM;
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
  // Finance-sheet match by Kapture ticket OR the customer's registered number
  const sheetEntry = c => (sheet && sheet[dig(c.ticket_no)]) ||
    (sheetMob && sheetMob[dig(c.mobile).slice(-10)]) || null;
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
  const CUT = istMidnight; // start of today — cases received up to yesterday
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
  const allSlices = [];
  for (let t = LAUNCH; t < NOW; t += 86400000) {
    const sl = sliceOf(t);
    if (!allSlices.some(x => x.id === sl.id)) allSlices.push(sl);
  }
  const doneSlices = allSlices.filter(x => x.to <= CUT).slice(-3);
  // The 4th column is the CURRENT week slice so far — not month-to-date.
  const cur = sliceOf(NOW);
  const periods = doneSlices.concat([
    { key: cur.key, from: cur.from, to: CUT },
    { key: 'Since launch', from: LAUNCH, to: CUT },
  ]);
  periods.forEach(pp => { pp.to = Math.min(pp.to, CUT); pp.label = fmtD(pp.from) + ' – ' + fmtD(pp.to - 1); });
  const LASTCOL = periods.length - 1;
  const ptl = await ptlCallsByPartner(periods);
  const ptlWhy = await ptlReasonsByPartner(LAUNCH, CUT);
  era = era.filter(c => startTs(c) < CUT);

  // A reopen is a case WE marked resolved that came back down (reopened_at).
  // source='reopened-cron' is an INTAKE label — Kapture already showed the
  // ticket reopened when the cron pulled it in — and counting it here inflated
  // the rate ~7x. It is reported separately instead.
  const reopTs = c => Number(c.reopened_at) || 0;
  const isReop = c => reopTs(c) > 0;
  const amtOf = c => (c.refund_amount !== '' && c.refund_amount != null && !isNaN(Number(c.refund_amount))) ? Number(c.refund_amount) : (sheetEntry(c) ? Number(sheetEntry(c).a) || 0 : 0);
  const isDone = c => !!sheetEntry(c) || trim(c.cx_action) === 'Refund Done' || trim(c.refund_action) === 'Refund Done';
  const cameInAsReopen = c => String(c.source) === 'reopened-cron';
  const RES_REMARKS = ['resolved by old partner', 'resolved by old csp'];
  const isResRemark = c => RES_REMARKS.includes(trim(c.remarks).toLowerCase()) || trim(c.migration_date) !== '';
  const stats = list => {
    const matured = list.filter(isMatured);
    const m = matured.length;
    // NET of reopened: resolutions later reopened don't count
    const w48 = matured.filter(c => resolvedWithin48(c) === true && !isReop(c)).length;
    const w48g = matured.filter(c => resolvedWithin48(c) === true).length; // gross
    const unresM = matured.filter(c => getStatus(c) === 'Unresolved').length;
    const late = matured.filter(c => getStatus(c) !== 'Unresolved' && resolvedWithin48(c) !== true).length;
    const resolvedAll = list.filter(c => getStatus(c) !== 'Unresolved').length;
    const pend = matured.filter(c => getStatus(c) === 'Unresolved' && !sheetEntry(c) && trim(c.cx_action) !== 'Refund Done');
    const pendAmt = pend.reduce((a, c) => a + (Number(c.refund_amount) || 0), 0);
    const done = list.filter(c => sheetEntry(c) || trim(c.cx_action) === 'Refund Done');
    const doneAmt = done.reduce((a, c) => a + amtOf(c), 0);
    // Breached-scoped refund done — THE refund-done metric everywhere (matches
    // the funnel's Refund stage); doneN/doneAmt keep the all-in count for notes.
    const doneBrL = matured.filter(c => getStatus(c) === 'Unresolved' && (sheetEntry(c) || trim(c.cx_action) === 'Refund Done'));
    const doneBrAmt = doneBrL.reduce((a, c) => a + amtOf(c), 0);
    // Refund-eligible = breached AND the router never pinged again.
    const eligL = matured.filter(c => getStatus(c) === 'Unresolved' && !pingedAfter(c));
    const paidL = done.filter(c => amtOf(c) > 0);
    const paidAmt = paidL.reduce((a, c) => a + amtOf(c), 0);
    const eligPaidL = eligL.filter(c => sheetEntry(c) || trim(c.cx_action) === 'Refund Done' || trim(c.refund_action) === 'Refund Done');
    const eligPaidAmt = eligPaidL.reduce((a, c) => a + amtOf(c), 0);
    const cspSet = new Set(matured.filter(c => getStatus(c) === 'Unresolved').map(c => trim(c.partner) || '(unknown)'));
    return { n: list.length, m, w48, w48g, unresM, late, resolvedAll, pendN: pend.length, pendAmt, doneN: done.length, doneAmt, doneBr: doneBrL.length, doneBrAmt,
      elig: eligL.length, paidN: paidL.length, paidAmt, csps: cspSet.size,
      eligPaidN: eligPaidL.length, eligPaidAmt };
  };
  // ── Funnel extras (till date) ─────────────────────────────────────────────
  const countBy = (list, keyFn) => {
    const map = {};
    list.forEach(c => { const k = keyFn(c) || '(no remark yet)'; map[k] = (map[k] || 0) + 1; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  };
  const maturedTD = era.filter(isMatured);
  const breached = maturedTD.filter(c => getStatus(c) === 'Unresolved');
  const unresReasons = countBy(breached, c => trim(c.remarks));
  const breachedDone = breached.filter(c => sheetEntry(c) || trim(c.cx_action) === 'Refund Done');
  const breachedDoneAmt = breachedDone.reduce((a, c) => a + amtOf(c), 0);
  const breachedPend = breached.filter(c => !sheetEntry(c) && trim(c.cx_action) !== 'Refund Done');
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
          iCsp = col('csp remarks'), iPing = col('last ping time'), iG = col('ground remarks');
    const rows = sh.slice(1).filter(r => trim(r[iT]));
    const ledgerRows = rows.map(r =>
      `<tr><td>${escH(trim(r[iT]))}</td><td>${escH(trim(r[iM]))}</td><td>${escH(trim(r[iC]))}</td><td style="white-space:normal">${escH(trim(r[iCx]) || '—')}</td><td style="white-space:normal">${escH(trim(r[iCsp]) || '—')}</td><td style="white-space:normal">${escH(trim(r[iG]) || '—')}</td><td>${escH(trim(r[iPing]) || '—')}</td></tr>`
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
<thead><tr><th>Ticket No</th><th>Mobile</th><th>CSP</th><th style="text-align:left">CX Remarks</th><th style="text-align:left">CSP Remarks</th><th style="text-align:left">Ground Remarks</th><th>Last Ping Time</th></tr></thead>
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
  let cspRca = '';
  try {
    const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const rcaByCsp = {};
    try {
      const csv2 = await fetch('https://docs.google.com/spreadsheets/d/1cXCnazjjLfzxG4-Uyr9nrGGo4qgGbbQ-zjFZ6xG_9vk/gviz/tq?tqx=out:csv&sheet=CSP%20RCA', { redirect: 'follow' }).then(r => r.text());
      const sh2 = parseCSVText(csv2);
      const S2 = sh2[0].map(h => h.trim().toLowerCase());
      const iC = S2.findIndex(h => h === 'csp'), iR = S2.findIndex(h => h.startsWith('pending reason')), iSt = S2.findIndex(h => h.startsWith('current status'));
      if (iC >= 0 && iR >= 0) sh2.slice(1).forEach(r => {
        const k = normName(r[iC]);
        if (k) rcaByCsp[k] = { reason: trim(r[iR]), status: iSt >= 0 ? trim(r[iSt]) : '' };
      });
    } catch (e2) { console.error('CSP RCA tab not readable (non-fatal):', e2.message); }
    const brByCsp = {}, totByCsp = {};
    era.forEach(c => { const p = trim(c.partner) || '(unknown)'; totByCsp[p] = (totByCsp[p] || 0) + 1; });
    breached.forEach(c => { const p = trim(c.partner) || '(unknown)'; brByCsp[p] = (brByCsp[p] || 0) + 1; });
    const top = Object.entries(brByCsp).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([p, n]) => ({ p, n, t: totByCsp[p] || n }))
      .sort((a, b) => b.n / b.t - a.n / a.t);
    const anyRca = Object.keys(rcaByCsp).length > 0;
    cspRca = `<section>
<h2>CSP ticket breach &amp; resolution status — top 10</h2>
<p class="sub">Top 10 CSPs by breached (unresolved past 48 hrs) cases, worst breach rate first. Calls at PTL = that CSP's calls on the PartnerSupportQueue since 29 Jul; PTL tickets shows how many of the tickets those calls raised are still open (Pending) versus closed (Complete); why they called = the top reasons on those tickets (Ameyo's own disposition is 88% untagged, so it is unusable). Pending reason &amp; current status maintained by the ground team in the <a href="https://docs.google.com/spreadsheets/d/1cXCnazjjLfzxG4-Uyr9nrGGo4qgGbbQ-zjFZ6xG_9vk/edit" style="color:var(--accent-ink)">CSP RCA tab</a>.${anyRca ? '' : ' <b>Tab has no entries yet — team to fill CSP | Pending Reason | Current Status.</b>'}</p>
<div class="tablewrap"><table style="min-width:900px">
<thead><tr><th>CSP</th><th>Breached</th><th>Total cases</th><th>Breach rate</th><th>Calls at PTL</th><th>PTL tickets<br><span style="font-weight:400;opacity:.85">open / closed</span></th><th style="text-align:left">Why they called</th><th style="text-align:left">Pending reason</th><th style="text-align:left">Current status</th></tr></thead>
<tbody>
${top.map(c => {
  const e = rcaByCsp[normName(c.p)] || {};
  const rate = Math.round(c.n / c.t * 100);
  const calls = ptl && ptl[normName(c.p)] ? ptl[normName(c.p)][LASTCOL] : null;
  return `<tr><td>${c.p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td><td>${c.n}</td><td>${c.t}</td><td${rate >= 50 ? ' class="b"' : ''}>${rate}%</td><td>${calls == null ? '—' : calls.toLocaleString('en-IN')}</td><td>${(() => {
    const w = ptlWhy && ptlWhy[normName(c.p)];
    if (!w || !w.length) return '—';
    const o = w.reduce((a, x) => a + x.open, 0), cl = w.reduce((a, x) => a + x.closed, 0);
    return `<span class="${o ? 'b' : ''}">${o}</span> / ${cl}`;
  })()}</td><td style="text-align:left;white-space:normal;font-weight:400">${(() => {
    const w = ptlWhy && ptlWhy[normName(c.p)];
    if (!w || !w.length) return '—';
    return w.slice(0, 2).map(x => `${x.reason.replace(/</g, '&lt;')} (${x.n})`).join('<br>');
  })()}</td><td style="text-align:left;white-space:normal">${(e.reason || '—').replace(/</g, '&lt;')}</td><td style="text-align:left;white-space:normal">${(e.status || '—').replace(/</g, '&lt;')}</td></tr>`;
}).join('\n')}
<tr><td class="tot"><b>Top 10 together</b></td><td class="tot b"><b>${top.reduce((a, c) => a + c.n, 0)}</b></td><td class="tot">${top.reduce((a, c) => a + c.t, 0)}</td><td class="tot"><b>${pct(top.reduce((a, c) => a + c.n, 0), breached.length)} of breached</b></td><td class="tot"><b>${ptl ? top.reduce((a, c) => a + (ptl[normName(c.p)] ? ptl[normName(c.p)][LASTCOL] : 0), 0).toLocaleString('en-IN') : '—'}</b></td><td class="tot" colspan="4"></td></tr>
</tbody></table></div>
</section>`;
  } catch (e) {
    console.error('CSP RCA section failed (non-fatal):', e.message);
    cspRca = '';
  }
  const inRange = (r) => era.filter(c => { const t = startTs(c); return t >= r.from && t < r.to; });
  // Reopens are an EVENT: counted in the week they came back, against the
  // resolutions marked in that same week.
  function reopStats(r) {
    const back = era.filter(c => { const t = reopTs(c); return t >= r.from && t < r.to; });
    const resMarked = era.filter(c => { const t = Number(c.remarks_updated_at) || 0; return t >= r.from && t < r.to && isResRemark(c); });
    const intake = era.filter(c => { const t = startTs(c); return t >= r.from && t < r.to && cameInAsReopen(c); });
    return { reopWeek: back.length, resWeek: resMarked.length, intake: intake.length };
  }
  const S = periods.map(pp => Object.assign(stats(inRange(pp)), reopStats(pp)));

  // "Last week" is the week that just ended for the review — the current
  // slice up to yesterday (index 3), not the last fully-closed calendar slice.
  const LW = LASTCOL - 1;
  const sWB = S[LW - 1];     // the week before it
  const sLW = S[LW];         // last week
  const sTD = S[LASTCOL];    // since launch

  const wowRes = (sLW.m && sWB.m) ? (sLW.w48 / sLW.m - sWB.w48 / sWB.m) * 100 : 0;
  const avgPerDay = Math.round(sTD.n / Math.max(1, Math.ceil((NOW - LAUNCH) / 86400000)));
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
  const maturedAll = era.filter(isMatured);
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
  const grp = { 'Nothing payable': { n: 0, amt: 0, sub: {} }, 'Still owed to the customer': { n: 0, amt: 0, sub: {} } };
  eligUnpaid.forEach(c => {
    const k = raEffective(c);
    const g = NOTHING.includes(k) ? 'Nothing payable' : 'Still owed to the customer';
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
${['Nothing payable', 'Still owed to the customer'].map(g => {
  const t = grp[g];
  if (!t || !t.n) return '';
  return `<tr><td style="padding-left:38px"><b>${g}</b></td><td><b>${t.n.toLocaleString('en-IN')}</b></td><td><b>${pct(t.n, E)}</b></td><td>${inr(t.amt)}</td><td></td></tr>` + NL +
    Object.entries(t.sub).sort((x, y) => y[1].n - x[1].n).map(([k, v]) =>
      `<tr><td style="padding-left:64px;font-weight:400">${escR(k)}</td><td>${v.n.toLocaleString('en-IN')}</td><td>${pct(v.n, E)}</td><td>${inr(v.amt)}</td><td style="text-align:left;font-weight:400">${subNote(k)}</td></tr>`).join(NL);
}).join(NL)}
</tbody></table></div>

<h2 style="margin-top:26px;font-size:15px">All refunds paid, including cases that recovered</h2>
<p class="sub">The funnel above follows only customers who are still down. Money also went to cases that came back up before or after payment; this is every refund paid on a matured case, so the first line here is the full amount that left the business.</p>
<div class="tablewrap"><table>
<thead><tr><th style="text-align:left">Refunded customers</th><th>Cases</th><th>Amount</th><th style="text-align:left">Where they sit now</th></tr></thead>
<tbody>
<tr><td><b>All refunds paid on matured cases</b></td><td><b>${isDoneAll.length.toLocaleString('en-IN')}</b></td><td><b>${inr(sumA(isDoneAll))}</b></td><td style="text-align:left;font-weight:400"></td></tr>
<tr><td style="padding-left:34px;font-weight:400">&#8627; Refund-eligible, still down</td><td>${eligPaid.length.toLocaleString('en-IN')}</td><td>${inr(sumA(eligPaid))}</td><td style="text-align:left;font-weight:400">The &ldquo;Refunded&rdquo; line in the funnel above</td></tr>
<tr><td style="padding-left:34px;font-weight:400">&#8627; Unresolved, but the line pinged back</td><td>${donePinged.length.toLocaleString('en-IN')}</td><td>${inr(sumA(donePinged))}</td><td style="text-align:left;font-weight:400">Paid, then the connection recovered</td></tr>
<tr><td style="padding-left:34px;font-weight:400">&#8627; Case resolved by the time it was paid</td><td>${doneResolved.length.toLocaleString('en-IN')}</td><td>${inr(sumA(doneResolved))}</td><td style="text-align:left;font-weight:400">Refunded on a case that had already closed</td></tr>
</tbody></table></div>
</section>`;

  // ── Last meeting's action items ───────────────────────────────────────────
  // Live from the tracker's Action Items tab — nothing typed by hand.
  const escA = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const aiItems = Object.entries(aiRaw || {}).filter(([, v]) => v && v.item)
    .sort((a, b) => (a[1].created_at || 0) - (b[1].created_at || 0));
  const aiHtml = `<section>
<h2>Action items from the last meeting</h2>
<p class="sub">Taken one by one, in the order they were raised. Status is live from the tracker's Action Items tab.</p>
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
).join(String.fromCharCode(10)) : '<tr><td colspan="6" style="text-align:left">No action items recorded for this cycle.</td></tr>'}
</tbody></table></div>
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
.notes{border-top:1px solid var(--border);margin-top:40px;padding-top:14px;font-size:12.5px;color:var(--muted)}
</style></head><body><div class="wrap">
<header>
<p class="eyebrow">HP Customer Tracker · 48-Hour TAT Flag</p>
<h1>Weekly metrics recap</h1>
<p class="meta">Generated ${fmtD(NOW)} ${new Date(NOW + IST).getUTCFullYear()} · matured cases only (completed their full 48-hour window) · auto-refreshed every Monday</p>
<div style="background:var(--good-soft);border:1px solid var(--good);border-radius:10px;padding:12px 16px;margin-top:14px;font-size:14.5px">
🎯 <b>Target: ${TARGET_PCT}% resolution within 48 hrs by end of August.</b>
Currently at <b>${pct(sTD.w48, sTD.m)}</b> — ${(TARGET_PCT - sTD.w48 / sTD.m * 100) > 0 ? `<b style="color:var(--bad)">${(TARGET_PCT - sTD.w48 / sTD.m * 100).toFixed(1)} pp to go</b>` : '<b style="color:var(--good)">target met</b>'}.
</div>
<div class="tiles">
<div class="tile"><div class="label">Resolution within 48 hrs</div><div class="value" style="color:var(--good)">${pct(sTD.w48, sTD.m)}</div><div class="note">${sTD.w48} of ${sTD.m} matured · till date · <b>last week (${lwLabel}): ${pct(sLW.w48, sLW.m)}</b> · target ${TARGET_PCT}%</div></div>
<div class="tile"><div class="label">Unresolved matured tickets</div><div class="value" style="color:var(--bad)">${pct(sTD.unresM, sTD.m)}</div><div class="note">${sTD.unresM} of ${sTD.m} matured still unresolved past 48 hrs · <b>last week: ${pct(sLW.unresM, sLW.m)}</b></div></div>
<div class="tile"><div class="label">Cases added since 29 Jul</div><div class="value">${sTD.n.toLocaleString('en-IN')}</div><div class="note">avg <b>~${avgPerDay} tickets/day</b> · ${sTD.m.toLocaleString('en-IN')} matured · ${(sTD.n - sTD.m).toLocaleString('en-IN')} in window · <b>last week: ${sLW.n} added</b></div></div>
<div class="tile" style="border-color:var(--bad)"><div class="label">Refund pending (&gt;48 hrs unresolved)</div><div class="value" style="color:var(--bad)">${inr(sTD.pendAmt)}</div><div class="note">${sTD.pendN} breached open cases owe a pro-rata refund · <b>last week cohort: ${sLW.pendN} (${inr(sLW.pendAmt)})</b></div></div>
<div class="tile" style="border-color:var(--good)"><div class="label">Refund done</div><div class="value" style="color:var(--good)">${inr(sTD.doneBrAmt)}</div><div class="note">${sTD.doneBr} of ${sTD.unresM} breached refunded (${pct(sTD.doneBr, sTD.unresM)}) · <b>last week cohort: ${sLW.doneBr} (${inr(sLW.doneBrAmt)})</b> · all-in incl. later-resolved: ${sTD.doneN} (${inr(sTD.doneAmt)})</div></div>
<div class="tile" style="border-color:var(--accent-ink)"><div class="label">Reopened % of resolved</div><div class="value" style="color:var(--accent-ink)">${pct(reopens.length, resolvedAllTD)}</div><div class="note"><b>${reopens.length} reopens</b> of ${resolvedAllTD.toLocaleString('en-IN')} cases resolved since 29 Jul · <b>last week: ${sLW.w48g - sLW.w48} reopens (${pct(sLW.w48g - sLW.w48, sLW.w48g)})</b></div></div>
<div class="tile"><div class="label">Week-over-week</div><div class="value" style="color:${wowRes >= 0 ? 'var(--good)' : 'var(--bad)'}">${wowRes >= 0 ? '+' : ''}${wowRes.toFixed(1)} pp</div><div class="note">Resolved within 48 hrs: <b>${pct(sWB.w48, sWB.m)}</b> (${wbLabel}) → <b>${pct(sLW.w48, sLW.m)}</b> (${lwLabel})</div></div>
</div>
</header>
${aiHtml}
<section>
<h2>Week-wise numbers</h2>
<p class="sub">Weeks are the tracker's own buckets (1-7 / 8-14 / 15-21 / 22-end), cohorted by the date the case entered the tracker, so every row answers the same question: of the cases received in this week, what happened. Reopened is read the same way — of this week's own within-48hr resolutions, the ones that later came back down. Each cell shows the absolute number with its share in brackets. Cases received after ${cutLabel} are excluded, and every percentage is over matured cases only — those that completed their full 48-hour window.</p>
<div class="tablewrap"><table>
<thead><tr><th>Metric</th>${cols}</tr></thead>
<tbody>
${row('Cases received', s => s.n.toLocaleString('en-IN'))}
${row('Matured — past 48 hrs since being added', s => s.m.toLocaleString('en-IN') + ' (' + pct(s.m, s.n) + ')')}
${row('<b>Resolved within 48 hrs</b>', s => s.w48g.toLocaleString('en-IN') + ' (' + pct(s.w48g, s.m) + ')', 'g')}
${row('<b>Reopened</b>', s => (s.w48g - s.w48) + ' (' + pct(s.w48g - s.w48, s.w48g) + ')', 'b')}
${row('<b>Resolved within 48 hrs — net of reopened</b>', s => s.w48.toLocaleString('en-IN') + ' (' + pct(s.w48, s.m) + ')', 'g')}
${row('<b>Unresolved</b>', s => s.unresM.toLocaleString('en-IN') + ' (' + pct(s.unresM, s.m) + ')', 'b')}
${row('<b>Unresolved and eligible for refund</b> <span style="font-weight:400;color:var(--muted)">(no ping since the complaint)</span>', s => s.elig.toLocaleString('en-IN') + ' (' + pct(s.elig, s.m) + ')', 'b')}
${row('Customers refunded <span style="font-weight:400;color:var(--muted)">(of those eligible)</span>', s => s.eligPaidN.toLocaleString('en-IN') + ' (' + pct(s.eligPaidN, s.elig) + ')', 'g')}
${row('<b>Average amount paid to a customer</b>', s => (s.eligPaidN ? inr(s.eligPaidAmt / s.eligPaidN) : '—'))}
${row('<b>Total amount refunded to eligible customers</b>', s => inr(s.eligPaidAmt), 'g')}
${row('Refunds paid on cases that had already recovered', s => (s.paidN - s.eligPaidN).toLocaleString('en-IN') + ' (' + inr(s.paidAmt - s.eligPaidAmt) + ')')}
${row('CSPs contributing to the unresolved cases', s => s.csps.toLocaleString('en-IN'))}
</tbody></table></div>
<p class="sub" style="margin-top:10px">A further ${S.map(x => x.intake).slice(0, 3).join(' / ')} cases (the three completed weeks) arrived already reopened in Kapture. That is an intake label, not a resolution of ours that came back, so it is excluded from the reopened rate above.</p>
</section>
${refundFunnel}
${cspRca}
<div class="notes">Source: live Firebase behind hp-customer-tracker-production.up.railway.app. Resolution per the tracker's own status logic; timing proxied from the remark timestamp. Refund pending = breached &amp; open cases not yet refunded (Finance sheet / Cx Action), amounts auto-computed pro-rata. Weeks are the tracker's own slices (1-7 / 8-14 / 15-21 / 22-end, IST); intake cut off at the end of the most recent Saturday. A reopen is a resolution of ours that came back down (reopened_at), counted in the week it came back.</div>
</div></body></html>`;

  const outPath = path.join(__dirname, '..', 'recap.html');
  fs.writeFileSync(outPath, html);
  console.log('recap.html written:', html.length, 'bytes');

  // ── Slack DM ──
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { console.log('SLACK_BOT_TOKEN not set — skipping DM.'); return; }
  const text =
    `📊 *48h TAT — Weekly Recap* (${lwLabel}) — full funnel\n` +
    `• Received since 29 Jul: *${sTD.n.toLocaleString('en-IN')}* → matured ${sTD.m.toLocaleString('en-IN')} → resolved ≤48h (net) *${sTD.w48.toLocaleString('en-IN')}* (${pct(sTD.w48, sTD.m)}) → breached ${breached.length} (${pct(breached.length, sTD.m)})\n` +
    `• Last week: *${pct(sLW.w48, sLW.m)}* net resolution vs ${pct(sWB.w48, sWB.m)} week before (${wowRes >= 0 ? '+' : ''}${wowRes.toFixed(1)} pp)\n` +
    `• Refund on breached: done ${breachedDone.length} (${inr(breachedDoneAmt)}) · pending *${breachedPend.length}* (*${inr(breachedPendAmt)}*)\n` +
    `• Reopened: *${reopens.length}* (${pct(reopens.length, resolvedAllTD)} of resolved) · top reason: ${reopReasons[0] ? reopReasons[0][0] + ' (' + reopReasons[0][1] + ')' : '—'} · re-resolved & PFT-confirmed ${reopPftDone}, still open ${reopStillOpen}\n` +
    `🎯 Target: ${TARGET_PCT}% within-48h resolution by end of Aug — ${(TARGET_PCT - sTD.w48 / sTD.m * 100) > 0 ? (TARGET_PCT - sTD.w48 / sTD.m * 100).toFixed(1) + ' pp to go' : 'met ✅'}\n` +
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
