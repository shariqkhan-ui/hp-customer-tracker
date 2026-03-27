const express = require('express');
const path    = require('path');
const { fork } = require('child_process');
const cron    = require('node-cron');

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
// Runs every hour from 10 AM to 7 PM IST (Asia/Kolkata)
// More reliable than GitHub Actions which has unpredictable delays
cron.schedule('0 10-19 * * *', () => {
  console.log('[CRON] Starting Kapture sync…');
  const child = fork(path.join(__dirname, 'scripts', 'kapture-sync.js'), [], {
    env: process.env,
  });
  child.on('exit', (code) => {
    console.log('[CRON] Kapture sync finished, exit code:', code);
  });
  child.on('error', (err) => {
    console.error('[CRON] Failed to start Kapture sync:', err.message);
  });
}, { timezone: 'Asia/Kolkata' });
