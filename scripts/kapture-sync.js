/**
 * Kapture → High Pain Tracker Auto-Sync
 *
 * What it does:
 *   1. Logs into Kapture CRM (wiomin.kapturecrm.com)
 *   2. Intercepts Kapture's internal API responses to collect ticket data
 *   3. Filters for: pending/open tickets, internet-related sub-category, created 72+ hours ago
 *   4. Checks Firebase — skips tickets already in the tracker
 *   5. Adds new qualifying cases to Firebase with today's date as "Case Added On"
 *
 * Runs every hour via GitHub Actions (cron).
 * Required env vars: KAPTURE_USERNAME, KAPTURE_PASSWORD
 */

const { chromium } = require('playwright');
const https = require('https');

// ── Constants ────────────────────────────────────────────────────────────────

const FIREBASE_DB   = 'https://high-pain-cx-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const KAPTURE_BASE  = 'https://wiomin.kapturecrm.com';
const KAPTURE_ORG   = '957486452';  // from the ticket detail URL pattern

const MONTHS_SHORT  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Sub-category keywords that qualify as internet-related
const INTERNET_KEYWORDS = [
  'internet supply down',
  'slow speed',
  'frequent disconnection',
  'recharge done but no internet',
  'recharge done but internet not working',
  'no internet',
  'internet not working',
  'internet issue',
  'internet problem',
  'broadband down',
  'broadband issue',
  'speed issue',
  'speed problem',
  'connection issue',
  'wifi down',
  'wifi issue',
  'internet',
];

// Statuses in Kapture that mean the ticket is still open/pending
const OPEN_STATUSES = [
  'open',
  'pending',
  'in progress',
  'assigned',
  'unresolved',
  'new',
  'waiting',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function formatDateDDMonYYYY(date) {
  return String(date.getDate()).padStart(2, '0') + '-' +
    MONTHS_SHORT[date.getMonth()] + '-' +
    date.getFullYear();
}

function todayStr() {
  return formatDateDDMonYYYY(new Date());
}

function ticketKey(t) {
  // Match the same encoding used in index.html
  return String(t).replace(/[.#$[\]/ ]/g, '_');
}

function isInternetRelated(subcat) {
  const lower = (subcat || '').toLowerCase();
  return INTERNET_KEYWORDS.some(kw => lower.includes(kw));
}

function isOlderThan72Hours(dateValue) {
  if (!dateValue) return false;
  const created = new Date(dateValue);
  if (isNaN(created.getTime())) {
    // Try parsing common formats like "DD-Mon-YYYY" or "DD/MM/YYYY"
    const parts = String(dateValue).match(/(\d{1,2})[-/](\w+)[-/](\d{4})/);
    if (!parts) return false;
    const parsed = new Date(`${parts[2]} ${parts[1]}, ${parts[3]}`);
    if (isNaN(parsed.getTime())) return false;
    return (Date.now() - parsed.getTime()) >= 72 * 60 * 60 * 1000;
  }
  return (Date.now() - created.getTime()) >= 72 * 60 * 60 * 1000;
}

function isOpenStatus(status) {
  const lower = (status || '').toLowerCase();
  return OPEN_STATUSES.some(s => lower.includes(s));
}

function kaptureUrl(ticketId) {
  return `${KAPTURE_BASE}/nui/tickets/all/5/-1/0/detail/${KAPTURE_ORG}/${ticketId}?query=${ticketId}`;
}

// ── Firebase REST helpers ─────────────────────────────────────────────────────

function fbRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(FIREBASE_DB + path + '.json');
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  { 'Content-Type': 'application/json' },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });

    req.on('error', reject);

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function fbGet(path)         { return fbRequest('GET',  path); }
async function fbPut(path, value)  { return fbRequest('PUT',  path, value); }

// ── Ticket normaliser ─────────────────────────────────────────────────────────
// Kapture returns tickets in different shapes depending on the endpoint.
// This function extracts a consistent object from whatever shape we get.

function normaliseTicket(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Try common field name variants (Kapture uses inconsistent naming)
  const id      = raw.ticket_id    || raw.ticketId    || raw.id           || raw.ticket_no  || '';
  const mobile  = raw.mobile       || raw.phone        || raw.contact_no  || raw.customer_mobile || raw.mobileNo || '';
  const name    = raw.customer_name|| raw.customerName || raw.name        || raw.cust_name  || '';
  const partner = raw.partner      || raw.account_name || raw.company     || raw.brand      || '';
  const subcat  = raw.sub_category || raw.subCategory  || raw.sub_cat     || raw.category   || raw.sub_type || '';
  const status  = raw.status       || raw.ticket_status|| raw.ticketStatus|| '';
  const created = raw.created_at   || raw.createdAt    || raw.creation_date || raw.created_date || raw.date || '';
  const tat     = raw.tat          || raw.aging        || raw.pending_since || '';

  if (!id) return null;

  return { id: String(id), mobile, name, partner, subcat, status, created, tat };
}

// Recursively search for ticket arrays inside any JSON structure
function extractTickets(obj, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return [];

  // If it's an array, check if the items look like tickets
  if (Array.isArray(obj)) {
    const normed = obj.map(normaliseTicket).filter(Boolean);
    if (normed.length > 0) return normed;
    // Recurse into array items
    return obj.flatMap(item => extractTickets(item, depth + 1));
  }

  // If it's an object with a data/tickets/records/list key, recurse there
  const arrayKeys = ['data', 'tickets', 'records', 'list', 'result', 'results', 'items', 'payload'];
  for (const key of arrayKeys) {
    if (Array.isArray(obj[key])) {
      const normed = obj[key].map(normaliseTicket).filter(Boolean);
      if (normed.length > 0) return normed;
    }
  }

  // Generic recurse
  return Object.values(obj).flatMap(v => extractTickets(v, depth + 1));
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const username = process.env.KAPTURE_USERNAME;
  const password = process.env.KAPTURE_PASSWORD;

  if (!username || !password) {
    console.error('ERROR: KAPTURE_USERNAME and KAPTURE_PASSWORD env vars are required.');
    process.exit(1);
  }

  log('Starting Kapture → High Pain Tracker sync…');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const collectedTickets = [];

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      viewport:  { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    // ── Intercept all JSON responses from Kapture's internal API ──────────────
    page.on('response', async (response) => {
      const url = response.url();
      // Only process Kapture's own API calls (not static assets)
      if (!url.includes('kapturecrm.com')) return;
      if (!url.includes('/api/') && !url.includes('/v1/') && !url.includes('/v2/') &&
          !url.includes('/tickets') && !url.includes('/cases')) return;

      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;

      try {
        const body = await response.json();
        const tickets = extractTickets(body);
        if (tickets.length > 0) {
          log(`Intercepted ${tickets.length} ticket(s) from: ${url}`);
          collectedTickets.push(...tickets);
        }
      } catch {
        // Non-JSON or parsing error — skip silently
      }
    });

    // ── Step 1: Login ─────────────────────────────────────────────────────────
    log('Navigating to Kapture login…');

    // Try multiple possible login URLs
    const loginUrls = [
      KAPTURE_BASE + '/nui/login',
      KAPTURE_BASE + '/login',
      KAPTURE_BASE + '/',
      KAPTURE_BASE,
    ];

    let loginFound = false;
    for (const loginUrl of loginUrls) {
      log(`Trying login URL: ${loginUrl}`);
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000); // Wait for SPA to render

      // Screenshot for debugging — saved as artifact
      await page.screenshot({ path: 'login-page.png', fullPage: true });
      log(`Screenshot saved for: ${loginUrl}`);

      // Log all visible inputs to help identify correct selectors
      const inputs = await page.$$eval('input', els =>
        els.map(el => ({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder }))
      );
      log(`Inputs found on page: ${JSON.stringify(inputs)}`);

      const hasInput = await page.$('input');
      if (hasInput) {
        log(`Login form found at: ${loginUrl}`);
        loginFound = true;
        break;
      }
    }

    if (!loginFound) {
      throw new Error('Could not find login form on any known Kapture URL. Check login-page.png artifact.');
    }

    // Try common login form selectors
    const emailSel    = 'input[type="email"], input[type="text"], input[name="email"], input[name="username"], input[name="user_name"], input[name="userId"], #email, #username, input[placeholder*="email" i], input[placeholder*="user" i], input[placeholder*="mobile" i], input[placeholder*="phone" i]';
    const passwordSel = 'input[type="password"], input[name="password"], input[name="passwd"], #password';
    const submitSel   = 'button[type="submit"], input[type="submit"], .login-btn, .btn-login, button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")';

    await page.fill(emailSel, username);
    await page.fill(passwordSel, password);
    await page.screenshot({ path: 'login-filled.png' });
    await page.click(submitSel);

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: 'after-login.png' });
    log('Login step complete. URL after login: ' + page.url());

    // ── Step 2: Navigate to the all-tickets list view ─────────────────────────
    // Load the tickets list page — Kapture will fire its internal API calls
    // which we intercept above. Try a few URL patterns.
    const ticketListUrls = [
      `${KAPTURE_BASE}/nui/tickets/all/5/-1/0`,
      `${KAPTURE_BASE}/nui/tickets`,
      `${KAPTURE_BASE}/nui/cases`,
    ];

    for (const listUrl of ticketListUrls) {
      log(`Loading ticket list: ${listUrl}`);
      try {
        await page.goto(listUrl, { waitUntil: 'networkidle', timeout: 30000 });
        // Wait a bit for background API calls to complete
        await page.waitForTimeout(3000);
        break;
      } catch (e) {
        log(`Warning: ${listUrl} failed — ${e.message}`);
      }
    }

    // ── Step 3: Scroll / paginate to collect more tickets ─────────────────────
    // Some Kapture views load more tickets as you scroll down
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(1500);
    }

    // Try to click a "Load more" or "Next page" button if present
    const loadMoreSel = 'button:has-text("Load more"), button:has-text("Next"), .pagination-next, [aria-label="Next page"]';
    let hasMore = true;
    let pageCount = 0;
    while (hasMore && pageCount < 10) {
      try {
        const btn = await page.$(loadMoreSel);
        if (btn) {
          await btn.click();
          await page.waitForTimeout(2000);
          pageCount++;
        } else {
          hasMore = false;
        }
      } catch {
        hasMore = false;
      }
    }

    log(`Total tickets intercepted before filtering: ${collectedTickets.length}`);

  } finally {
    await browser.close();
  }

  // ── Step 4: De-duplicate intercepted tickets ──────────────────────────────
  const seen = new Set();
  const uniqueTickets = collectedTickets.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  log(`Unique tickets after de-dup: ${uniqueTickets.length}`);

  // ── Step 5: Apply our filter criteria ────────────────────────────────────
  const qualifying = uniqueTickets.filter(t => {
    const internet = isInternetRelated(t.subcat);
    const oldEnough = isOlderThan72Hours(t.created);
    const open = isOpenStatus(t.status);

    if (!internet)    log(`  Skip [not internet] ticket=${t.id} subcat="${t.subcat}"`);
    if (!oldEnough)   log(`  Skip [<72 hrs]      ticket=${t.id} created="${t.created}"`);
    if (!open)        log(`  Skip [closed]       ticket=${t.id} status="${t.status}"`);

    return internet && oldEnough && open;
  });

  log(`Qualifying cases (internet + 72hr+ + open): ${qualifying.length}`);

  if (qualifying.length === 0) {
    log('Nothing to add. Done.');
    return;
  }

  // ── Step 6: Check Firebase and add new cases ──────────────────────────────
  let added = 0, skipped = 0;

  for (const t of qualifying) {
    const key      = ticketKey(t.id);
    const existing = await fbGet('/cases/' + key);

    if (existing !== null) {
      log(`  Already exists — skip ticket=${t.id}`);
      skipped++;
      continue;
    }

    const payload = {
      case_added_on:  todayStr(),     // Today's date — when NQT adds it to the tracker
      ticket_no:      t.id,
      mobile:         t.mobile,
      subcat:         t.subcat,
      cust_name:      t.name,
      partner:        t.partner,
      tat:            t.tat || '72+ hours',
      remarks:        '',
      easy_remarks:   '',
      engineer:       '',             // NQT can assign via the dashboard
      ticket_url:     kaptureUrl(t.id),
      col12:          '',
      col13:          '',
      migration_date: '',
    };

    try {
      await fbPut('/cases/' + key, payload);
      log(`  Added ticket=${t.id} subcat="${t.subcat}" created="${t.created}"`);
      added++;
    } catch (e) {
      log(`  ERROR adding ticket=${t.id}: ${e.message}`);
    }
  }

  log(`Sync complete. Added: ${added}  Skipped (already existed): ${skipped}`);
})();
