/**
 * One-off retrospective backfill of blank customer details on existing cases.
 *
 * Fills, for every case already in Firebase:
 *   - blank `mobile`    -> looked up by ticket number in SERVICE_TICKET_MODEL,
 *                          falling back to T_TICKETS_NEW (~95% recoverable).
 *   - blank `cust_name` -> looked up by the last-10-digits of mobile across three
 *                          customer sources in priority order (COALESCE):
 *                          COMBINED_T_WG_CUSTOMER -> STG_INVENTORY_MODEL_CUSTOMER_INSTALLS
 *                          -> ACTIVE_CUST (~99.9% recoverable). A mobile recovered
 *                          in this same run is used to resolve the name too.
 *
 * This mirrors the fallback the live sync now uses, so the historical data ends up
 * consistent with what new cron-added cases will look like. It only ever writes the
 * two fields above, and only when they are currently blank and a value is found.
 *
 * Usage (same secrets as kapture-sync.js):
 *   node scripts/backfill-names.js           # DRY RUN — prints what it would do, writes nothing
 *   APPLY=1 node scripts/backfill-names.js    # actually patches Firebase
 *
 * Required env vars: METABASE_API_KEY, FIREBASE_SERVICE_ACCOUNT (only for APPLY)
 */

const https = require('https');

const FIREBASE_DB    = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const METABASE_URL   = 'https://metabase.wiom.in';
const METABASE_DB_ID = 113;
const APPLY          = process.env.APPLY === '1';
const CHUNK          = 1000;

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function norm(m) { return String(m == null ? '' : m).replace(/\D/g, '').slice(-10); }
function ticketKey(t) { return String(t).replace(/[.#$[\]/ ]/g, '_'); }

// ── HTTP ──────────────────────────────────────────────────────────────────────

function httpRequest(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Firebase auth ────────────────────────────────────────────────────────────

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
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt,
  }).toString();
  const res = await new Promise((resolve, reject) => {
    const url = new URL('https://oauth2.googleapis.com/token');
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(body); req.end();
  });
  if (!res.access_token) throw new Error('Failed to get Firebase token: ' + JSON.stringify(res));
  _fbToken = res.access_token;
  return _fbToken;
}

async function fbGet(path) { return httpRequest('GET', FIREBASE_DB + path + '.json', null, {}); }
async function fbPatch(path, value) {
  const token = await getFirebaseToken();
  return httpRequest('PATCH', FIREBASE_DB + path + '.json?access_token=' + token, value, {});
}

// ── Metabase ───────────────────────────────────────────────────────────────────

async function queryMetabase(sql, apiKey) {
  const result = await httpRequest('POST', METABASE_URL + '/api/dataset',
    { database: METABASE_DB_ID, type: 'native', native: { query: sql } }, { 'x-api-key': apiKey });
  if (result.error) throw new Error('Metabase query error: ' + JSON.stringify(result.error));
  const cols = (result.data?.cols || []).map(c => c.name);
  const rows = result.data?.rows || [];
  return rows.map(row => { const o = {}; cols.forEach((c, i) => (o[c] = row[i])); return o; });
}

const q = (s, k) => queryMetabase(s, k);

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const apiKey = process.env.METABASE_API_KEY;
  if (!apiKey) { console.error('Missing METABASE_API_KEY'); process.exit(1); }
  if (APPLY && !process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('APPLY=1 needs FIREBASE_SERVICE_ACCOUNT'); process.exit(1); }
  log(APPLY ? 'MODE: APPLY (will write to Firebase)' : 'MODE: DRY RUN (no writes) — set APPLY=1 to write');

  const cases = await fbGet('/cases') || {};
  const keys  = Object.keys(cases);
  log(`Total cases: ${keys.length}`);

  // ── Pass 1: recover blank MOBILE by ticket number ──────────────────────────
  const needMobile = [];   // { key, ticket }
  for (const key of keys) {
    const c = cases[key] || {};
    if (norm(c.mobile).length === 10) continue;
    const ticket = String(c.ticket_no || key).trim();
    if (ticket) needMobile.push({ key, ticket });
  }
  log(`Blank-mobile cases: ${needMobile.length}`);

  const mobileByTicket = new Map();  // ticket(string) -> raw mobile
  if (needMobile.length) {
    const tickets = [...new Set(needMobile.map(x => x.ticket))];
    for (const [tbl, idCol, mobCol] of [['SERVICE_TICKET_MODEL', 'KAPTURE_TICKET_ID', 'CUSTOMER_MOBILE'],
                                        ['T_TICKETS_NEW', 'KAPTURE_TICKET_ID', 'MOBILE']]) {
      const still = tickets.filter(t => !mobileByTicket.has(t));
      if (!still.length) break;
      for (let i = 0; i < still.length; i += CHUNK) {
        const inList = still.slice(i, i + CHUNK).map(t => `'${t}'`).join(',');
        const rows = await q(`SELECT ${idCol}::string AS TID, MAX(${mobCol}::string) AS MOB
          FROM ${tbl} WHERE ${mobCol} IS NOT NULL AND TRIM(${mobCol}::string) != ''
            AND ${idCol}::string IN (${inList}) GROUP BY 1`, apiKey);
        rows.forEach(r => { if (r.MOB) mobileByTicket.set(String(r.TID), String(r.MOB).trim()); });
      }
      log(`  after ${tbl}: recovered ${mobileByTicket.size}/${tickets.length} mobiles`);
    }
  }

  // Effective mobile per case (existing or just-recovered) for the name pass.
  const effMobile = key => {
    const c = cases[key] || {};
    if (norm(c.mobile).length === 10) return norm(c.mobile);
    const ticket = String(c.ticket_no || key).trim();
    return norm(mobileByTicket.get(ticket));
  };

  // ── Pass 2: recover blank NAME by mobile (COMBINED -> INSTALLS -> ACTIVE) ───
  const needName = [];  // { key, mob }
  for (const key of keys) {
    const c = cases[key] || {};
    if (String(c.cust_name || '').trim()) continue;
    const mob = effMobile(key);
    if (mob.length === 10) needName.push({ key, mob });
  }
  log(`Blank-name cases with a usable mobile: ${needName.length}`);

  const nameByMob = new Map();  // mob -> name (first source wins = priority)
  const wanted = [...new Set(needName.map(x => x.mob))];
  const sources = [
    ['COMBINED_T_WG_CUSTOMER', 'NAME', 'MOBILE'],
    ['STG_INVENTORY_MODEL_CUSTOMER_INSTALLS', 'CUSTOMER_NAME', 'MOBILE'],
    ['ACTIVE_CUST', 'CUSTOMER_NAME', 'MOBILE'],
  ];
  for (const [tbl, nameCol, mobCol] of sources) {
    const still = wanted.filter(m => !nameByMob.has(m));
    if (!still.length) break;
    for (let i = 0; i < still.length; i += CHUNK) {
      const inList = still.slice(i, i + CHUNK).map(m => `'${m}'`).join(',');
      const rows = await q(`SELECT RIGHT(REGEXP_REPLACE(${mobCol},'[^0-9]',''),10) AS MOB, MAX(${nameCol}) AS CNAME
        FROM ${tbl} WHERE ${nameCol} IS NOT NULL AND TRIM(${nameCol}) != ''
          AND RIGHT(REGEXP_REPLACE(${mobCol},'[^0-9]',''),10) IN (${inList}) GROUP BY 1`, apiKey);
      rows.forEach(r => { if (r.CNAME && !nameByMob.has(String(r.MOB))) nameByMob.set(String(r.MOB), String(r.CNAME).trim()); });
    }
    log(`  after ${tbl}: resolved ${nameByMob.size}/${wanted.length} names`);
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  let mobPatched = 0, namePatched = 0, shown = 0;
  for (const key of keys) {
    const c = cases[key] || {};
    const patch = {};
    if (norm(c.mobile).length !== 10) {
      const rec = mobileByTicket.get(String(c.ticket_no || key).trim());
      if (rec) patch.mobile = rec;
    }
    if (!String(c.cust_name || '').trim()) {
      const nm = nameByMob.get(effMobile(key));
      if (nm) patch.cust_name = nm;
    }
    if (!Object.keys(patch).length) continue;
    if (patch.mobile) mobPatched++;
    if (patch.cust_name) namePatched++;
    if (APPLY) {
      try { await fbPatch('/cases/' + ticketKey(key), patch); }
      catch (e) { log(`  ERROR patching ${key}: ${e.message}`); continue; }
    }
    if (shown++ < 20) log(`  ${APPLY ? 'Patched' : 'Would patch'} ${key} -> ${JSON.stringify(patch)}`);
  }

  log(`Done. ${APPLY ? 'Patched' : 'Would patch'} mobile: ${mobPatched}, name: ${namePatched}.`);
  if (!APPLY) log('DRY RUN — nothing was written. Re-run with APPLY=1 to apply.');
})().catch(e => { console.error(e); process.exit(1); });
