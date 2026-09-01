const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ── NQT confirmation proofs: uploaded files live on the Railway volume ───────
// (mounted at /data) so they survive deploys. Served back at /proofs/<name>.
const PROOF_DIR = process.env.PROOF_DIR || '/data/proofs';
try { fs.mkdirSync(PROOF_DIR, { recursive: true }); } catch (e) { console.error('proof dir:', e.message); }

const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/amr': '.amr', 'audio/3gpp': '.3gp', 'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'application/pdf': '.pdf',
};
app.post('/upload-proof', express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
  try {
    const ticket = String(req.query.ticket || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40);
    const field = req.query.field === 'proof_recording' ? 'rec' : 'shot';
    if (!ticket || !req.body || !req.body.length) return res.status(400).json({ error: 'missing ticket or file' });
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const origName = String(req.query.name || '');
    const ext = EXT[ct] || (origName.match(/(\.[A-Za-z0-9]{1,5})$/) || [])[1] || '.bin';
    const name = ticket + '_' + field + '_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex') + ext.toLowerCase();
    fs.writeFileSync(path.join(PROOF_DIR, name), req.body);
    const url = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host) + '/proofs/' + name;
    console.log('proof uploaded:', name, req.body.length, 'bytes');
    res.json({ url });
  } catch (e) {
    console.error('upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.use('/proofs', express.static(PROOF_DIR, { maxAge: '365d', immutable: true }));

// index.html must never be cached — teams kept seeing stale UI after deploys
const noCache = (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate');
app.use(express.static(path.join(__dirname), {
  setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) noCache(res); },
}));

app.get('*', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('HP Tracker running on port ' + PORT);
});
