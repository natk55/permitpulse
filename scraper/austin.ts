/**
 * Austin Build + Connect (AB+C) Permit Scraper
 * ============================================
 * What it does:
 *   Scrapes permit data from the City of Austin's AMANDA-based citizen portal
 *   (https://abc.austintexas.gov/citizenportal/app/public-search) using Playwright.
 *   Intercepts XHR responses containing /api/forms/ to extract JSON permit data
 *   directly from the Angular SPA's internal API — no HTML parsing.
 *
 * How to run it:
 *   ts-node scraper/austin.ts [daysBack]
 *   node --loader ts-node/esm scraper/austin.ts [daysBack]
 *
 * Environment variables:
 *   HEADFUL=1      — Run browser in headed mode for debugging
 *   DEBUG=1        — Enable verbose console logging
 *
 * Required dependency: playwright
 */

import { chromium, Browser, Page } from 'playwright';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface RawPermit {
  permitNumber: string;
  permitType: string;
  trade: 'hvac' | 'electrical' | 'plumbing' | 'roofing' | 'drywall' | 'unknown';
  filedDate: string; // ISO 8601
  issuedDate?: string;
  status: string;
  workDescription: string;
  estimatedValue?: number;
  address: {
    street: string;
    city: string;
    state: string; // 'TX'
    zip: string;
  };
  contractor?: {
    name: string;
    licenseNumber: string;
    phone: string;
  };
  applicant?: {
    name: string;
    phone: string;
  };
}

/** Internal shape of Angular SPA XHR response */
interface AustinApiResponse {
  data?: {
    result?: unknown[] | unknown;
    [key: string]: unknown;
  };
  result?: unknown[] | unknown;
  [key: string]: unknown;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const TARGET_URL = 'https://abc.austintexas.gov/citizenportal/app/public-search';

const CONFIG = {
  viewport: { width: 1920, height: 1080 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/Chicago',
  geolocation: { latitude: 30.2672, longitude: -97.7431 },
  navigationTimeout: 60000,
  xhrWaitMs: 5000,
  maxRequestsPerSecond: 1,
};

// =============================================================================
// TRADE CLASSIFICATION
// =============================================================================

const TRADE_KEYWORDS: Record<string, string[]> = {
  hvac: ['hvac', 'air condition', 'heating', 'cooling', 'ventilation', 'duct', 'furnace', 'ac unit', 'heat pump', 'refrigeration', 'mechanical'],
  electrical: ['electrical', 'electric', 'wiring', 'panel', 'circuit', 'breaker', 'conduit', 'lighting', 'outlet', 'service upgrade'],
  plumbing: ['plumbing', 'plumber', 'water heater', 'sewer', 'drain', 'pipe', 'fixture', 'toilet', 'faucet', 'gas line', 'sprinkler'],
  roofing: ['roof', 'roofing', 'shingle', 'tile roof', 'metal roof', 'flat roof', 'roof repair', 'roof replacement'],
  drywall: ['drywall', 'sheetrock', 'wallboard', 'gypsum', 'interior wall', 'partition', 'wall finish'],
};

function classifyTrade(permitType: string = '', workDescription: string = ''): RawPermit['trade'] {
  const text = `${permitType} ${workDescription}`.toLowerCase();
  for (const [trade, keywords] of Object.entries(TRADE_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) return trade as RawPermit['trade'];
  }
  return 'unknown';
}

// =============================================================================
// ADDRESS PARSING
// =============================================================================

function parseAddress(raw: string = ''): RawPermit['address'] {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/^(.+?)[,\s]+([A-Za-z\s]+)[,\s]+([A-Za-z]{2})[,\s]+(\d{5}(-\d{4})?)$/);
  if (match) {
    return { street: match[1].trim(), city: match[2].trim(), state: match[3].trim().toUpperCase(), zip: match[4].trim() };
  }
  const zipMatch = cleaned.match(/(\d{5}(-\d{4})?)$/);
  const zip = zipMatch ? zipMatch[1] : '';
  const stateMatch = cleaned.match(/,\s*([A-Za-z]{2})\s+\d{5}/);
  const state = stateMatch ? stateMatch[1].toUpperCase() : 'TX';
  return {
    street: cleaned.replace(/,\s*[A-Za-z\s]+,\s*[A-Za-z]{2}\s*\d{5}(-\d{4})?$/, '').trim() || cleaned,
    city: 'Austin',
    state,
    zip,
  };
}

// =============================================================================
// DATA TRANSFORMATION
// =============================================================================

function isReCaptchaChallenge(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) return false;
  const obj = response as Record<string, unknown>;
  const text = JSON.stringify(response).toLowerCase();
  return (
    text.includes('recaptcha') ||
    text.includes('captcha') ||
    text.includes('challenge') ||
    obj['error'] === 'RECAPTCHA_REQUIRED' ||
    obj['g-recaptcha-response'] !== undefined
  );
}

function transformRecord(record: unknown): RawPermit | null {
  if (typeof record !== 'object' || record === null) return null;
  const r = record as Record<string, unknown>;

  try {
    const permitNumber = String(r['permitNumber'] ?? r['permit_number'] ?? r['id'] ?? r['permitID'] ?? '').trim();
    if (!permitNumber) return null;

    const permitType = String(r['permitType'] ?? r['permit_type'] ?? r['type'] ?? 'Unknown');
    const workDescription = String(r['workDescription'] ?? r['description'] ?? r['purpose'] ?? '');

    // Address
    let address: RawPermit['address'];
    const addrObj = r['address'] as Record<string, unknown> | undefined;
    if (addrObj && typeof addrObj === 'object') {
      address = {
        street: String(addrObj['street'] ?? addrObj['addressLine1'] ?? addrObj['address'] ?? ''),
        city: String(addrObj['city'] ?? 'Austin'),
        state: String(addrObj['state'] ?? 'TX').toUpperCase(),
        zip: String(addrObj['zip'] ?? addrObj['postalCode'] ?? ''),
      };
    } else {
      address = parseAddress(String(r['address'] ?? r['addressFull'] ?? ''));
    }

    // Contractor
    const contractorObj = r['contractor'] as Record<string, unknown> | undefined;
    const licenseeObj = r['licensee'] as Record<string, unknown> | undefined;
    const contractor = contractorObj || licenseeObj
      ? {
          name: String((contractorObj ?? licenseeObj)!['name'] ?? ''),
          licenseNumber: String((contractorObj ?? licenseeObj)!['licenseNumber'] ?? (contractorObj ?? licenseeObj)!['license'] ?? ''),
          phone: String((contractorObj ?? licenseeObj)!['phone'] ?? (contractorObj ?? licenseeObj)!['phone1'] ?? ''),
        }
      : undefined;

    // Applicant
    const applicantObj = r['applicant'] as Record<string, unknown> | undefined;
    const applicant = applicantObj
      ? {
          name: String(applicantObj['name'] ?? ''),
          phone: String(applicantObj['phone'] ?? applicantObj['phone1'] ?? ''),
        }
      : undefined;

    // Dates
    const filedRaw = r['filedDate'] ?? r['filed_date'] ?? r['dateFiled'] ?? r['enteredDate'];
    const issuedRaw = r['issuedDate'] ?? r['issued_date'] ?? r['dateIssued'];
    const filedDate = filedRaw ? new Date(String(filedRaw)).toISOString() : new Date().toISOString();
    const issuedDate = issuedRaw ? new Date(String(issuedRaw)).toISOString() : undefined;

    // Value
    let estimatedValue: number | undefined;
    const valRaw = r['estimatedValue'] ?? r['estimated_value'] ?? r['constructionCost'] ?? r['valuation'];
    if (valRaw !== undefined) {
      const val = typeof valRaw === 'string' ? parseFloat(valRaw.replace(/[$,]/g, '')) : Number(valRaw);
      estimatedValue = isNaN(val) ? undefined : val;
    }

    return {
      permitNumber,
      permitType,
      trade: classifyTrade(permitType, workDescription),
      filedDate,
      issuedDate,
      status: String(r['status'] ?? r['statusDisplay'] ?? 'Unknown'),
      workDescription,
      estimatedValue,
      address,
      contractor,
      applicant,
    };
  } catch (err) {
    console.error('[AustinScraper] transformRecord error:', err);
    return null;
  }
}

// =============================================================================
// STEALTH HELPERS
// =============================================================================

async function applyStealth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }],
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // @ts-expect-error
    window.chrome = window.chrome || {};
    // @ts-expect-error
    window.chrome.runtime = window.chrome.runtime || {};
  });
  await page.context().grantPermissions(['geolocation']);
}

function humanDelay(min = 800, max = 2500): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// MAIN SCRAPER
// =============================================================================

/**
 * Scrape permits from Austin Build + Connect public search.
 *
 * @param daysBack - Number of days back from today to search (default: 1)
 * @returns Array of standardized RawPermit objects. Empty array on failure.
 *
 * @example
 * ```ts
 * import { scrapeAustinPermits } from './scraper/austin';
 * const permits = await scrapeAustinPermits(7);
 * ```
 */
export async function scrapeAustinPermits(daysBack: number = 1): Promise<RawPermit[]> {
  const allPermits: RawPermit[] = [];
  const interceptedData: unknown[] = [];
  let browser: Browser | null = null;

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  const startStr = startDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const endStr = endDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  console.error(`[AustinScraper] Searching permits from ${startStr} to ${endStr} (${daysBack} days back)`);

  try {
    // Launch headless Chromium with realistic settings
    browser = await chromium.launch({
      headless: process.env.HEADFUL !== '1',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      viewport: CONFIG.viewport,
      userAgent: CONFIG.userAgent,
      locale: CONFIG.locale,
      timezoneId: CONFIG.timezoneId,
      geolocation: CONFIG.geolocation,
      permissions: ['geolocation'],
      colorScheme: 'light',
    });

    const page = await context.newPage();
    await applyStealth(page);

    // -------------------------------------------------------------------------
    // Set up XHR response interception for /api/forms/
    // -------------------------------------------------------------------------
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/api/forms/')) return;

      console.error(`[AustinScraper] Intercepted XHR: ${url}`);

      try {
        const json = (await response.json()) as AustinApiResponse;
        if (isReCaptchaChallenge(json)) {
          console.error('[AustinScraper] ABORT: reCAPTCHA challenge detected in response');
          return;
        }

        const results = json.data?.result ?? json.result;
        if (results) {
          const arr = Array.isArray(results) ? results : [results];
          console.error(`[AustinScraper] Captured ${arr.length} records from XHR`);
          interceptedData.push(...arr);
        }
      } catch {
        // Ignore non-JSON responses
      }
    });

    // -------------------------------------------------------------------------
    // Navigate and wait for Angular SPA to load
    // -------------------------------------------------------------------------
    console.error('[AustinScraper] Navigating to public search...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: CONFIG.navigationTimeout });

    // Wait for Angular bootstrap
    await page.waitForFunction(
      () => document.querySelector('app-root') !== null && document.querySelector('app-root')!.children.length > 0,
      { timeout: 30000 }
    );
    console.error('[AustinScraper] Angular app loaded');

    // -------------------------------------------------------------------------
    // Fill search filters
    // -------------------------------------------------------------------------
    await humanDelay();

    // Find date inputs
    const dateInputs = await page.locator('input[type="date"], input[placeholder*="date" i], mat-form-field input').all();
    for (const input of dateInputs) {
      const placeholder = (await input.getAttribute('placeholder')) ?? '';
      const ariaLabel = (await input.getAttribute('aria-label')) ?? '';
      const isStart = /from|start|begin/i.test(`${placeholder} ${ariaLabel}`);
      const isEnd = /to|end|through/i.test(`${placeholder} ${ariaLabel}`);

      if (isStart) {
        await input.scrollIntoViewIfNeeded();
        await humanDelay(300, 800);
        await input.fill(startStr);
        await input.press('Tab');
      } else if (isEnd) {
        await input.scrollIntoViewIfNeeded();
        await humanDelay(300, 800);
        await input.fill(endStr);
        await input.press('Tab');
      }
    }

    // Select trade filter if available (try common selectors)
    const tradeSelect = await page.locator('mat-select[placeholder*="trade" i], select[name*="trade" i], mat-select').first();
    if (await tradeSelect.isVisible().catch(() => false)) {
      await tradeSelect.click();
      await humanDelay(400, 800);
      // Select all trades or first option
      const options = await page.locator('mat-option, .mat-option').all();
      if (options.length > 0) {
        await options[0].click(); // "All" or first trade
      }
      await humanDelay(200, 500);
    }

    await humanDelay();

    // -------------------------------------------------------------------------
    // Click search and wait for XHR
    // -------------------------------------------------------------------------
    const searchBtn = await page.locator('button:has-text("Search"), [type="submit"], button:has-text("Search")').first();
    if (await searchBtn.isVisible().catch(() => false)) {
      await searchBtn.scrollIntoViewIfNeeded();
      await humanDelay(400, 900);
      await searchBtn.click();
      console.error('[AustinScraper] Search triggered');
    } else {
      await page.keyboard.press('Enter');
      console.error('[AustinScraper] Search triggered via Enter key');
    }

    // Wait for XHR responses to complete
    console.error(`[AustinScraper] Waiting ${CONFIG.xhrWaitMs}ms for XHR responses...`);
    await page.waitForTimeout(CONFIG.xhrWaitMs);

    // -------------------------------------------------------------------------
    // Transform and deduplicate
    // -------------------------------------------------------------------------
    console.error(`[AustinScraper] Total raw records intercepted: ${interceptedData.length}`);

    for (const record of interceptedData) {
      const permit = transformRecord(record);
      if (permit) allPermits.push(permit);
    }

    const seen = new Set<string>();
    const unique = allPermits.filter((p) => {
      if (seen.has(p.permitNumber)) return false;
      seen.add(p.permitNumber);
      return true;
    });

    console.error(`[AustinScraper] Returning ${unique.length} unique permits`);
    return unique;

  } catch (err) {
    console.error('[AustinScraper] Fatal error:', err);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// =============================================================================
// STANDALONE EXECUTION
// =============================================================================

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? '1', 10);
  const permits = await scrapeAustinPermits(days);
  // Print JSON to stdout
  console.log(JSON.stringify(permits, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
