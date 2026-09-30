#!/usr/bin/env node
// One-off: put back the 12 cases the Wiom Net purge deleted at 11:03 IST on
// 30 Sep 2026 while Metabase was rejecting the API key (the Hub lookup came
// back empty, so every no-CSP case read as "not in Wiom Hub"). Base fields
// come from SERVICE_TICKET_MODEL, the team's work comes back from the audit
// trail, and the tombstones are removed so the cases are not barred again.
//
//   METABASE_API_KEY=... FIREBASE_SERVICE_ACCOUNT='{...}' node scripts/restore-purged-30sep.js
//
'use strict';
const https = require('https');
const FIREBASE_DB = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const METABASE_URL = 'https://metabase.wiom.in';
const LOST = ['785340705098', '785508644417', '786155626470', '786356872465', '787382503521', '787580036406',
  '787580572989', '787917910659', '788411375115', '789633496889', '790244613301', '8787235597164'];
const PURGE_AT_MIN = 1790749900000, PURGE_AT_MAX = 1790750100000; // the 11:03 IST run

function httpRequest(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) } }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
async function mb(sql, key) {
  const r = await httpRequest('POST', METABASE_URL + '/api/dataset', { database: 113, type: 'native', native: { query: sql } }, { 'x-api-key': key });
  if (typeof r !== 'object' || !r.data || !Array.isArray(r.data.rows)) throw new Error('Metabase: ' + JSON.stringify(r).slice(0, 200));
  const cols = r.data.cols.map(c => c.name);
  return r.data.rows.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}
const fb = (m, path, body) => httpRequest(m, FIREBASE_DB + path + '.json', body);

(async () => {
  const key = process.env.METABASE_API_KEY;
  if (!key) { console.error('METABASE_API_KEY required'); process.exit(1); }
  const [audit, cases, tomb] = await Promise.all([fb('GET', '/cases/__audit__'), fb('GET', '/cases'), fb('GET', '/purged_tickets')]);
  const have = new Set(Object.values(cases || {}).filter(c => c && c.ticket_no).map(c => String(c.ticket_no).replace(/\D/g, '')));
  const rows = await mb(`SELECT KAPTURE_TICKET_ID, CUSTOMER_MOBILE, TICKET_ADDED_TIME, FIRST_TITLE, LAST_TITLE, CURRENT_PARTNER_NAME, CURRENT_TICKET_STATUS, IS_RESOLVED, FINAL_RESOLVED_TIME, FINAL_RESOLVED_NAME
    FROM PUBLIC.SERVICE_TICKET_MODEL WHERE KAPTURE_TICKET_ID IN (${LOST.map(t => "'" + t + "'").join(',')})`, key);
  const byT = Object.fromEntries(rows.map(r => [String(r.KAPTURE_TICKET_ID), r]));
  let restored = 0;
  for (const t of LOST) {
    if (have.has(t)) { console.log(t, 'already back in the tracker - skipped'); continue; }
    const r = byT[t]; if (!r) { console.log(t, 'NOT in SERVICE_TICKET_MODEL - skipped'); continue; }
    const tomb1 = (tomb || {})[t];
    if (!tomb1 || tomb1.reason !== 'not-in-wiom-hub' || tomb1.at < PURGE_AT_MIN || tomb1.at > PURGE_AT_MAX) { console.log(t, 'tombstone does not match the 11:03 purge - skipped', tomb1); continue; }
    // the team's work, replayed from the audit trail in time order
    const evs = Object.values(audit || {}).filter(a => a && String(a.ticket_no).replace(/\D/g, '') === t).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const c = {
      ticket_no: t, mobile: String(r.CUSTOMER_MOBILE || '').replace(/\D/g, '').slice(-10),
      partner: String(r.CURRENT_PARTNER_NAME || ''), subcat: String((/internet/i.test(r.FIRST_TITLE || '') ? r.FIRST_TITLE : r.LAST_TITLE) || ''),
      created_date: r.TICKET_ADDED_TIME ? new Date(r.TICKET_ADDED_TIME).toISOString().slice(0, 10) : '',
      added_at: evs.length ? Date.parse(evs[0].ts) : Date.parse(r.TICKET_ADDED_TIME) + 72 * 3600000,
      source: 'restored-30sep', restore_note: 'Restored 30 Sep 2026: wrongly purged as not-in-wiom-hub while Metabase rejected the API key',
      remarks: '', engineer: '', cx_action: '', refund_action: '', migration_date: '', kapture_status: r.IS_RESOLVED === 1 ? 'Completed' : 'Pending',
    };
    for (const e of evs) {
      const f = e.field; if (!f) continue;
      c[f] = e.new_value == null ? '' : String(e.new_value);
      if (f === 'remarks') c.remarks_updated_at = Date.parse(e.ts);
      if (f === 'engineer') c.engineer_assigned_at = Date.parse(e.ts);
      if (f === 'cx_action') c.cx_action_updated_at = Date.parse(e.ts);
    }
    await fb('PUT', '/cases/' + t, c);
    await fb('DELETE', '/purged_tickets/' + t);
    await fb('POST', '/cases/__audit__', { user_name: 'restore 30 Sep', ticket_no: t, field: 'case', old_value: 'purged not-in-wiom-hub 11:03', new_value: 'restored', ts: new Date().toISOString() });
    restored++; console.log(t, 'restored:', c.remarks || '(no remark)', '/', c.engineer || '(no engineer)');
  }
  console.log('restored', restored, 'of', LOST.length);
})().catch(e => { console.error(e); process.exit(1); });
