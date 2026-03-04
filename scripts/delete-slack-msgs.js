// One-off: deletes today's bot messages from #high-pain-customer-management
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

  // Fetch recent messages
  const hist = await httpRequest('GET',
    `https://slack.com/api/conversations.history?channel=${channel}&limit=20`,
    null, { 'Authorization': 'Bearer ' + token }
  );

  if (!hist.ok) { console.error('Failed to fetch history:', hist.error); process.exit(1); }

  const botMsgs = hist.messages.filter(m => m.bot_id);
  console.log(`Found ${botMsgs.length} bot message(s). Deleting...`);

  for (const m of botMsgs) {
    const res = await httpRequest('POST',
      'https://slack.com/api/chat.delete',
      { channel, ts: m.ts },
      { 'Authorization': 'Bearer ' + token }
    );
    console.log(`  ts=${m.ts} → ${res.ok ? 'deleted' : res.error}`);
  }
  console.log('Done.');
})();
