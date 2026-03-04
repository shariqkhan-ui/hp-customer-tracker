/**
 * High Pain Customers — Daily Funnel Report
 *
 * Fetches all cases from Firebase, calculates funnel metrics,
 * and sends a formatted report to the Slack channel at 10 PM IST daily.
 *
 * Required env vars: SLACK_BOT_TOKEN
 */

const https = require('https');

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

  const cc   = '<@U077923R68H> <@U08E4KETML1>';
  const attachment = {
    color:     '#E5178F',
    mrkdwn_in: ['text'],
    text:      '```\n' + lines.join('\n') + '\n```',
  };
  const text = `📊 *High Pain Customers — Daily Report | ${todayStr()}*\ncc: ${cc}`;

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
  } else {
    console.error('ERROR sending report:', res.error);
    process.exit(1);
  }
})();
