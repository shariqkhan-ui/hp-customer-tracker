const https = require('https');

const TOKEN   = process.env.SLACK_BOT_TOKEN;
const CHANNEL = 'C0AHDR8H4CC';

function api(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'slack.com',
      path: '/api/' + endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bearer ' + TOKEN
      }
    }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  const hist = await api('conversations.history', { channel: CHANNEL, limit: 10 });
  if (!hist.ok) { console.error('history error:', hist.error); process.exit(1); }

  const msg = hist.messages.find(m =>
    (m.text || '').includes('Daily Report') ||
    (m.attachments || []).some(a =>
      (a.blocks||[]).some(b => (((b.text||{}).text)||'').includes('Tickets Received'))
    )
  );
  if (!msg) { console.log('Report message not found.'); return; }
  console.log('Found ts=' + msg.ts);
  const del = await api('chat.delete', { channel: CHANNEL, ts: msg.ts });
  console.log(del.ok ? 'Deleted successfully.' : 'Delete error: ' + del.error);
})();
