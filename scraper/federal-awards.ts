/**
 * Federal Awards Silent Ingestion Scraper
 * =======================================
 * What it does:
 *   Pulls federal construction-related contract awards from two sources:
 *     1. SAM.gov Contract Awards API (requires free API key)
 *     2. USAspending.gov API (no authentication required)
 *
 *   Filters for NAICS codes in construction trades and place of performance
 *   in TX or TN. Merges results into a unified RawAward schema.
 *
 * How to run it:
 *   ts-node scraper/federal-awards.ts [daysBack]
 *   SAM_GOV_API_KEY=your_key node --loader ts-node/esm scraper/federal-awards.ts [daysBack]
 *
 * Environment variables:
 *   SAM_GOV_API_KEY    — Required for SAM.gov API calls
 *   DEBUG=1            — Enable verbose console logging
 *
 * No external dependencies — uses Node.js built-in fetch (Node 18+).
 */

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface RawAward {
  source: 'sam.gov' | 'usaspending.gov';
  awardId: string;
  awardeeName: string;
  awardeeUei?: string;
  awardAmount: number;
  awardDate: string; // ISO 8601
  naicsCode: string;
  popState: string;
  popCity?: string;
  popZip?: string;
  agencyName: string;
  description: string;
  rawPayload: unknown;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Construction-related NAICS codes */
const NAICS_CODES = [
  '237310', '237990', '236115', '236116', '236117', '236118',
  '238210', '238220', '238320', '238340', '238350',
];

const POCI_STATES = ['TX', 'TN'];

const SAM_GOV_BASE = 'https://api.sam.gov/contract-awards/v1/search';
const USASPENDING_BASE = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

// =============================================================================
// DATE HELPERS
// =============================================================================

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// =============================================================================
// FETCH WITH EXPONENTIAL BACKOFF
// =============================================================================

async function fetchWithBackoff(
  input: RequestInfo,
  init?: RequestInit,
  retries = 3
): Promise<unknown> {
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(input, init);

      if (res.status === 429) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.error(`[FederalAwards] Rate limited (429). Backing off ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${res.statusText} — ${body.slice(0, 200)}`);
      }

      return await res.json();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastErr ?? new Error('Unknown fetch error');
}

// =============================================================================
// SAM.GOV SCRAPER
// =============================================================================

async function scrapeSamGov(startDate: string, endDate: string): Promise<RawAward[]> {
  const apiKey = process.env.SAM_GOV_API_KEY;
  if (!apiKey) {
    console.error('[FederalAwards] SAM_GOV_API_KEY not set. Skipping SAM.gov.');
    return [];
  }

  const awards: RawAward[] = [];
  let page = 1;
  const limit = 100;
  let hasMore = true;

  while (hasMore && page <= 50) {
    const params = new URLSearchParams({
      api_key: apiKey,
      naics: NAICS_CODES.join('~'),
      pociState: POCI_STATES.join('~'),
      q: `modified_date:[${startDate} TO ${endDate}]`,
      limit: String(limit),
      page: String(page),
    });

    const url = `${SAM_GOV_BASE}?${params.toString()}`;
    console.error(`[FederalAwards] SAM.gov page ${page}...`);

    try {
      const data = (await fetchWithBackoff(url)) as {
        awards?: unknown[];
        totalRecords?: number;
        error?: unknown;
        errorMessage?: string;
      };

      if (data.error || data.errorMessage) {
        console.error('[FederalAwards] SAM.gov error:', data.errorMessage || JSON.stringify(data.error));
        break;
      }

      const records = (data.awards ?? []) as Array<Record<string, unknown>>;
      console.error(`[FederalAwards] SAM.gov returned ${records.length} records`);

      for (const r of records) {
        try {
          const award: RawAward = {
            source: 'sam.gov',
            awardId: String(r['awardId'] ?? r['piid'] ?? r['awardID'] ?? ''),
            awardeeName: String(r['awardeeName'] ?? r['vendorName'] ?? r['recipientName'] ?? ''),
            awardeeUei: r['ueiSAM'] ? String(r['ueiSAM']) : undefined,
            awardAmount: Number(r['awardAmount'] ?? r['baseAndAllOptionsValue'] ?? r['obligatedAmount'] ?? 0),
            awardDate: String(r['awardDate'] ?? r['dateSigned'] ?? r['effectiveDate'] ?? ''),
            naicsCode: String(r['naics'] ?? r['naicsCode'] ?? ''),
            popState: String(r['placeOfPerformanceState'] ?? r['popStateCode'] ?? ''),
            popCity: r['placeOfPerformanceCity'] ? String(r['placeOfPerformanceCity']) : undefined,
            popZip: r['placeOfPerformanceZIP'] ? String(r['placeOfPerformanceZIP']) : undefined,
            agencyName: String(r['awardingAgencyName'] ?? r['agencyId'] ?? ''),
            description: String(r['description'] ?? r['awardDescription'] ?? r['purpose'] ?? ''),
            rawPayload: r,
          };
          if (award.awardId) awards.push(award);
        } catch (err) {
          console.error('[FederalAwards] Failed to transform SAM.gov record:', err);
        }
      }

      hasMore = records.length === limit;
      page++;
      if (hasMore) await new Promise((r) => setTimeout(r, 1000)); // 1 req/sec max
    } catch (err) {
      console.error('[FederalAwards] SAM.gov fetch error:', err);
      break;
    }
  }

  return awards;
}

// =============================================================================
// USASPENDING.GOV SCRAPER
// =============================================================================

async function scrapeUsaSpending(startDate: string, endDate: string): Promise<RawAward[]> {
  const awards: RawAward[] = [];
  let page = 1;
  const limit = 100;
  let hasMore = true;

  while (hasMore && page <= 50) {
      const body = {
      filters: {
        time_period: [{ start_date: startDate, end_date: endDate }],
        place_of_performance: POCI_STATES.map((s) => ({ country: 'USA', state: s })),
        naics_codes: { require: NAICS_CODES },
        // Use only contract award types in one group to satisfy USAspending SOQL validation.
        award_type_codes: ['A', 'B', 'C', 'D'],
      },
      fields: [
        'Award ID',
        'Recipient Name',
        'Award Amount',
        'Start Date',
        'End Date',
        'Awarding Agency',
        'Awarding Sub Agency',
        'Place of Performance State Code',
        'Place of Performance City',
        'Place of Performance ZIP5',
        'NAICS',
        'Base Obligation Date',
        'Description',
      ],
      page,
      limit,
    };

    console.error(`[FederalAwards] USAspending page ${page}...`);

    try {
      const data = (await fetchWithBackoff(USASPENDING_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })) as { results?: unknown[]; error?: unknown; message?: string };

      if (data.error || data.message) {
        console.error('[FederalAwards] USAspending error:', data.message || JSON.stringify(data.error));
        break;
      }

      const records = (data.results ?? []) as Array<Record<string, unknown>>;
      console.error(`[FederalAwards] USAspending returned ${records.length} records`);

      for (const r of records) {
        try {
          const award: RawAward = {
            source: 'usaspending.gov',
            awardId: String(r['Award ID'] ?? r['award_id'] ?? r['generated_internal_id'] ?? ''),
            awardeeName: String(r['Recipient Name'] ?? r['recipient_name'] ?? ''),
            awardeeUei: r['recipient_uei'] ? String(r['recipient_uei']) : undefined,
            awardAmount: Number(r['Award Amount'] ?? r['award_amount'] ?? r['federal_action_obligation'] ?? 0),
            awardDate: String(r['Base Obligation Date'] ?? r['action_date'] ?? r['Start Date'] ?? ''),
            naicsCode: String(r['NAICS'] ?? r['naics_code'] ?? ''),
            popState: String(r['Place of Performance State Code'] ?? r['pop_state_code'] ?? ''),
            popCity: r['Place of Performance City'] ? String(r['Place of Performance City']) : undefined,
            popZip: r['Place of Performance ZIP5'] ? String(r['Place of Performance ZIP5']) : undefined,
            agencyName: String(r['Awarding Agency'] ?? r['awarding_agency_name'] ?? ''),
            description: String(r['Description'] ?? r['award_description'] ?? r['purpose'] ?? ''),
            rawPayload: r,
          };
          if (award.awardId) awards.push(award);
        } catch (err) {
          console.error('[FederalAwards] Failed to transform USAspending record:', err);
        }
      }

      hasMore = records.length === limit;
      page++;
      if (hasMore) await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error('[FederalAwards] USAspending fetch error:', err);
      break;
    }
  }

  return awards;
}

// =============================================================================
// MAIN SCRAPER
// =============================================================================

/**
 * Scrape federal construction awards from SAM.gov and USAspending.gov.
 *
 * @param daysBack - Number of days back from today to search (default: 1)
 * @returns Array of standardized RawAward objects. Empty array on failure.
 *
 * @example
 * ```ts
 * import { scrapeFederalAwards } from './scraper/federal-awards';
 * const awards = await scrapeFederalAwards(30);
 * ```
 */
export async function scrapeFederalAwards(daysBack: number = 1): Promise<RawAward[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);

  console.error(`[FederalAwards] Searching awards from ${startStr} to ${endStr} (${daysBack} days back)`);

  // Run both scrapers in parallel
  const [samAwards, spendingAwards] = await Promise.all([
    scrapeSamGov(startStr, endStr).catch((err) => {
      console.error('[FederalAwards] SAM.gov scraper failed:', err);
      return [] as RawAward[];
    }),
    scrapeUsaSpending(startStr, endStr).catch((err) => {
      console.error('[FederalAwards] USAspending scraper failed:', err);
      return [] as RawAward[];
    }),
  ]);

  const merged = [...samAwards, ...spendingAwards];

  // Deduplicate by awardId + source
  const seen = new Set<string>();
  const unique = merged.filter((a) => {
    const key = `${a.source}:${a.awardId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.error(`[FederalAwards] Returning ${unique.length} unique awards (SAM: ${samAwards.length}, USAspending: ${spendingAwards.length})`);
  return unique;
}

// =============================================================================
// STANDALONE EXECUTION
// =============================================================================

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? '1', 10);
  const awards = await scrapeFederalAwards(days);
  console.log(JSON.stringify(awards, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
