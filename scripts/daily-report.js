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
  if (g === 'resolved by old partner') return 'Ping Up';
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
  if (lastRun === today) {
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
    if (remarks === 'No Overlapping Partner/Refund' || remarks === 'Migration not possible/Refund') hostNotAligned++;
  }

  const resolved   = migrated + pingUp;
  const unresolved = total - resolved;

  // ── Build Slack message ───────────────────────────────────────────────────
  const LINE   = '━'.repeat(49);
  const HEADER = '  Metric'.padEnd(38) + 'Value'.padStart(5) + '%'.padStart(6);
  const lines  = [
    HEADER,
    LINE,
    row('Tickets Received (72 hrs)',  total,          total, false, true),
    row('Resolved',                   resolved,       total, false, true),
    row('Migrated',                   migrated,       total, true,  false),
    row('Resolved by Same Partner',   pingUp,         total, true,  false),
    row('Refund (Unresolved)',         unresolved,     total, false, true),
    row('Customer Denied',            custDenied,     total, true,  false),
    row('Host Partner Not Aligned',   hostNotAligned, total, true,  false),
    LINE,
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
})();
