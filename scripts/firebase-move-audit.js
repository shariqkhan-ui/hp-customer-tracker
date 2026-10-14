#!/usr/bin/env node
// One-off (14 Oct 2026): take the audit log out of the case node.
// /cases/__audit__ grew to 3.8 MB inside the node every tracker load reads;
// /audit_log (the original home) had been write-protected since Mar 2026.
// Steps, in order and each verified before the next:
//   1. rules: allow writes on /audit_log (keep everything else as is)
//   2. copy every row of /cases/__audit__ into /audit_log (keys preserved)
//   3. verify every key landed, then delete /cases/__audit__
// Readers in the tracker already merge /audit_log and /cases/__audit__.
//
//   FIREBASE_SERVICE_ACCOUNT='{...}' node scripts/firebase-move-audit.js
//
'use strict';
const https = require('https');
const crypto = require('crypto');
const DB = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';

function req(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: headers || {} }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
async function token() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const payload = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sign = crypto.createSign('RSA-SHA256'); sign.update(header + '.' + payload);
  const jwt = header + '.' + payload + '.' + sign.sign(sa.private_key, 'base64url');
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString();
  const r = await req('POST', 'https://oauth2.googleapis.com/token', body, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) });
  const j = JSON.parse(r.body); if (!j.access_token) throw new Error('token: ' + r.body.slice(0, 200)); return j.access_token;
}
(async () => {
  const t = await token();
  const auth = '?access_token=' + t;
  // 1. rules
  const cur = await req('GET', DB + '/.settings/rules.json' + auth);
  const rules = JSON.parse(cur.body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, ''));
  const root = rules.rules;
  if (!root.audit_log || root.audit_log['.write'] !== true) {
    root.audit_log = Object.assign({}, root.audit_log || {}, { '.write': true });
    const put = await req('PUT', DB + '/.settings/rules.json' + auth, JSON.stringify(rules, null, 2), { 'Content-Type': 'application/json' });
    if (put.status !== 200) throw new Error('rules PUT ' + put.status + ' ' + put.body.slice(0, 200));
    console.log('rules: /audit_log is writable again');
  } else console.log('rules: /audit_log already writable');
  // 2. copy
  const src = JSON.parse((await req('GET', DB + '/cases/__audit__.json' + auth)).body) || {};
  const keys = Object.keys(src);
  console.log('rows under /cases/__audit__:', keys.length);
  if (!keys.length) { console.log('nothing to move'); return; }
  const existing = JSON.parse((await req('GET', DB + '/audit_log.json?shallow=true' + '&access_token=' + t)).body) || {};
  const clash = keys.filter(k => existing[k]);
  if (clash.length) throw new Error('key clash with /audit_log: ' + clash.slice(0, 3).join(','));
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = {}; keys.slice(i, i + 500).forEach(k => chunk[k] = src[k]);
    const r = await req('PATCH', DB + '/audit_log.json' + auth, JSON.stringify(chunk), { 'Content-Type': 'application/json' });
    if (r.status !== 200) throw new Error('copy chunk ' + i + ' -> ' + r.status + ' ' + r.body.slice(0, 200));
  }
  // 3. verify, then delete the old node
  const after = JSON.parse((await req('GET', DB + '/audit_log.json?shallow=true' + '&access_token=' + t)).body) || {};
  const missing = keys.filter(k => !after[k]);
  console.log('verified in /audit_log:', keys.length - missing.length, 'of', keys.length);
  if (missing.length) throw new Error('not deleting: ' + missing.length + ' rows did not land');
  const del = await req('DELETE', DB + '/cases/__audit__.json' + auth);
  console.log('deleted /cases/__audit__ ->', del.status);
  const sz = await req('GET', DB + '/cases.json?orderBy=%22added_at%22&endAt=' + (new Date('2026-07-29T00:00:00+05:30').getTime() - 1));
  console.log('older-cases query is now', (Buffer.byteLength(sz.body) / 1e6).toFixed(1), 'MB');
})().catch(e => { console.error(e); process.exit(1); });
