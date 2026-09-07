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
  const [casesRaw, sheet, sheetMob] = await Promise.all([
    fetch(FIREBASE_DB + '/cases.json').then(r => r.json()),
    fetch(FIREBASE_DB + '/refund_sheet.json').then(r => r.json()).catch(() => ({})),
    fetch(FIREBASE_DB + '/refund_sheet_mob.json').then(r => r.json()).catch(() => ({})),
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
  const CUT = istMidnight - (istNow.getUTCDay() % 7) * 86400000;
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
  const mStart = istMs(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1);
  const periods = doneSlices.concat([
    { key: 'MTD', from: mStart, to: CUT },
    { key: 'Since launch', from: LAUNCH, to: CUT },
  ]);
  periods.forEach(pp => { pp.to = Math.min(pp.to, CUT); pp.label = fmtD(pp.from) + ' – ' + fmtD(pp.to - 1); });
  const LASTCOL = periods.length - 1;
  era = era.filter(c => startTs(c) < CUT);

  // A reopen is a case WE marked resolved that came back down (reopened_at).
  // source='reopened-cron' is an INTAKE label — Kapture already showed the
  // ticket reopened when the cron pulled it in — and counting it here inflated
  // the rate ~7x. It is reported separately instead.
  const reopTs = c => Number(c.reopened_at) || 0;
  const isReop = c => reopTs(c) > 0;
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
    const doneAmt = done.reduce((a, c) => a + ((Number(c.refund_amount) || 0) || (sheetEntry(c) ? Number(sheetEntry(c).a) || 0 : 0)), 0);
    // Breached-scoped refund done — THE refund-done metric everywhere (matches
    // the funnel's Refund stage); doneN/doneAmt keep the all-in count for notes.
    const doneBrL = matured.filter(c => getStatus(c) === 'Unresolved' && (sheetEntry(c) || trim(c.cx_action) === 'Refund Done'));
    const doneBrAmt = doneBrL.reduce((a, c) => a + ((Number(c.refund_amount) || 0) || (sheetEntry(c) ? Number(sheetEntry(c).a) || 0 : 0)), 0);
    // Refund-eligible = breached AND the router never pinged again.
    const eligL = matured.filter(c => getStatus(c) === 'Unresolved' && !pingedAfter(c));
    const paidL = done.filter(c => ((Number(c.refund_amount) || 0) || (sheetEntry(c) ? Number(sheetEntry(c).a) || 0 : 0)) > 0);
    const paidAmt = paidL.reduce((a, c) => a + ((Number(c.refund_amount) || 0) || (sheetEntry(c) ? Number(sheetEntry(c).a) || 0 : 0)), 0);
    const cspSet = new Set(matured.filter(c => getStatus(c) === 'Unresolved').map(c => trim(c.partner) || '(unknown)'));
    return { n: list.length, m, w48, w48g, unresM, late, resolvedAll, pendN: pend.length, pendAmt, doneN: done.length, doneAmt, doneBr: doneBrL.length, doneBrAmt,
      elig: eligL.length, paidN: paidL.length, paidAmt, csps: cspSet.size };
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
  const breachedDoneAmt = breachedDone.reduce((a, c) => a + ((Number(c.refund_amount) || 0) || (sheetEntry(c) ? Number(sheetEntry(c).a) || 0 : 0)), 0);
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
<p class="sub">Top 10 CSPs by breached (unresolved past 48 hrs) cases, worst breach rate first. Pending reason &amp; current status maintained by the ground team in the <a href="https://docs.google.com/spreadsheets/d/1cXCnazjjLfzxG4-Uyr9nrGGo4qgGbbQ-zjFZ6xG_9vk/edit" style="color:var(--accent-ink)">CSP RCA tab</a>.${anyRca ? '' : ' <b>Tab has no entries yet — team to fill CSP | Pending Reason | Current Status.</b>'}</p>
<div class="tablewrap"><table style="min-width:900px">
<thead><tr><th>CSP</th><th>Breached</th><th>Total cases</th><th>Breach rate</th><th style="text-align:left">Pending reason</th><th style="text-align:left">Current status</th></tr></thead>
<tbody>
${top.map(c => {
  const e = rcaByCsp[normName(c.p)] || {};
  const rate = Math.round(c.n / c.t * 100);
  return `<tr><td>${c.p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td><td>${c.n}</td><td>${c.t}</td><td${rate >= 50 ? ' class="b"' : ''}>${rate}%</td><td style="text-align:left;white-space:normal">${(e.reason || '—').replace(/</g, '&lt;')}</td><td style="text-align:left;white-space:normal">${(e.status || '—').replace(/</g, '&lt;')}</td></tr>`;
}).join('\n')}
<tr><td class="tot"><b>Top 10 together</b></td><td class="tot b"><b>${top.reduce((a, c) => a + c.n, 0)}</b></td><td class="tot">${top.reduce((a, c) => a + c.t, 0)}</td><td class="tot"><b>${pct(top.reduce((a, c) => a + c.n, 0), breached.length)} of breached</b></td><td class="tot" colspan="2"></td></tr>
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

  const ptl = await ptlCallsByPartner(periods);
  // Calls placed at PTL, in each period, by the CSPs that left cases unresolved
  // in that same period — the pairing the review asks for.
  const ptlRow = periods.map((pp, i) => {
    if (!ptl) return null;
    const csps = new Set(inRange(pp).filter(c => isMatured(c) && getStatus(c) === 'Unresolved')
      .map(c => normName(c.partner)).filter(Boolean));
    let calls = 0, matched = 0;
    csps.forEach(k => { if (ptl[k]) { calls += ptl[k][i]; matched++; } });
    return { calls, csps: csps.size, matched };
  });

  const sWB = S[1];          // week -2
  const sLW = S[2];          // week -1 (the most recent completed slice)
  const sTD = S[LASTCOL];    // since launch

  const wowRes = (sLW.m && sWB.m) ? (sLW.w48 / sLW.m - sWB.w48 / sWB.m) * 100 : 0;
  const avgPerDay = Math.round(sTD.n / Math.max(1, Math.ceil((NOW - LAUNCH) / 86400000)));
  const wbLabel = periods[1].key + ' (' + periods[1].label + ')';
  const lwLabel = periods[2].key + ' (' + periods[2].label + ')';
  const tdLabel = '29 Jul – ' + cutLabel;

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
<section>
<h2>Week-wise numbers</h2>
<p class="sub">Weeks are the tracker's own buckets (1-7 / 8-14 / 15-21 / 22-end), cohorted by the date the case entered the tracker, so every row answers the same question: of the cases received in this week, what happened. Reopened is read the same way — of this week's own within-48hr resolutions, the ones that later came back down. Cases received after ${cutLabel} are excluded, and every percentage is over matured cases only — those that completed their full 48-hour window.</p>
<div class="tablewrap"><table>
<thead><tr><th>Metric</th>${cols}</tr></thead>
<tbody>
${row('Cases received', s => s.n.toLocaleString('en-IN'))}
${row('Matured — past 48 hrs since being added', s => s.m.toLocaleString('en-IN'))}
${row('<b>Resolved within 48 hrs</b>', s => pct(s.w48g, s.m), 'g')}
${row('Resolved, count', s => s.w48g.toLocaleString('en-IN'))}
${row('<b>Reopened</b>', s => pct(s.w48g - s.w48, s.w48g), 'b')}
${row('Reopened, count', s => (s.w48g - s.w48) + ' of ' + s.w48g.toLocaleString('en-IN') + ' resolutions')}
${row('<b>Resolved within 48 hrs — net of reopened</b>', s => pct(s.w48, s.m), 'g')}
${row('<b>Unresolved</b>', s => pct(s.unresM, s.m), 'b')}
${row('Unresolved, count', s => s.unresM.toLocaleString('en-IN'))}
${row('<b>Unresolved and eligible for refund</b> <span style="font-weight:400;color:var(--muted)">(no ping since the complaint)</span>', s => s.elig.toLocaleString('en-IN') + ' (' + pct(s.elig, s.m) + ')', 'b')}
${row('<b>Average amount paid to a customer</b>', s => (s.paidN ? inr(s.paidAmt / s.paidN) : '—'))}
${row('<b>Total amount refunded to customers</b>', s => inr(s.paidAmt), 'g')}
${row('CSPs contributing to the unresolved cases', s => s.csps)}
<tr><td>Calls at PTL by those CSPs</td>${ptlRow.map((x, i) =>
  `<td class="${i === LASTCOL ? 'tot' : ''}">${x ? x.calls.toLocaleString('en-IN') : '—'}</td>`).join('')}</tr>
</tbody></table></div>
<p class="sub" style="margin-top:10px">Calls at PTL = Ameyo calls on the PartnerSupportQueue placed by those CSPs' registered numbers, same attribution as Metabase card 12025.${ptlRow[LASTCOL] ? ` Matched ${ptlRow[LASTCOL].matched} of the ${ptlRow[LASTCOL].csps} CSPs since launch.` : ''}<br>A further ${S.map(x => x.intake).slice(0, 3).join(' / ')} cases (Week −3 / −2 / −1) arrived already reopened in Kapture. That is an intake label, not a resolution of ours that came back, so it is excluded from the reopened rate above.</p>
</section>
<section>
<h2>The complete funnel — case added → resolved ≤48h → unresolved &gt;48h → refund → closed (${tdLabel})</h2>
<p class="sub">The end-to-end journey of every case received since 29 Jul. Each stage shows absolute + %, and each drop shows what happened.</p>
<div class="tablewrap"><table>
<thead><tr><th>Stage</th><th>Cases</th><th>%</th><th style="text-align:left">What happened</th></tr></thead>
<tbody>
<tr><td><b>1. Case added</b></td><td><b>${sTD.n.toLocaleString('en-IN')}</b></td><td><b>100%</b></td><td style="text-align:left">All cases entering the tracker since 29 Jul (~${avgPerDay}/day)</td></tr>
<tr><td style="padding-left:34px">↳ Still inside 48-hr window</td><td>${(sTD.n - sTD.m).toLocaleString('en-IN')}</td><td>${pct(sTD.n - sTD.m, sTD.n)}</td><td style="text-align:left">Too fresh to judge — mature within 2 days</td></tr>
<tr><td style="padding-left:34px">↳ Matured</td><td>${sTD.m.toLocaleString('en-IN')}</td><td>${pct(sTD.m, sTD.n)}</td><td style="text-align:left">Completed their full 48-hour window — base for the stages below</td></tr>
<tr><td class="g"><b>2. Resolved within 48 hrs</b></td><td class="g"><b>${sTD.w48.toLocaleString('en-IN')}</b></td><td class="g"><b>${pct(sTD.w48, sTD.m)}</b></td><td style="text-align:left">Net of reopens: gross ${sTD.w48g.toLocaleString('en-IN')} (${pct(sTD.w48g, sTD.m)}) − ${(sTD.w48g - sTD.w48)} later reopened</td></tr>
<tr><td style="padding-left:34px">↳ Resolved late (after breaching)</td><td>${sTD.late}</td><td>${pct(sTD.late, sTD.m)}</td><td style="text-align:left">Fixed, but only after the 48-hr promise was broken</td></tr>
<tr><td class="b"><b>3. Unresolved after 48 hrs</b></td><td class="b"><b>${breached.length}</b></td><td class="b"><b>${pct(breached.length, sTD.m)}</b></td><td style="text-align:left">Breached and still open — every one owes a pro-rata refund</td></tr>
${ageing.map(([r, n]) => `<tr><td style="padding-left:34px">↳ Pending since ${r}</td><td>${n}</td><td>${pct(n, breached.length)}</td><td style="text-align:left"></td></tr>`).join('\n')}
<tr><td><b>4. Refund</b></td><td><b>${breached.length}</b></td><td><b>100% eligible</b></td><td style="text-align:left">Every breached case owes the customer a pro-rata refund</td></tr>
<tr><td class="g" style="padding-left:34px">↳ Refund done</td><td class="g">${breachedDone.length}</td><td class="g">${pct(breachedDone.length, breached.length)}</td><td style="text-align:left">${inr(breachedDoneAmt)} paid (Finance sheet / Cx Action)</td></tr>
<tr><td class="b" style="padding-left:34px">↳ Refund pending</td><td class="b">${breachedPend.length}</td><td class="b">${pct(breachedPend.length, breached.length)}</td><td style="text-align:left">${inr(breachedPendAmt)} owed pro-rata</td></tr>
<tr><td><b>5. Closed — Kapture final status</b></td><td><b>${breached.length}</b></td><td><b>100%</b></td><td style="text-align:left">Where the breached tickets stand in Kapture</td></tr>
${closure.map(([s, n]) => `<tr><td style="padding-left:34px">↳ ${s}</td><td>${n}</td><td>${pct(n, breached.length)}</td><td style="text-align:left">${s === 'Completed' ? 'Disposed by PFT but tracker still shows unresolved — verify' : s === 'Pending' ? 'Still open in Kapture too' : ''}</td></tr>`).join('\n')}
</tbody></table></div>
</section>
${cspRca}
${rcaLedger}
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
