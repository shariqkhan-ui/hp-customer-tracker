/**
 * Weekly Review doc — the page the HP 48-hr review actually runs off.
 *
 * Order is the review's own agenda, not a metric dump:
 *   1. last meeting's action items, item by item (+ the TV/Camera deep-dive)
 *   2. the week-wise funnel: matured → resolved → reopened → net → unresolved
 *      → refund-eligible → refund paid, for Week -3 / -2 / -1 and MTD
 *   3. the reopened cases
 *   4. the CSPs behind the unresolved cases
 *   5. why the no-ping unresolved cases have not been refunded
 *
 * Weeks are Monday-anchored IST; Week -1 is the just-finished Mon–Sun week.
 * Every percentage uses MATURED cases only (the case has completed its full
 * 48-hr window), so a part-grown week is never compared with a finished one.
 *
 * Writes weekly-review.html in the repo root (served on GitHub Pages).
 */

const fs = require('fs');
const path = require('path');

const FIREBASE_DB = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const LAUNCH = Date.parse('2026-07-29T00:00:00+05:30'); // 48-hr flag launch
const LIM = 48 * 3600000;
const IST = 5.5 * 3600000;
const NOW = Date.now();
const OUT = path.join(__dirname, '..', 'weekly-review.html');
// TV/Camera deep-dive rows. Mirrored from the field team's RCA sheet
// (1XibbJM2El4tXNdYIc9_qLrq57o63NSJwlXN954FYk_U) — kept as a repo file
// because that sheet is not link-readable, so the cron cannot fetch it.
const TVCAM = require('../data-tvcam-rca.json');

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
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
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
function resolvedWithin48(c) {
  if (getStatus(c) === 'Unresolved') return false;
  const s = startTs(c), rt = Number(c.remarks_updated_at) || 0;
  if (rt > 0) return (rt - s) <= LIM;
  const md = parseDate(c.migration_date);
  if (md) return (md.getTime() + 86399000 - s) <= LIM;
  return null;
}
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtD = ts => { const d = new Date(ts + IST); return d.getUTCDate() + ' ' + MN[d.getUTCMonth()]; };
const inr = v => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '—');
const pctN = (a, b) => (b ? a / b * 100 : 0);

(async () => {
  const [casesRaw, sheet, sheetMob, aiRaw] = await Promise.all([
    fetch(FIREBASE_DB + '/cases.json').then(r => r.json()),
    fetch(FIREBASE_DB + '/refund_sheet.json').then(r => r.json()).catch(() => ({})),
    fetch(FIREBASE_DB + '/refund_sheet_mob.json').then(r => r.json()).catch(() => ({})),
    fetch(FIREBASE_DB + '/cases/__action_items__.json').then(r => r.json()).catch(() => ({})),
  ]);
  const dig = v => String(v || '').replace(/\D/g, '');
  const sheetEntry = c => (sheet && sheet[dig(c.ticket_no)]) || (sheetMob && sheetMob[dig(c.mobile).slice(-10)]) || null;
  // A REOPEN is a case WE marked resolved that came back down — the tracker
  // stamps reopened_at when a true-resolution remark is reverted. It is NOT
  // source='reopened-cron': that is an intake label meaning Kapture already
  // showed the ticket as reopened when we pulled it in, so the case arrives
  // reopened rather than reopening on our watch. Counting the two together
  // inflated the rate ~7x (14.4% vs 2.1% for the week of 31 Aug).
  const reopTs = c => Number(c.reopened_at) || 0;
  const isReop = c => reopTs(c) > 0;
  const cameInAsReopen = c => String(c.source) === 'reopened-cron';
  const RES_REMARKS = ['resolved by old partner', 'resolved by old csp'];
  const isResRemark = c => RES_REMARKS.includes(trim(c.remarks).toLowerCase()) || trim(c.migration_date) !== '';
  const isDone = c => !!sheetEntry(c) || trim(c.cx_action) === 'Refund Done' || trim(c.refund_action) === 'Refund Done';
  const amtOf = c => {
    const a = Number(c.refund_amount);
    if (c.refund_amount !== '' && c.refund_amount != null && !isNaN(a)) return a;
    const e = sheetEntry(c);
    return e ? (Number(e.a) || 0) : 0;
  };
  // Router pinged AFTER the case was raised → the line came back up on its own,
  // so nothing is owed. No ping since → the customer is genuinely still down
  // and the case is refund-eligible.
  const pingedAfter = c => Number(c.last_ping_at) > 0 && Number(c.last_ping_at) > startTs(c);

  const era = Object.entries(casesRaw).filter(([k]) => !k.startsWith('__')).map(([, c]) => c)
    .filter(c => c && c.ticket_no && startTs(c) >= LAUNCH);

  // ── Periods: Monday-anchored IST weeks + month-to-date ────────────────────
  const istNow = new Date(NOW + IST);
  const d0 = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) - IST;
  const thisMon = d0 - ((istNow.getUTCDay() + 6) % 7) * 86400000;
  const mStart = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1) - IST;
  const wk = i => ({ key: 'Week −' + i, from: thisMon - i * 7 * 86400000, to: thisMon - (i - 1) * 7 * 86400000 });
  const periods = [wk(3), wk(2), wk(1), { key: 'MTD', from: mStart, to: NOW }];
  periods.forEach(p => { p.label = fmtD(p.from) + ' – ' + fmtD(Math.min(p.to, NOW) - 1); });
  const inRange = r => era.filter(c => { const t = startTs(c); return t >= r.from && t < r.to; });

  function stats(list) {
    const matured = list.filter(c => (NOW - startTs(c)) >= LIM);
    const gross = matured.filter(c => resolvedWithin48(c) === true);
    const reop = gross.filter(isReop);
    const late = matured.filter(c => getStatus(c) !== 'Unresolved' && resolvedWithin48(c) !== true);
    const unres = matured.filter(c => getStatus(c) === 'Unresolved');
    const elig = unres.filter(c => !pingedAfter(c));
    const done = matured.filter(isDone);
    const paid = done.filter(c => amtOf(c) > 0);
    return {
      n: list.length, m: matured.length, growing: list.length - matured.length,
      gross: gross.length, reop: reop.length, net: gross.length - reop.length,
      late: late.length, unres: unres.length, elig: elig.length, pinged: unres.length - elig.length,
      doneN: done.length, paidN: paid.length, paidAmt: paid.reduce((a, c) => a + amtOf(c), 0),
      csps: new Set(unres.map(c => trim(c.partner) || '(unknown)')).size,
    };
  }
  // Reopens are an EVENT, so they are counted in the week the reopen happened
  // and measured against the resolutions marked in that same week — not
  // against the week the case was originally added.
  function reopStats(p) {
    const inWeek = era.filter(c => { const r = reopTs(c); return r >= p.from && r < p.to; });
    const resMarked = era.filter(c => { const rt = Number(c.remarks_updated_at) || 0; return rt >= p.from && rt < p.to && isResRemark(c); });
    const intake = era.filter(c => { const t = startTs(c); return t >= p.from && t < p.to && cameInAsReopen(c); });
    return { reopWeek: inWeek.length, resWeek: resMarked.length, intake: intake.length };
  }
  const S = periods.map((p, i) => Object.assign(stats(inRange(p)), reopStats(p)));

  // ── Three-week review window: every detail section reads off this ─────────
  const winFrom = thisMon - 21 * 86400000;
  const win = era.filter(c => { const t = startTs(c); return t >= winFrom && t < thisMon; });
  const winLabel = fmtD(winFrom) + ' – ' + fmtD(thisMon - 1);
  const winMatured = win.filter(c => (NOW - startTs(c)) >= LIM);
  const winUnres = winMatured.filter(c => getStatus(c) === 'Unresolved');
  const winElig = winUnres.filter(c => !pingedAfter(c));
  // Scoped by WHEN the case reopened, not when it was added.
  const reopened = era.filter(c => { const r = reopTs(c); return r >= winFrom && r < thisMon; });
  const intakeReop = win.filter(cameInAsReopen);
  const resInWin = era.filter(c => { const rt = Number(c.remarks_updated_at) || 0; return rt >= winFrom && rt < thisMon && isResRemark(c); });

  const countBy = (list, fn) => {
    const m = {};
    list.forEach(c => { const k = fn(c) || '(not filled)'; m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const reopReasons = countBy(reopened, c => trim(c.remarks));
  const reopPft = reopened.filter(c => trim(c.kapture_status) === 'Completed').length;
  const reopStillDown = reopened.filter(c => getStatus(c) === 'Unresolved').length;
  const eligReasons = countBy(winElig, c => trim(c.remarks));
  const eligActions = countBy(winElig, c => trim(c.refund_action) || 'Refund Pending — no action set yet');

  // CSPs behind the unresolved cases, split by week
  const cspTot = {}, cspWk = {}, cspElig = {};
  win.forEach(c => { const p = trim(c.partner) || '(unknown)'; cspTot[p] = (cspTot[p] || 0) + 1; });
  winUnres.forEach(c => {
    const p = trim(c.partner) || '(unknown)', t = startTs(c);
    const wi = t >= thisMon - 7 * 86400000 ? 1 : t >= thisMon - 14 * 86400000 ? 2 : 3;
    const e = (cspWk[p] = cspWk[p] || { 1: 0, 2: 0, 3: 0, all: 0 });
    e[wi]++; e.all++;
    if (!pingedAfter(c)) cspElig[p] = (cspElig[p] || 0) + 1;
  });
  const cspTop = Object.entries(cspWk).sort((a, b) => b[1].all - a[1].all).slice(0, 15);
  const cspTopSum = cspTop.reduce((a, x) => a + x[1].all, 0);

  // TV/Camera deep-dive rollups
  const roll = key => {
    const m = {};
    TVCAM.forEach(r => { m[r[key]] = (m[r[key]] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const byCause = roll('cause'), byState = roll('state'), bySymptom = roll('symptom');

  const items = Object.entries(aiRaw || {}).filter(([, v]) => v && v.item)
    .sort((a, b) => (a[1].created_at || 0) - (b[1].created_at || 0));

  // ── HTML ──────────────────────────────────────────────────────────────────
  const cols = periods.map(p => `<th><span class="ch">${p.key}</span><span class="cd">${p.label}</span></th>`).join('');
  // A funnel row: label, optional "what this is", then one cell per period.
  const row = (label, fn, opt = {}) => {
    const cls = [opt.cls || '', opt.step ? 'step' : '', opt.head ? 'head' : ''].filter(Boolean).join(' ');
    return `<tr class="${cls}"><td class="lbl">${label}${opt.note ? `<span class="note">${opt.note}</span>` : ''}</td>` +
      S.map((s, i) => `<td${i === 3 ? ' class="mtd"' : ''}>${fn(s, i)}</td>`).join('') + '</tr>';
  };
  const bar = (v, good) => {
    const w = Math.max(0, Math.min(100, v));
    return `<span class="mini"><span class="mini-fill ${good ? 'g' : 'b'}" style="width:${w.toFixed(1)}%"></span></span>`;
  };
  const pctCell = (a, b, good) => `<span class="pv">${pct(a, b)}</span>${bar(pctN(a, b), good)}`;

  const lastW = S[2], prevW = S[1];
  const deltaNet = pctN(lastW.net, lastW.m) - pctN(prevW.net, prevW.m);

  const aiHtml = items.map(([, v], i) => `
      <article class="item">
        <div class="item-no">${String(i + 1).padStart(2, '0')}</div>
        <div class="item-body">
          <h3>${esc(v.item)}</h3>
          <div class="item-meta"><span class="pill ${v.status === 'Done' ? 'pill-done' : v.status === 'Blocked' ? 'pill-blocked' : 'pill-open'}">${esc(v.status || 'Open')}</span>
            <span>${esc(v.owner || 'unassigned')}</span>${v.due ? `<span>due ${esc(v.due)}</span>` : ''}</div>
          <p class="item-note">${v.notes ? esc(v.notes)
            : /tv|camera/i.test(v.item) ? `RCA completed — ${TVCAM.length} customers taken end to end by the field team, with a remote-resolution playbook drawn from them.`
            : '<i>No closing note recorded — to be discussed.</i>'}</p>
          ${/tv|camera/i.test(v.item) ? '<p class="item-link"><a href="#tvcam">Read the full TV / Camera RCA below →</a></p>' : ''}
        </div>
      </article>`).join('');

  const tvRows = TVCAM.map(r => `<tr>
      <td class="mono">${esc(r.mob)}</td><td class="mono">${esc(r.dev)}</td>
      <td class="wrap">${esc(r.issue)}</td><td class="wrap"><b>${esc(r.cause)}</b></td>
      <td class="wrap">${esc(r.rca)}</td><td class="wrap">${esc(r.fix)}</td>
      <td><span class="pill ${r.state === 'Resolved' ? 'pill-done' : r.state === 'Open' ? 'pill-blocked' : 'pill-open'}">${esc(r.state)}</span></td>
    </tr>`).join('');

  const causeRows = byCause.map(([k, n]) => `<tr><td class="lbl wrap">${esc(k)}</td><td>${n}</td><td>${pct(n, TVCAM.length)}${bar(pctN(n, TVCAM.length), false)}</td></tr>`).join('');
  const sympRows = bySymptom.map(([k, n]) => `<tr><td class="lbl wrap">${esc(k)}</td><td>${n}</td><td>${pct(n, TVCAM.length)}</td></tr>`).join('');
  const stateRows = byState.map(([k, n]) => `<tr><td class="lbl wrap">${esc(k)}</td><td>${n}</td><td>${pct(n, TVCAM.length)}</td></tr>`).join('');

  const reopRows = reopReasons.map(([k, n]) => `<tr><td class="lbl wrap">${esc(k)}</td><td>${n}</td><td>${pct(n, reopened.length)}${bar(pctN(n, reopened.length), false)}</td></tr>`).join('');
  const eligRows = eligReasons.map(([k, n]) => `<tr><td class="lbl wrap">${esc(k)}</td><td>${n}</td><td>${pct(n, winElig.length)}${bar(pctN(n, winElig.length), false)}</td></tr>`).join('');
  const actRows = eligActions.map(([k, n]) => `<tr><td class="lbl wrap">${esc(k)}</td><td>${n}</td><td>${pct(n, winElig.length)}</td></tr>`).join('');
  const cspRows = cspTop.map(([p, e]) => {
    const t = cspTot[p] || e.all, rate = pctN(e.all, t);
    return `<tr><td class="lbl wrap">${esc(p)}</td><td>${e[3] || '–'}</td><td>${e[2] || '–'}</td><td>${e[1] || '–'}</td>` +
      `<td class="mtd"><b>${e.all}</b></td><td>${t}</td><td class="${rate >= 50 ? 'bad' : ''}">${rate.toFixed(0)}%</td>` +
      `<td>${cspElig[p] || 0}</td><td class="pend">—</td></tr>`;
  }).join('');

  // headBits + bodyInner are kept apart so the same page can ship two ways:
  // a standalone file for GitHub Pages, and a head/body fragment for the
  // Claude Artifact (which supplies its own doctype/head/body skeleton).
  const headBits = `<title>High Pain Weekly Review</title>
<meta name="description" content="The 48-hour TAT weekly review — action items, week-wise funnel, reopens, refunds and the CSPs behind the unresolved cases.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:wght@600;700&display=swap">
<style>
:root{
  --bg:#F7F3F6; --surface:#FFFFFF; --surface2:#F3EAF0; --raise:#FBF7FA;
  --ink:#1E141B; --ink2:#574A52; --muted:#8B7B85; --border:#E7DAE2; --rule:#D9C6D2;
  --accent:#C2007A; --accent-ink:#8E0059; --accent-soft:#FCE7F3;
  --good:#1A7F37; --good-soft:#E4F3E9; --warn:#A75B00; --bad:#B23A0A; --bad-soft:#FCE6DC;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#150F14; --surface:#1E1720; --surface2:#271E29; --raise:#241C26;
    --ink:#F5ECF2; --ink2:#C8B8C3; --muted:#95848F; --border:#382B36; --rule:#4A3A46;
    --accent:#FF5FBE; --accent-ink:#FF92D3; --accent-soft:#3A1030;
    --good:#5BD07F; --good-soft:#12301C; --warn:#E8A33D; --bad:#FF8757; --bad-soft:#3A1A0E;
  }
}
:root[data-theme="dark"]{
  --bg:#150F14; --surface:#1E1720; --surface2:#271E29; --raise:#241C26;
  --ink:#F5ECF2; --ink2:#C8B8C3; --muted:#95848F; --border:#382B36; --rule:#4A3A46;
  --accent:#FF5FBE; --accent-ink:#FF92D3; --accent-soft:#3A1030;
  --good:#5BD07F; --good-soft:#12301C; --warn:#E8A33D; --bad:#FF8757; --bad-soft:#3A1A0E;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:400 16px/1.62 "IBM Plex Sans",-apple-system,Segoe UI,system-ui,sans-serif;
  padding:0 22px 88px}
.wrap{max-width:1060px;margin:0 auto}
a{color:var(--accent-ink)}
header{padding:52px 0 8px;border-bottom:1px solid var(--rule)}
.eyebrow{font:600 12px/1 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.16em;
  text-transform:uppercase;color:var(--accent);margin:0 0 14px}
h1{font:700 clamp(30px,5.2vw,46px)/1.08 "IBM Plex Serif",Georgia,serif;margin:0 0 12px;
  letter-spacing:-.02em;text-wrap:balance}
.dek{font-size:17px;color:var(--ink2);max-width:62ch;margin:0 0 20px}
.stamp{font:500 12.5px/1.5 "IBM Plex Mono",ui-monospace,monospace;color:var(--muted);
  padding-bottom:26px;display:flex;flex-wrap:wrap;gap:6px 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(184px,1fr));gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin:26px 0 0}
.tile{background:var(--surface);padding:16px 18px 15px}
.tile .lb{font:600 11px/1.3 "IBM Plex Mono",monospace;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.tile .vl{font:600 30px/1.15 "IBM Plex Mono",monospace;margin-top:7px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tile .nt{font-size:12.5px;color:var(--ink2);margin-top:3px}
.up{color:var(--good)} .down{color:var(--bad)}
section{margin-top:54px;scroll-margin-top:20px}
.sec-head{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--rule);padding-bottom:10px;margin-bottom:16px}
.sec-no{font:600 12px/1 "IBM Plex Mono",monospace;color:var(--accent);letter-spacing:.12em;padding-top:4px}
h2{font:700 clamp(21px,2.6vw,27px)/1.2 "IBM Plex Serif",Georgia,serif;margin:0;letter-spacing:-.015em}
h3{font:600 17px/1.35 "IBM Plex Serif",Georgia,serif;margin:0 0 6px}
h4{font:600 13px/1.3 "IBM Plex Mono",monospace;letter-spacing:.07em;text-transform:uppercase;
  color:var(--muted);margin:30px 0 10px}
.sub{color:var(--ink2);font-size:14.5px;margin:0 0 18px;max-width:78ch}
.item{display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 0;border-bottom:1px solid var(--border)}
.item:last-of-type{border-bottom:0}
.item-no{font:600 15px/1.4 "IBM Plex Mono",monospace;color:var(--muted);padding-top:2px}
.item-body h3{margin-bottom:8px;text-wrap:balance}
.item-meta{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;font:500 12.5px/1 "IBM Plex Mono",monospace;color:var(--muted);margin-bottom:9px}
.item-note{margin:0;color:var(--ink2);font-size:14.6px;max-width:74ch}
.item-link{margin:8px 0 0;font-size:14px}
.pill{display:inline-block;padding:3px 9px;border-radius:999px;font:600 11px/1.5 "IBM Plex Mono",monospace;
  letter-spacing:.05em;text-transform:uppercase}
.pill-done{background:var(--good-soft);color:var(--good)}
.pill-open{background:var(--accent-soft);color:var(--accent-ink)}
.pill-blocked{background:var(--bad-soft);color:var(--bad)}
.tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:14.4px;min-width:640px}
th{background:var(--surface2);color:var(--ink);text-align:right;padding:11px 14px;
  font:600 12px/1.35 "IBM Plex Mono",monospace;letter-spacing:.04em;border-bottom:1px solid var(--rule);white-space:nowrap;vertical-align:bottom}
th:first-child{text-align:left}
th .ch{display:block}
th .cd{display:block;font-weight:400;color:var(--muted);letter-spacing:0;font-size:11px;margin-top:3px}
td{padding:9px 14px;border-bottom:1px solid var(--border);text-align:right;color:var(--ink2);
  font-variant-numeric:tabular-nums;white-space:nowrap}
td.lbl{text-align:left;color:var(--ink);white-space:normal}
td.wrap{white-space:normal;text-align:left;min-width:150px}
tr:last-child td{border-bottom:0}
tr.head td{background:var(--raise);font-weight:600;color:var(--ink)}
tr.step td.lbl{padding-left:32px;position:relative}
tr.step td.lbl::before{content:"↳";position:absolute;left:14px;color:var(--muted)}
td.mtd{background:var(--raise);color:var(--ink);font-weight:600}
th:last-child{background:var(--accent-soft)}
.note{display:block;font-size:12px;color:var(--muted);font-weight:400;margin-top:1px}
.pv{display:inline-block}
.mini{display:block;height:3px;border-radius:2px;background:var(--border);margin-top:5px;overflow:hidden}
.mini-fill{display:block;height:100%;border-radius:2px}
.mini-fill.g{background:var(--good)} .mini-fill.b{background:var(--accent)}
.bad{color:var(--bad);font-weight:600}
.pend{color:var(--muted)}
.mono{font-family:"IBM Plex Mono",monospace;font-size:13px}
.callout{border:1px solid var(--border);border-left:3px solid var(--accent);background:var(--surface);
  border-radius:0 10px 10px 0;padding:15px 18px;margin:18px 0 0;font-size:14.6px;color:var(--ink2)}
.callout b{color:var(--ink)}
.playbook{list-style:none;counter-reset:pb;padding:0;margin:12px 0 0;display:grid;gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.playbook li{counter-increment:pb;background:var(--surface);padding:14px 18px 14px 52px;position:relative;font-size:14.6px;color:var(--ink2)}
.playbook li::before{content:counter(pb);position:absolute;left:18px;top:14px;
  font:600 13px/1.6 "IBM Plex Mono",monospace;color:var(--accent)}
.playbook b{color:var(--ink)}
footer{margin-top:60px;padding-top:18px;border-top:1px solid var(--rule);
  font:400 13px/1.6 "IBM Plex Mono",monospace;color:var(--muted)}
@media (max-width:640px){
  body{padding:0 14px 60px}
  .item{grid-template-columns:32px 1fr;gap:10px}
}
@media (prefers-reduced-motion:no-preference){a{transition:color .15s}}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
</style>`;

  const bodyInner = `<div class="wrap">

<header>
  <p class="eyebrow">High Pain · 48-hour TAT</p>
  <h1>Weekly Review — ${periods[2].label}</h1>
  <p class="dek">Every case we took in, and what happened to it: the action items we closed, the week the cases matured in, who was left unresolved, and what we paid back.</p>
</header>
<div class="stamp">
  <span>Generated ${new Date(NOW + IST).toISOString().slice(0, 16).replace('T', ' ')} IST</span>
  <span>Cohort: cases added since 29 Jul (48-hr flag era)</span>
  <span>Denominator: matured cases only</span>
</div>

<div class="tiles">
  <div class="tile"><div class="lb">Matured last week</div><div class="vl">${lastW.m}</div><div class="nt">of ${lastW.n} added ${periods[2].label}</div></div>
  <div class="tile"><div class="lb">Resolved ≤ 48h (net)</div><div class="vl">${pct(lastW.net, lastW.m)}</div><div class="nt ${deltaNet >= 0 ? 'up' : 'down'}">${deltaNet >= 0 ? '▲' : '▼'} ${Math.abs(deltaNet).toFixed(1)} pts vs Week −2</div></div>
  <div class="tile"><div class="lb">Reopened in the week</div><div class="vl">${pct(lastW.reopWeek, lastW.resWeek)}</div><div class="nt">${lastW.reopWeek} of ${lastW.resWeek} resolutions came back down</div></div>
  <div class="tile"><div class="lb">Refund-eligible</div><div class="vl">${lastW.elig}</div><div class="nt">still down, no ping since the complaint</div></div>
  <div class="tile"><div class="lb">Paid back last week</div><div class="vl">${inr(lastW.paidAmt)}</div><div class="nt">${lastW.paidN} customers · avg ${lastW.paidN ? inr(lastW.paidAmt / lastW.paidN) : '—'}</div></div>
</div>

<section id="actions">
  <div class="sec-head"><span class="sec-no">01</span><h2>Action items from the last review</h2></div>
  <p class="sub">Taken one by one, in the order they were raised. Status is live from the tracker's Action Items tab — nothing here is typed by hand.</p>
  ${aiHtml || '<p class="sub"><i>No action items recorded for this cycle.</i></p>'}
</section>

<section id="tvcam">
  <div class="sec-head"><span class="sec-no">01b</span><h2>Deep-dive — TV &amp; camera complaints</h2></div>
  <p class="sub">The RCA behind action item on TV/Camera issues: ${TVCAM.length} customers taken end to end by the field team. Read it in three passes — how many customers and with what symptom, what actually caused it, and what the remote playbook should therefore be.</p>

  <h4>Pass 1 · How many customers, and what they reported</h4>
  <div class="tablewrap"><table style="min-width:520px">
    <thead><tr><th>Reported symptom</th><th>Customers</th><th>Share</th></tr></thead>
    <tbody>
      <tr class="head"><td class="lbl">All customers RCA'd</td><td>${TVCAM.length}</td><td>100%</td></tr>
      ${sympRows}
    </tbody></table></div>
  <div class="callout">${TVCAM.filter(r => /tv|camera/i.test(r.issue)).length} of the ${TVCAM.length} arrive labelled as a <b>TV or camera fault</b> — but only ${byCause.filter(([k]) => /coverage|band|premise/i.test(k)).reduce((a, x) => a + x[1], 0)} of them are a TV-side problem at all. The rest are ordinary access-network faults that the customer happened to notice on the TV first, because the TV is the thing they watch every evening.</div>

  <h4>Pass 2 · What actually caused it</h4>
  <div class="tablewrap"><table style="min-width:520px">
    <thead><tr><th>Root cause</th><th>Cases</th><th>Share</th></tr></thead>
    <tbody>${causeRows}</tbody></table></div>

  <h4>Pass 3 · Where each case landed</h4>
  <div class="tablewrap"><table style="min-width:520px">
    <thead><tr><th>Outcome</th><th>Cases</th><th>Share</th></tr></thead>
    <tbody>${stateRows}</tbody></table></div>

  <h4>The remote-resolution playbook this RCA argues for</h4>
  <ol class="playbook">
    <li><b>Ask what the customer can see, not what is broken.</b> “Is the Wi-Fi name showing in the TV's network list?” splits the ${TVCAM.length} cases straight down the middle — SSID missing is a device or WLAN fault, SSID present is a speed, coverage or TV-side fault.</li>
    <li><b>SSID not visible anywhere → treat as a dead Wi-Fi device.</b> Four of these ended in a device swap and a reset did not save any of them. Skip the reset loop, raise the replacement.</li>
    <li><b>SSID visible on the phone but not the TV → rename the SSID from the WLAN settings.</b> Two cases cleared on that alone, remotely, with no visit.</li>
    <li><b>TV joins nothing while the phone is fine → check the band.</b> Older TVs are 2.4 GHz only; confirm the model before booking a visit. One customer needed the TV shop, not us.</li>
    <li><b>Buffering, not disconnection → read the line before dispatching.</b> Check ISP throughput and optical receive power first; −30 dBm is already out of range and no CSP visit will fix it.</li>
    <li><b>Camera down but Wi-Fi up → suspect the LAN run to the DVR.</b> Where the DVR sits in a different shop, the RJ45 crimp is the first thing to test.</li>
    <li><b>Close the “no fault at our end” cases explicitly.</b> Three of ${TVCAM.length} were an uninstalled app, a repaired TV that forgets credentials, and an unsupported band. They must be dispositioned as customer-premise, or they age in the tracker as our breach.</li>
  </ol>

  <h4>Case ledger</h4>
  <div class="tablewrap" style="max-height:520px;overflow:auto"><table style="min-width:1020px">
    <thead><tr><th>Mobile</th><th>Device</th><th>Reported issue</th><th>Root cause</th><th>What we found</th><th>Action taken</th><th>Outcome</th></tr></thead>
    <tbody>${tvRows}</tbody></table></div>
</section>

<section id="funnel">
  <div class="sec-head"><span class="sec-no">02</span><h2>The week-wise funnel</h2></div>
  <p class="sub">Cases are grouped by the week they were <b>added</b> to the tracker, and only counted once they have completed a full 48 hours. Each drop below the top line has its own row, so the question “where did the rest go?” is answered on the page.</p>
  <div class="tablewrap"><table style="min-width:760px">
    <thead><tr><th>Metric</th>${cols}</tr></thead>
    <tbody>
      ${row('Cases added', s => s.n, { head: true })}
      ${row('Matured — past 48 hrs since being added', s => s.m, { head: true, note: 'the denominator for every % below' })}
      ${row('Still inside the 48-hr window', s => s.growing || '–', { step: true, note: 'not yet judged' })}
      ${row('Resolved within 48 hrs — gross', (s, i) => pctCell(s.gross, s.m, true) + '', { head: true, note: 'ping restored or closed by the CSP' })}
      ${row('Resolved, count', s => s.gross, { step: true })}
      ${row('Reopened during the week', s => `<b>${s.reopWeek}</b> <span class="note">${pct(s.reopWeek, s.resWeek)} of ${s.resWeek} resolutions marked this week</span>`, { head: true, note: 'a case we had marked resolved that came back down, counted in the week it came back' })}
      ${row('… of them, from this week&rsquo;s own ≤48-hr resolutions', s => s.reop || '–', { step: true, note: 'the only ones that change this week&rsquo;s net number' })}
      ${row('Arrived already reopened in Kapture', s => s.intake || '–', { step: true, note: 'intake label — the ticket was a reopen before we ever saw it, so it is not our reopen' })}
      ${row('Resolved within 48 hrs — net of reopened', s => pctCell(s.net, s.m, true), { head: true, note: 'the number we hold ourselves to' })}
      ${row('Resolved late — after the 48-hr mark', s => s.late || '–', { step: true })}
      ${row('Unresolved at maturity', s => pctCell(s.unres, s.m, false), { head: true, note: 'breached — customer still down at 48 hrs' })}
      ${row('Unresolved, count', s => s.unres, { step: true })}
      ${row('… line came back later (ping seen)', s => s.pinged || '–', { step: true, note: 'recovered after the breach — no refund owed' })}
      ${row('Refund-eligible — no ping since the complaint', s => `<b>${s.elig}</b> <span class="note">${pct(s.elig, s.m)} of matured</span>`, { head: true, note: 'router never came back up' })}
      ${row('Customers actually paid', s => s.paidN || '–', { step: true })}
      ${row('Average refund per customer', s => (s.paidN ? inr(s.paidAmt / s.paidN) : '–'), { head: true })}
      ${row('Total refunded to customers', s => inr(s.paidAmt), { head: true })}
      ${row('CSPs behind the unresolved cases', s => s.csps, { head: true, note: 'distinct CSPs with at least one breach' })}
    </tbody></table></div>
  <div class="callout">Week −1 and MTD are still settling: cases added in the last two days have not finished their 48-hr window, and the refund actions for that week are entered later in the following week. Read them as directional; Week −2 and Week −3 are final.</div>
</section>

<section id="reopened">
  <div class="sec-head"><span class="sec-no">03</span><h2>The reopened cases</h2></div>
  <p class="sub">${reopened.length} cases came back down across ${winLabel} — a case we had marked resolved that went down again — against ${resInWin.length} resolutions marked in the same window, a reopen rate of ${pct(reopened.length, resInWin.length)}. Counted by the day the case reopened, not the day it was first logged.</p>
  <div class="tiles" style="margin:0 0 18px">
    <div class="tile"><div class="lb">Reopened in window</div><div class="vl">${reopened.length}</div><div class="nt">${pct(reopened.length, resInWin.length)} of ${resInWin.length} resolutions</div></div>
    <div class="tile"><div class="lb">Confirmed closed by PFT</div><div class="vl">${pct(reopPft, reopened.length)}</div><div class="nt">${reopPft} disposed in Kapture</div></div>
    <div class="tile"><div class="lb">Still down today</div><div class="vl">${reopStillDown}</div><div class="nt">reopened and not resolved since</div></div>
    <div class="tile"><div class="lb">Arrived already reopened</div><div class="vl">${intakeReop.length}</div><div class="nt">Kapture reopens pulled in by the cron — counted separately, not as our reopens</div></div>
  </div>
  <div class="tablewrap"><table style="min-width:520px">
    <thead><tr><th>Remark the case carried when it reopened</th><th>Cases</th><th>Share</th></tr></thead>
    <tbody>
      <tr class="head"><td class="lbl">All reopened cases</td><td>${reopened.length}</td><td>100%</td></tr>
      ${reopRows}
    </tbody></table></div>
  <div class="callout">The dominant remark is <b>“Resolved by Old CSP”</b> — the case was closed on the CSP's word rather than on a confirmed ping, and the line went down again. Every reopen with that remark is a closure-quality problem, not a network problem.</div>
</section>

<section id="csps">
  <div class="sec-head"><span class="sec-no">04</span><h2>The CSPs behind the unresolved cases</h2></div>
  <p class="sub">${winUnres.length} unresolved cases across ${winLabel} sit with ${Object.keys(cspWk).length} distinct CSPs. The top 15 below carry ${pct(cspTopSum, winUnres.length)} of them. Breach rate is that CSP's unresolved cases as a share of everything they received in the window.</p>
  <div class="tablewrap"><table style="min-width:880px">
    <thead><tr><th>CSP</th><th><span class="ch">Week −3</span><span class="cd">${periods[0].label}</span></th><th><span class="ch">Week −2</span><span class="cd">${periods[1].label}</span></th><th><span class="ch">Week −1</span><span class="cd">${periods[2].label}</span></th><th>Total</th><th>Cases received</th><th>Breach rate</th><th>Refund-eligible</th><th>Calls at PTL</th></tr></thead>
    <tbody>${cspRows}
      <tr class="head"><td class="lbl">Top 15 together</td><td>${cspTop.reduce((a, x) => a + x[1][3], 0)}</td><td>${cspTop.reduce((a, x) => a + x[1][2], 0)}</td><td>${cspTop.reduce((a, x) => a + x[1][1], 0)}</td><td class="mtd">${cspTopSum}</td><td>${cspTop.reduce((a, x) => a + (cspTot[x[0]] || 0), 0)}</td><td>${pct(cspTopSum, winUnres.length)} of all unresolved</td><td>${cspTop.reduce((a, x) => a + (cspElig[x[0]] || 0), 0)}</td><td class="pend">—</td></tr>
    </tbody></table></div>
  <div class="callout"><b>Calls at PTL is not wired yet.</b> The tracker holds no call data — the count of calls raised against each CSP's pending issues has to come from the PTL system. Point us at that source (a sheet, a Metabase card, or an export) and the column fills automatically every week.</div>
</section>

<section id="whynorefund">
  <div class="sec-head"><span class="sec-no">05</span><h2>Why the no-ping unresolved cases were not refunded</h2></div>
  <p class="sub">${winElig.length} cases across ${winLabel} breached 48 hours, never pinged again, and are therefore owed a refund. Two readings: what the ground says is blocking the fix, and what the refund desk has recorded against the case.</p>

  <h4>What the ground reported</h4>
  <div class="tablewrap"><table style="min-width:520px">
    <thead><tr><th>Ground remark</th><th>Cases</th><th>Share</th></tr></thead>
    <tbody>
      <tr class="head"><td class="lbl">Refund-eligible cases</td><td>${winElig.length}</td><td>100%</td></tr>
      ${eligRows}
    </tbody></table></div>

  <h4>What the refund desk recorded</h4>
  <div class="tablewrap"><table style="min-width:520px">
    <thead><tr><th>Refund action</th><th>Cases</th><th>Share</th></tr></thead>
    <tbody>${actRows}</tbody></table></div>
  <div class="callout">Two different blockers are mixed in here. <b>CSP not responding</b> and <b>CSP denied to resolve</b> are supply-side — the customer is owed the refund and the CSP owes us an answer. <b>Cx DNP</b> and <b>plan expired</b> are demand-side — the money cannot be moved until the customer picks up. They need separate escalation paths, not one queue.</div>
</section>

<footer>
  High Pain Customer Tracker · generated by <span class="mono">scripts/weekly-review.js</span> from live Firebase data.<br>
  Resolution, reopen and refund definitions match the tracker exactly — a case counts as resolved only when its ping is restored or the CSP closure is confirmed.
</footer>

</div>`;

  const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    headBits + '\n</head>\n<body>\n' + bodyInner + '\n</body>\n</html>\n';

  fs.writeFileSync(OUT, html, 'utf8');
  fs.writeFileSync(path.join(__dirname, '..', 'weekly-review.artifact.html'), headBits + '\n' + bodyInner + '\n', 'utf8');
  console.log('wrote', OUT, html.length, 'bytes');
  periods.forEach((p, i) => console.log(p.key, p.label, JSON.stringify(S[i])));
})();
