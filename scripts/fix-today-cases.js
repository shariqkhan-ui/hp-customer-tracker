// One-off: keeps only the original 41 cases from the first morning sync.
// Deletes any 05-Mar-2026 case that wasn't in the original run.
const https = require('https');

const FIREBASE_DB = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';

// Exact 41 tickets added in the first morning sync (run 22704216942)
const ORIGINAL_41 = new Set([
  '772371510093','772422180334','772419770737','772364508132','772372496231',
  '772358027051','772352717606','772421153254','772374300907','772422682366',
  '772424689581','772429779691','772419385148','772426460662','772419440746',
  '772429758541','772369523188','772420119983','772354297470','772361947870',
  '772412150250','772425556696','772420801540','772377367868','772366605433',
  '772379572497','772368728039','772261246699','772371993257','772423916838',
  '772361858831','772422787176','772428291663','772420646213','772428411466',
  '772428460216','772429103874','772354485586','772429159146','772426352849',
  '772363153372'
]);

function ticketKey(t) { return String(t).replace(/[.#$[\]/ ]/g, '_'); }

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
  console.log('Fetching Firebase cases...');
  const data  = await httpRequest('GET', FIREBASE_DB + '/cases.json', null, {});
  const cases = Object.entries(data);

  let deleted = 0;
  for (const [key, c] of cases) {
    if ((c.case_added_on || '').trim() !== '05-Mar-2026') continue;
    if (!c.ticket_url) continue; // skip manually added cases
    const ticketId = String(c.ticket_no || '').trim();
    if (!ORIGINAL_41.has(ticketId)) {
      await httpRequest('DELETE', FIREBASE_DB + '/cases/' + key + '.json', null, {});
      console.log(`  Deleted extra: ${ticketId}`);
      deleted++;
    }
  }

  console.log(`Done. Removed ${deleted} extra cases. Original 41 preserved.`);
})();
