// One-off: keeps only the 1st (oldest) and last (newest) bot messages, deletes the rest
const https = require('https');

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
  const token   = process.env.SLACK_BOT_TOKEN;
  const channel = 'C0AHDR8H4CC';

  const hist = await httpRequest('GET',
    `https://slack.com/api/conversations.history?channel=${channel}&limit=20`,
    null, { 'Authorization': 'Bearer ' + token }
  );

  if (!hist.ok) { console.error('Failed to fetch history:', hist.error); process.exit(1); }

  // messages are newest-first, so reverse to get oldest-first
  const botMsgs = hist.messages.filter(m => m.bot_id).reverse();
  console.log(`Found ${botMsgs.length} bot messages.`);

  if (botMsgs.length <= 2) { console.log('2 or fewer messages — nothing to delete.'); return; }

  // Keep index 0 (oldest) and last index (newest), delete everything in between
  const toDelete = botMsgs.slice(1, -1);
  console.log(`Keeping 1st (ts=${botMsgs[0].ts}) and last (ts=${botMsgs[botMsgs.length-1].ts})`);
  console.log(`Deleting ${toDelete.length} message(s)...`);

  for (const m of toDelete) {
    const res = await httpRequest('POST',
      'https://slack.com/api/chat.delete',
      { channel, ts: m.ts },
      { 'Authorization': 'Bearer ' + token }
    );
    console.log(`  ts=${m.ts} → ${res.ok ? 'deleted' : res.error}`);
  }
  console.log('Done.');
})();
