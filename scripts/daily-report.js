/**
 * High Pain Customers — Daily Funnel Report
 *
 * Fetches all cases from Firebase, calculates funnel metrics,
 * and sends a formatted report to the Slack channel at 10 PM IST daily.
 *
 * Required env vars: SLACK_BOT_TOKEN
 */

const https = require('https');
const crypto = require('crypto');

const FIREBASE_DB = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const SLACK_CHANNEL = 'C0AHDR8H4CC';
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function todayStr() {
  const d = new Date();
  return String(d.getDate()).padStart(2,'0') + '-' + MONTHS_SHORT[d.getMonth()] + '-' + d.getFullYear();
}

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
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Firebase auth (service account → access token) ───────────────────────────

async function getFirebaseToken() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${sign.sign(sa.private_key, 'base64url')}`;

  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString();
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  if (!res.access_token) throw new Error('Failed to get Firebase token: ' + JSON.stringify(res));
  return res.access_token;
}

// ── Status logic (mirrors dashboard getStatus) ───────────────────────────────
function getStatus(c) {
  if ((c.migration_date || '').trim()) return 'Migrated';
  const g      = (c.remarks || '').toLowerCase().trim();
  const subcat = (c.subcat  || '').toLowerCase();
  // Accept both the legacy 'Resolved by Old Partner' and the renamed
  // 'Resolved by Old CSP' (dropdown wording changed 5 Aug 2026)
  if (g === 'resolved by old partner' || g === 'resolved by old csp') return 'Ping Up';
  const pingKw      = ['ping up','internet working','internet up','speed up','link up'];
  const pingSubcats = ['internet supply down','recharge done but no internet'];
  if (pingSubcats.some(s => subcat.includes(s)) && pingKw.some(kw => g.includes(kw))) return 'Ping Up';
  return 'Unresolved';
}

// ── Format helpers ────────────────────────────────────────────────────────────
function pct(num, total) {
  if (!total) return '  0%';
  return String(Math.round((num / total) * 100)) + '%';
}

function row(label, count, total, indent, bold) {
  const prefix = indent ? '    ↳ ' : bold ? '► ' : '  ';
  const l = (prefix + label).padEnd(38);
  const c = String(count).padStart(5);
  const p = pct(count, total).padStart(6);
  return l + c + p;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { console.error('ERROR: SLACK_BOT_TOKEN not set.'); process.exit(1); }

  // ── Idempotency check: skip if already ran successfully today ─────────────
  const today = todayStr();
  const lastRun = await httpRequest('GET', FIREBASE_DB + '/run_flags/daily_report.json', null, {});
  if (lastRun === today && process.env.FORCE_RUN !== 'true') {
    console.log(`Already ran today (${today}) — skipping.`);
    return;
  }

  console.log('Fetching all cases from Firebase…');
  const data = await httpRequest('GET', FIREBASE_DB + '/cases.json', null, {});

  if (!data || typeof data !== 'object') {
    console.error('ERROR: Could not fetch cases from Firebase.');
    process.exit(1);
  }

  const cases = Object.values(data);
  console.log(`Total cases fetched: ${cases.length}`);

  // ── Calculate metrics ─────────────────────────────────────────────────────
  const total = cases.length;

  let migrated  = 0;
  let pingUp    = 0;
  let custDenied    = 0;
  let hostNotAligned = 0;

  for (const c of cases) {
    const status  = getStatus(c);
    const remarks = (c.remarks || '').trim();

    if (status === 'Migrated') migrated++;
    else if (status === 'Ping Up') pingUp++;

    // Subparts of Unresolved/Refund
    if (remarks === 'Customer not interested in Migration' || remarks === 'Cx not contactable/Reachable') custDenied++;
    if (remarks === 'No Overlapping Partner/Refund' || remarks === 'No Overlapping CSP/Refund' || remarks === 'Migration not possible/Refund') hostNotAligned++;
  }

  const resolved   = migrated + pingUp;
  const unresolved = total - resolved;

  // ── 48h flag metric (cases added since the 29 Jul launch) ─────────────────
  // Resolved within 48 hrs of entering the tracker, % of MATURED cases
  // (those that have completed their full 48-hour window).
  const LAUNCH = Date.parse('2026-07-29T00:00:00+05:30');
  const LIM48  = 48 * 3600000;
  const NOW    = Date.now();
  let matured48 = 0, within48 = 0;
  for (const c of cases) {
    const start = Number(c.added_at) || Number(c.owner_assigned_at) || 0;
    if (start < LAUNCH || (NOW - start) < LIM48) continue;
    matured48++;
    if (getStatus(c) === 'Unresolved') continue;
    // NET of reopened: a resolution that was later reopened doesn't count
    if (Number(c.reopened_at) > 0 || String(c.source) === 'reopened-cron') continue;
    const rt = Number(c.remarks_updated_at) || 0;
    if (rt > 0 && (rt - start) <= LIM48) within48++;
    else if (!rt && (c.migration_date || '').trim()) within48++;
  }

  // ── Build Slack message ───────────────────────────────────────────────────
  const LINE   = '━'.repeat(49);
  const HEADER = '  Metric'.padEnd(38) + 'Value'.padStart(5) + '%'.padStart(6);
  const lines  = [
    HEADER,
    LINE,
    row('Tickets Received (72 hrs)',  total,          total, false, true),
    row('Resolved',                   resolved,       total, false, true),
    row('Migrated',                   migrated,       total, true,  false),
    row('Resolved by Same CSP',       pingUp,         total, true,  false),
    row('Refund (Unresolved)',         unresolved,     total, false, true),
    row('Customer Denied',            custDenied,     total, true,  false),
    row('Host CSP Not Aligned',       hostNotAligned, total, true,  false),
    LINE,
    row('Resolved within 48 hrs*',    within48,       matured48, false, true),
    LINE,
    '* 48h flag (live 29 Jul): % of ' + matured48 + ' matured cases',
  ];

  const cc         = '<@U077923R68H> <@U08E4KETML1>';
  const tableText  = '```\n' + lines.join('\n') + '\n```';
  const text       = `📊 *High Pain Customers — Daily Report | ${todayStr()}*\ncc: ${cc}`;

  // Using blocks inside attachment keeps the color bar and prevents Slack's "Show more" truncation
  const attachment = {
    color:  '#E5178F',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: tableText } },
    ],
  };

  console.log('Sending report to Slack…');
  const res = await httpRequest(
    'POST',
    'https://slack.com/api/chat.postMessage',
    {
      channel:     SLACK_CHANNEL,
      username:    "Shariq's Slack Agent",
      icon_url:    'https://raw.githubusercontent.com/shariqkhan-ui/hp-customer-tracker/master/shariq-agent.jpg',
      text,
      attachments: [attachment],
    },
    { 'Authorization': 'Bearer ' + token }
  );

  if (res.ok) {
    console.log('Report sent successfully.');
    // Mark today as done so duplicate cron runs are skipped
    const fbToken = await getFirebaseToken();
    await httpRequest('PUT', FIREBASE_DB + '/run_flags/daily_report.json?access_token=' + fbToken, today, {});
  } else {
    console.error('ERROR sending report:', res.error);
    process.exit(1);
  }

  // ── Weekly-meeting action items (added by Shariq in the tracker's Action
  // Items tab; stored at /cases/__action_items__). Posted daily so owners see
  // their open items and mark status in the tracker. Never fails the report.
  try {
    const ai = await httpRequest('GET', FIREBASE_DB + '/cases/__action_items__.json', null, {}) || {};
    const items = Object.values(ai).filter(v => v && v.item);
    if (items.length) {
      const open = items.filter(v => v.status !== 'Done')
        .sort((a, b) => (a.owner || '').localeCompare(b.owner || ''));
      const doneN = items.length - open.length;
      const ICON = { 'Open': '⬜', 'In Progress': '🔄', 'Blocked': '🔴' };
      const aiLines = open.map((v, i) =>
        `${i + 1}. ${ICON[v.status] || '⬜'} *${v.item}* — ${v.owner || 'unassigned'}` +
        (v.due ? ` (due ${v.due})` : '') + (v.notes ? `\n     _${v.notes}_` : ''));
      const aiText =
        `📋 *Weekly Meeting — Action Items* (${open.length} open · ${doneN} done)\n` +
        (open.length ? aiLines.join('\n') : 'All items closed ✅') +
        `\n\n👉 Update your item's status here: https://hp-customer-tracker-production.up.railway.app/ → Action Items tab`;
      const res2 = await httpRequest('POST', 'https://slack.com/api/chat.postMessage', {
        channel: SLACK_CHANNEL,
        username: "Shariq's Slack Agent",
        icon_url: 'https://raw.githubusercontent.com/shariqkhan-ui/hp-customer-tracker/master/shariq-agent.jpg',
        text: aiText,
      }, { 'Authorization': 'Bearer ' + token });
      console.log(res2.ok ? 'Action items posted.' : 'Action items post FAILED: ' + res2.error);
    } else {
      console.log('No action items yet — skipping that post.');
    }
  } catch (e) { console.error('Action items section failed (non-fatal):', e.message); }
})();
