/**
 * One-off retrospective backfill: fill blank `cust_name` on existing cases.
 *
 * Why this exists:
 *   The auto-sync now resolves customer names via a normalized (last-10-digit),
 *   deduped mobile join. But the ~hundreds of cases already sitting in Firebase
 *   with a blank name won't all self-heal — the sync's enrichment path only
 *   re-touches cases that are STILL open and within the 72h–14d window. Anything
 *   aged out or resolved would stay blank forever. This script fixes every blank
 *   case, regardless of age/status, by looking its name up the same way the sync
 *   now does.
 *
 * Scope: only writes `cust_name`, and only for cases where it is currently blank
 * and a name is actually found. It never touches any other field.
 *
 * Usage (from GitHub Actions or locally, same secrets as kapture-sync.js):
 *   node scripts/backfill-names.js           # DRY RUN — prints what it would do, writes nothing
 *   APPLY=1 node scripts/backfill-names.js    # actually patches Firebase
 *
 * Required env vars: METABASE_API_KEY, FIREBASE_SERVICE_ACCOUNT
 */

const https = require('https');

const FIREBASE_DB    = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const METABASE_URL   = 'https://metabase.wiom.in';
const METABASE_DB_ID = 113;
const APPLY          = process.env.APPLY === '1';
const CHUNK          = 500;   // mobiles per Metabase query

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Last 10 digits — matches the normalization used in the sync's name join.
function norm(m) { return String(m == null ? '' : m).replace(/\D/g, '').slice(-10); }

// ── HTTP ──────────────────────────────────────────────────────────────────────

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

// ── Firebase auth (service account → access token) ───────────────────────────

let _fbToken = null;
async function getFirebaseToken() {
  if (_fbToken) return _fbToken;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const res = await new Promise((resolve, reject) => {
    const url = new URL('https://oauth2.googleapis.com/token');
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  if (!res.access_token) throw new Error('Failed to get Firebase token: ' + JSON.stringify(res));
  _fbToken = res.access_token;
  return _fbToken;
}

async function fbGet(path) {
  return httpRequest('GET', FIREBASE_DB + path + '.json', null, {});
}
async function fbPatch(path, value) {
  const token = await getFirebaseToken();
  return httpRequest('PATCH', FIREBASE_DB + path + '.json?access_token=' + token, value, {});
}

// ── Metabase ───────────────────────────────────────────────────────────────────

async function queryMetabase(sql, apiKey) {
  const result = await httpRequest(
    'POST', METABASE_URL + '/api/dataset',
    { database: METABASE_DB_ID, type: 'native', native: { query: sql } },
    { 'x-api-key': apiKey }
  );
  if (result.error) throw new Error('Metabase query error: ' + result.error);
  const cols = (result.data?.cols || []).map(c => c.name);
  const rows = result.data?.rows || [];
  return rows.map(row => { const o = {}; cols.forEach((c, i) => (o[c] = row[i])); return o; });
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey) { console.error('Missing METABASE_API_KEY'); process.exit(1); }

  log(APPLY ? 'MODE: APPLY (will write to Firebase)' : 'MODE: DRY RUN (no writes) — set APPLY=1 to write');

  // 1. Pull every case.
  const cases = await fbGet('/cases') || {};
  const keys  = Object.keys(cases);
  log(`Total cases in Firebase: ${keys.length}`);

  // 2. Find blank-name cases that have a mobile to look up.
  const targets = [];          // { key, mob }
  let blankNoMobile = 0;
  for (const key of keys) {
    const c = cases[key] || {};
    if (String(c.cust_name || '').trim()) continue;   // already has a name
    const mob = norm(c.mobile);
    if (mob.length !== 10) { blankNoMobile++; continue; }  // nothing to look up
    targets.push({ key, mob });
  }
  log(`Blank-name cases: ${targets.length + blankNoMobile}  (lookup-able: ${targets.length}, no valid mobile: ${blankNoMobile})`);
  if (!targets.length) { log('Nothing to backfill.'); return; }

  // 3. Resolve names for the needed mobiles (chunked IN lists).
  const wanted = [...new Set(targets.map(t => t.mob))];
  const nameByMob = new Map();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const slice = wanted.slice(i, i + CHUNK);
    const inList = slice.map(m => `'${m}'`).join(',');
    const sql = `
      SELECT RIGHT(REGEXP_REPLACE(MOBILE, '[^0-9]', ''), 10) AS MOB, MAX(NAME) AS CNAME
      FROM COMBINED_T_WG_CUSTOMER
      WHERE NAME IS NOT NULL AND TRIM(NAME) != ''
        AND RIGHT(REGEXP_REPLACE(MOBILE, '[^0-9]', ''), 10) IN (${inList})
      GROUP BY 1
    `;
    const rows = await queryMetabase(sql, apiKey);
    rows.forEach(r => { if (r.CNAME) nameByMob.set(String(r.MOB), String(r.CNAME).trim()); });
    log(`  Resolved ${nameByMob.size}/${wanted.length} mobiles so far…`);
  }

  // 4. Patch each case whose name we found.
  let patched = 0, unresolved = 0;
  for (const t of targets) {
    const name = nameByMob.get(t.mob);
    if (!name) { unresolved++; continue; }
    if (APPLY) {
      try { await fbPatch('/cases/' + t.key, { cust_name: name }); }
      catch (e) { log(`  ERROR patching ${t.key}: ${e.message}`); continue; }
    }
    patched++;
    if (patched <= 20) log(`  ${APPLY ? 'Patched' : 'Would patch'} ${t.key} → "${name}"`);
  }

  log(`Done. ${APPLY ? 'Patched' : 'Would patch'}: ${patched}  |  no name found in source: ${unresolved}  |  no mobile: ${blankNoMobile}`);
  if (!APPLY) log('DRY RUN — nothing was written. Re-run with APPLY=1 to apply.');
})().catch(e => { console.error(e); process.exit(1); });
