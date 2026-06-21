/**
 * Nashville, TN Building Permit Scraper
 * ======================================
 * What it does:
 *   Fetches building permit data from Metro Nashville's ArcGIS Hub Open Data
 *   portal via the standard ArcGIS REST API. No browser automation needed.
 *
 *   Endpoint discovered from hub:
 *   https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/Building_Permits_Issued_2/FeatureServer/0
 *
 * How to run it:
 *   ts-node scraper/nashville.ts [daysBack]
 *   node --loader ts-node/esm scraper/nashville.ts [daysBack]
 *
 * Environment variables:
 *   NASHVILLE_ARCGIS_URL — Override the default ArcGIS FeatureServer URL
 *   DEBUG=1              — Enable verbose console logging
 *
 * No external dependencies — uses Node.js built-in fetch (Node 18+).
 */

// =============================================================================
// TYPES & INTERFACES (shared with Austin scraper)
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
    state: string;
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

// =============================================================================
// ARCGIS CONFIGURATION
// =============================================================================

const DEFAULT_ARCGIS_URL =
  'https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/Building_Permits_Issued_2/FeatureServer/0';

const PAGE_SIZE = 1000;

/** Map ArcGIS field names to our schema */
const FIELD_MAP = {
  permitNumber: 'Permit__',
  permitType: 'Permit_Type_Description',
  filedDate: 'Date_Entered',
  issuedDate: 'Date_Issued',
  estimatedValue: 'Const_Cost',
  addressStreet: 'Address',
  addressCity: 'City',
  addressState: 'State',
  addressZip: 'ZIP',
  contractorName: 'Contact',
  workDescription: 'Purpose',
  permitSubtype: 'Permit_Subtype_Description',
  permitTypeCode: 'Per_Ty',
};

/** Trade normalization map from ArcGIS Per_Ty / Permit_Type_Description values */
const TRADE_NORMALIZATION: Record<string, RawPermit['trade']> = {
  mechanical: 'hvac',
  hvac: 'hvac',
  electrical: 'electrical',
  plumbing: 'plumbing',
  roofing: 'roofing',
  building: 'drywall',
  drywall: 'drywall',
};

// =============================================================================
// TRADE CLASSIFICATION
// =============================================================================

function classifyTrade(permitType: string = '', description: string = '', perTy: string = ''): RawPermit['trade'] {
  const text = `${permitType} ${description} ${perTy}`.toLowerCase();

  // Check normalization map first
  for (const [key, value] of Object.entries(TRADE_NORMALIZATION)) {
    if (text.includes(key)) return value;
  }

  // Fallback keyword matching
  const keywords: Record<string, string[]> = {
    hvac: ['hvac', 'air condition', 'heating', 'cooling', 'ventilation', 'duct', 'furnace', 'heat pump', 'mechanical'],
    electrical: ['electrical', 'electric', 'wiring', 'panel', 'circuit', 'breaker', 'conduit', 'lighting'],
    plumbing: ['plumbing', 'plumber', 'water heater', 'sewer', 'drain', 'pipe', 'fixture', 'gas line'],
    roofing: ['roof', 'roofing', 'shingle', 'tile roof', 'metal roof', 're-roof'],
    drywall: ['drywall', 'sheetrock', 'wallboard', 'gypsum', 'interior wall', 'partition'],
  };

  for (const [trade, kws] of Object.entries(keywords)) {
    if (kws.some((kw) => text.includes(kw))) return trade as RawPermit['trade'];
  }

  return 'unknown';
}

// =============================================================================
// ARCGIS DATE HELPERS
// =============================================================================

/**
 * ArcGIS date fields are stored as epoch milliseconds.
 * Convert a JS Date to the epoch ms string for WHERE clauses.
 */
function toArcGisEpoch(date: Date): number {
  return Math.floor(date.getTime());
}

/** Convert ArcGIS epoch ms to ISO 8601 string */
function fromArcGisEpoch(epochMs: number | null): string | undefined {
  if (!epochMs) return undefined;
  return new Date(epochMs).toISOString();
}

// =============================================================================
// FETCH WITH BACKOFF
// =============================================================================

async function fetchWithBackoff(url: string, retries = 3): Promise<unknown> {
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      });

      if (res.status === 429) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.error(`[NashvilleScraper] Rate limited (429). Backing off ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
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
// DATA TRANSFORMATION
// =============================================================================

function transformFeature(feature: unknown): RawPermit | null {
  if (typeof feature !== 'object' || feature === null) return null;
  const f = feature as Record<string, unknown>;
  const attrs = (f['attributes'] as Record<string, unknown>) ?? {};

  try {
    const permitNumber = String(attrs[FIELD_MAP.permitNumber] ?? '').trim();
    if (!permitNumber) return null;

    const permitType = String(attrs[FIELD_MAP.permitType] ?? 'Unknown');
    const perTy = String(attrs[FIELD_MAP.permitTypeCode] ?? '');
    const workDescription = String(attrs[FIELD_MAP.workDescription] ?? '');
    const filedDate = fromArcGisEpoch(attrs[FIELD_MAP.filedDate] as number | null) ?? new Date().toISOString();
    const issuedDate = fromArcGisEpoch(attrs[FIELD_MAP.issuedDate] as number | null);

    // Estimated value
    let estimatedValue: number | undefined;
    const valRaw = attrs[FIELD_MAP.estimatedValue];
    if (valRaw !== undefined && valRaw !== null) {
      const val = typeof valRaw === 'string' ? parseFloat(valRaw) : Number(valRaw);
      estimatedValue = isNaN(val) ? undefined : val;
    }

    // Address
    const address: RawPermit['address'] = {
      street: String(attrs[FIELD_MAP.addressStreet] ?? ''),
      city: String(attrs[FIELD_MAP.addressCity] ?? 'Nashville'),
      state: String(attrs[FIELD_MAP.addressState] ?? 'TN').toUpperCase(),
      zip: String(attrs[FIELD_MAP.addressZip] ?? ''),
    };

    // Contractor (Nashville only has "Contact" field, no separate license/phone)
    const contactName = String(attrs[FIELD_MAP.contractorName] ?? '').trim();
    const contractor = contactName
      ? {
          name: contactName,
          licenseNumber: '',
          phone: '',
        }
      : undefined;

    // Status — Nashville data doesn't have explicit status; derive from dates
    const status = issuedDate ? 'Issued' : 'Pending';

    return {
      permitNumber,
      permitType,
      trade: classifyTrade(permitType, workDescription, perTy),
      filedDate,
      issuedDate,
      status,
      workDescription,
      estimatedValue,
      address,
      contractor,
      applicant: undefined, // Not available in Nashville dataset
    };
  } catch (err) {
    console.error('[NashvilleScraper] transformFeature error:', err);
    return null;
  }
}

// =============================================================================
// MAIN SCRAPER
// =============================================================================

/**
 * Scrape building permits from Nashville's ArcGIS Open Data portal.
 *
 * @param daysBack - Number of days back from today to search (default: 1)
 * @returns Array of standardized RawPermit objects. Empty array on failure.
 *
 * @example
 * ```ts
 * import { scrapeNashvillePermits } from './scraper/nashville';
 * const permits = await scrapeNashvillePermits(7);
 * ```
 */
export async function scrapeNashvillePermits(daysBack: number = 1): Promise<RawPermit[]> {
  const allPermits: RawPermit[] = [];
  const baseUrl = process.env.NASHVILLE_ARCGIS_URL || DEFAULT_ARCGIS_URL;

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  const startEpoch = toArcGisEpoch(startDate);

  console.error(`[NashvilleScraper] Querying from ${startDate.toISOString()} (epoch: ${startEpoch})`);

  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      where: `${FIELD_MAP.filedDate} >= ${startEpoch}`,
      outFields: Object.values(FIELD_MAP).join(','),
      returnGeometry: 'false',
      f: 'json',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      orderByFields: `${FIELD_MAP.filedDate} DESC`,
    });

    const url = `${baseUrl}/query?${params.toString()}`;
    console.error(`[NashvilleScraper] Fetching offset=${offset}...`);

    try {
      const data = (await fetchWithBackoff(url)) as { features?: unknown[]; exceededTransferLimit?: boolean; error?: unknown };

      if (data.error) {
        console.error('[NashvilleScraper] ArcGIS error:', JSON.stringify(data.error));
        break;
      }

      const features = data.features ?? [];
      console.error(`[NashvilleScraper] Received ${features.length} features`);

      for (const feature of features) {
        const permit = transformFeature(feature);
        if (permit) allPermits.push(permit);
      }

      // ArcGIS signals more results via exceededTransferLimit or exact page size
      hasMore = features.length === PAGE_SIZE && (data.exceededTransferLimit === true || features.length === PAGE_SIZE);
      if (hasMore) offset += PAGE_SIZE;

      // Polite rate limiting: max 1 request per second
      if (hasMore) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error('[NashvilleScraper] Fetch error:', err);
      break;
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = allPermits.filter((p) => {
    if (seen.has(p.permitNumber)) return false;
    seen.add(p.permitNumber);
    return true;
  });

  console.error(`[NashvilleScraper] Returning ${unique.length} unique permits`);
  return unique;
}

// =============================================================================
// STANDALONE EXECUTION
// =============================================================================

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? '1', 10);
  const permits = await scrapeNashvillePermits(days);
  console.log(JSON.stringify(permits, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
