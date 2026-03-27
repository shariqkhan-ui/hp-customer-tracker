const express    = require('express');
const path       = require('path');
const { fork }   = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('HP Tracker running on port ' + PORT);
});

// ── Kapture Auto-Sync Cron ────────────────────────────────────────────────────
// Runs every hour from 10 AM to 7 PM IST, no external dependencies.
// Checks every minute if we're at the top of an eligible hour, then fires once.

let lastSyncHour = -1;

setInterval(() => {
  // Get current IST time (UTC+5:30)
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist  = new Date(now.getTime() + istOffset);
  const hour = ist.getUTCHours();   // 0-23 in IST
  const min  = ist.getUTCMinutes();

  // Fire at minute 0 of each hour between 10:00 and 19:00 IST
  if (min === 0 && hour >= 10 && hour <= 19 && hour !== lastSyncHour) {
    lastSyncHour = hour;
    console.log(`[CRON] ${ist.toISOString()} IST — starting Kapture sync`);
    const child = fork(path.join(__dirname, 'scripts', 'kapture-sync.js'), [], {
      env: process.env,
    });
    child.on('exit',  (code) => console.log('[CRON] Sync done, exit code:', code));
    child.on('error', (err)  => console.error('[CRON] Sync error:', err.message));
  }
}, 60 * 1000); // check every minute
