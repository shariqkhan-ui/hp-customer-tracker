#!/usr/bin/env node
// One-off (14 Oct 2026): add ".indexOn": ["added_at"] under /cases in the
// Realtime Database rules, so the tracker can load the flag-era cases first
// (orderBy added_at) instead of the whole 18 MB store. Idempotent: re-running
// leaves the rules as they are if the index is already present.
//
//   FIREBASE_SERVICE_ACCOUNT='{...}' node scripts/firebase-add-index.js
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
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('FIREBASE_SERVICE_ACCOUNT required'); process.exit(1); }
  const t = await token();
  const cur = await req('GET', DB + '/.settings/rules.json?access_token=' + t);
  if (cur.status !== 200) throw new Error('rules GET ' + cur.status + ': ' + cur.body.slice(0, 200));
  // rules JSON may contain comments; strip // and /* */ before parsing
  const text = cur.body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  const rules = JSON.parse(text);
  const root = rules.rules || (rules.rules = {});
  const cases = root.cases || (root.cases = {});
  const have = cases['.indexOn'] ? [].concat(cases['.indexOn']) : [];
  console.log('current /cases .indexOn:', JSON.stringify(have), '| rules keys:', Object.keys(root));
  if (have.includes('added_at')) { console.log('index already present - nothing to do'); return; }
  cases['.indexOn'] = have.concat(['added_at']);
  const put = await req('PUT', DB + '/.settings/rules.json?access_token=' + t, JSON.stringify(rules, null, 2), { 'Content-Type': 'application/json' });
  console.log('rules PUT ->', put.status, put.body.slice(0, 120));
  const chk = await req('GET', DB + '/cases.json?orderBy=%22added_at%22&startAt=1785436200000&limitToFirst=1');
  console.log('indexed query ->', chk.status, chk.body.slice(0, 80));
})().catch(e => { console.error(e); process.exit(1); });
