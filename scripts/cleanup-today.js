/**
 * One-off cleanup: removes the cases added by the manual trigger on 05-Mar-2026
 * - Reverts the 6 date-updated cases back to 04-Mar-2026
 * - Deletes the 41 newly added cases
 * - Deletes today's Slack notification
 */
const https = require('https');

const FIREBASE_DB    = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const SLACK_CHANNEL  = 'C0AHDR8H4CC';

// These 6 were date-updated (existed before) — revert to 04-Mar-2026
const DATE_REVERT = new Set([
  '772348152234','772346849883','772347631687',
  '772348261253','772350544815','772344819609'
]);

function ticketKey(t) { return String(t).replace(/[.#$[\]/ ]/g, '_'); }

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

(async () => {
  const slackToken = process.env.SLACK_BOT_TOKEN;

  // ── Step 1: Fetch all Firebase cases ───────────────────────────────────────
  console.log('Fetching Firebase cases...');
  const data = await httpRequest('GET', FIREBASE_DB + '/cases.json', null, {});
  const cases = Object.entries(data);

  const toDelete = [];
  const toRevert = [];

  for (const [key, c] of cases) {
    if ((c.case_added_on || '').trim() !== '05-Mar-2026') continue;
    if (!c.ticket_url) continue; // skip manually added cases

    const ticketId = String(c.ticket_no || '').trim();
    if (DATE_REVERT.has(ticketId)) {
      toRevert.push(key);
    } else {
      toDelete.push(key);
    }
  }

  console.log(`To revert (date back to 04-Mar-2026): ${toRevert.length}`);
  console.log(`To delete (newly added): ${toDelete.length}`);

  // ── Step 2: Revert date-updated cases ──────────────────────────────────────
  for (const key of toRevert) {
    await httpRequest('PUT', FIREBASE_DB + '/cases/' + key + '/case_added_on.json', '04-Mar-2026', {});
    console.log(`  Reverted: ${key}`);
  }

  // ── Step 3: Delete newly added cases ───────────────────────────────────────
  for (const key of toDelete) {
    await httpRequest('DELETE', FIREBASE_DB + '/cases/' + key + '.json', null, {});
    console.log(`  Deleted: ${key}`);
  }

  // ── Step 4: Delete the Slack notification ──────────────────────────────────
  if (slackToken) {
    console.log('Fetching Slack history...');
    const hist = await httpRequest('GET',
      `https://slack.com/api/conversations.history?channel=${SLACK_CHANNEL}&limit=10`,
      null, { 'Authorization': 'Bearer ' + slackToken }
    );
    if (hist.ok) {
      const botMsgs = (hist.messages || []).filter(m => m.bot_id);
      if (botMsgs.length > 0) {
        const res = await httpRequest('POST',
          'https://slack.com/api/chat.delete',
          { channel: SLACK_CHANNEL, ts: botMsgs[0].ts },
          { 'Authorization': 'Bearer ' + slackToken }
        );
        console.log(`Slack msg ts=${botMsgs[0].ts} → ${res.ok ? 'deleted' : res.error}`);
      }
    }
  }

  console.log('Cleanup complete.');
})();
