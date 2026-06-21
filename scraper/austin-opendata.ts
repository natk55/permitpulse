/**
 * Austin Open Data Permit Scraper
 * =====================================
 * Fetches permit records from the City of Austin Open Data portal using
 * Socrata's standard JSON resource API.
 *
 * Uses the "Issued Construction Permits" dataset and queries recent
 * permits by applied or issued date.
 *
 * How to run it:
 *   ts-node scraper/austin-opendata.ts [daysBack]
 *   node --loader ts-node/esm scraper/austin-opendata.ts [daysBack]
 *
 * Environment variables:
 *   AUSTIN_OPENDATA_DATASET — Override the default Socrata dataset ID
 *   DEBUG=1                — Enable verbose console logging
 */

const DEFAULT_HOST = 'data.austintexas.gov';
const DEFAULT_DATASET_ID = process.env.AUSTIN_OPENDATA_DATASET || '3syk-w9eu';
const PAGE_SIZE = 1000;

export interface RawPermit {
  permitNumber: string;
  permitType: string;
  trade: 'hvac' | 'electrical' | 'plumbing' | 'roofing' | 'drywall' | 'unknown';
  filedDate: string;
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

function classifyTrade(permitType: string = '', workDescription: string = ''): RawPermit['trade'] {
  const text = `${permitType} ${workDescription}`.toLowerCase();
  const keywords: Record<string, string[]> = {
    hvac: ['hvac', 'air condition', 'heating', 'cooling', 'ventilation', 'duct', 'furnace', 'ac unit', 'heat pump', 'refrigeration', 'mechanical'],
    electrical: ['electrical', 'electric', 'wiring', 'panel', 'circuit', 'breaker', 'conduit', 'lighting', 'outlet', 'service upgrade'],
    plumbing: ['plumbing', 'plumber', 'water heater', 'sewer', 'drain', 'pipe', 'fixture', 'toilet', 'faucet', 'gas line', 'sprinkler'],
    roofing: ['roof', 'roofing', 'shingle', 'tile roof', 'metal roof', 'flat roof', 'roof repair', 'roof replacement'],
    drywall: ['drywall', 'sheetrock', 'wallboard', 'gypsum', 'interior wall', 'partition', 'wall finish'],
  };

  for (const [trade, kws] of Object.entries(keywords)) {
    if (kws.some((kw) => text.includes(kw))) return trade as RawPermit['trade'];
  }

  return 'unknown';
}

function formatSocrataDate(date: Date): string {
  return new Date(date).toISOString().split('.')[0];
}

async function fetchWithBackoff(url: string, retries = 3): Promise<unknown> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt += 1) {
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
        console.error(`[AustinOpenDataScraper] Rate limited; backing off ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      return await res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error('Unknown fetch error');
}

function parseAddress(raw: unknown): RawPermit['address'] {
  if (typeof raw === 'object' && raw !== null) {
    const row = raw as Record<string, unknown>;
    const street = String(row['original_address1'] ?? row['address'] ?? row['address1'] ?? '');
    const city = String(row['original_city'] ?? row['city'] ?? 'Austin');
    const state = String(row['original_state'] ?? row['state'] ?? 'TX').toUpperCase();
    const zip = String(row['original_zip'] ?? row['zip'] ?? row['postal_code'] ?? '');
    return { street: street.trim(), city: city.trim(), state: state.trim(), zip: zip.trim() };
  }

  const cleaned = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/^(.+?)[,\s]+([A-Za-z\s]+)[,\s]+([A-Za-z]{2})[,\s]+(\d{5}(-\d{4})?)$/);
  if (match) {
    return { street: match[1].trim(), city: match[2].trim(), state: match[3].trim().toUpperCase(), zip: match[4].trim() };
  }

  const zipMatch = cleaned.match(/(\d{5}(-\d{4})?)$/);
  return {
    street: cleaned,
    city: 'Austin',
    state: 'TX',
    zip: zipMatch ? zipMatch[1] : '',
  };
}

function transformRow(row: unknown): RawPermit | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;

  const permitNumber = String(r['permit_number'] ?? r['permitNumber'] ?? '').trim();
  if (!permitNumber) return null;

  const permitType = String(r['permit_type_desc'] ?? r['permittype'] ?? 'Unknown');
  const workDescription = String(r['description'] ?? r['work_description'] ?? '');
  const filedDateRaw = String(r['applieddate'] ?? r['fileddate'] ?? '');
  const issuedDateRaw = String(r['issue_date'] ?? r['issueddate'] ?? '');
  const filedDate = filedDateRaw ? new Date(filedDateRaw).toISOString() : new Date().toISOString();
  const issuedDate = issuedDateRaw ? new Date(issuedDateRaw).toISOString() : undefined;
  const status = String(r['status_current'] ?? r['status'] ?? 'Unknown');

  let estimatedValue: number | undefined;
  const rawValue =
    r['total_job_valuation'] ??
    r['building_valuation'] ??
    r['electrical_valuation'] ??
    r['mechanical_valuation'] ??
    r['plumbing_valuation'] ??
    r['total_valuation_remodel'] ??
    r['valuation'] ??
    r['valuationamount'] ??
    r['estimated_value'] ??
    r['construction_cost'] ??
    r['cost'] ??
    r['value'];
  if (rawValue !== undefined && rawValue !== null) {
    const parsed = typeof rawValue === 'string' ? parseFloat(rawValue.replace(/[$,]/g, '')) : Number(rawValue);
    if (!Number.isNaN(parsed)) estimatedValue = parsed;
  }

  const address = parseAddress(r);

  const contractorName =
    String(r['contractor_full_name'] ?? r['contractor_company_name'] ?? r['contractor_name'] ?? r['contractor'] ?? '');
  const contractor = contractorName
    ? {
        name: contractorName,
        licenseNumber: String(r['contractor_license'] ?? ''),
        phone: String(r['contractor_phone'] ?? ''),
      }
    : undefined;
  const applicantName =
    String(r['applicant_full_name'] ?? r['applicant_org'] ?? r['applicant_name'] ?? r['applicant'] ?? '');
  const applicant = applicantName
    ? { name: applicantName, phone: String(r['applicant_phone'] ?? '') }
    : undefined;

  return {
    permitNumber,
    permitType,
    trade: classifyTrade(permitType, workDescription),
    filedDate,
    issuedDate,
    status,
    workDescription,
    estimatedValue,
    address,
    contractor,
    applicant,
  };
}

export async function scrapeAustinOpenDataPermits(daysBack: number = 1): Promise<RawPermit[]> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);
  startDate.setUTCHours(0, 0, 0, 0);
  const startIso = formatSocrataDate(startDate);

  console.error(`[AustinOpenDataScraper] Querying ${DEFAULT_HOST}/${DEFAULT_DATASET_ID} from ${startIso} (last ${daysBack} days)`);

  const permits: RawPermit[] = [];
  let offset = 0;

  while (true) {
    const where = `applieddate >= '${startIso}' OR issue_date >= '${startIso}'`;
    const params = new URLSearchParams({
      '$limit': String(PAGE_SIZE),
      '$offset': String(offset),
      '$order': 'applieddate DESC, issue_date DESC',
      '$where': where,
      '$select': [
        'permit_number',
        'permit_type_desc',
        'description',
        'applieddate',
        'issue_date',
        'status_current',
        'original_address1',
        'original_city',
        'original_state',
        'original_zip',
        'total_job_valuation',
        'building_valuation',
        'electrical_valuation',
        'mechanical_valuation',
        'plumbing_valuation',
        'total_valuation_remodel',
        'contractor_full_name',
        'contractor_company_name',
        'contractor_phone',
        'contractor_address1',
        'contractor_address2',
        'contractor_city',
        'contractor_zip',
        'applicant_full_name',
        'applicant_org',
        'applicant_phone',
        'applicant_address1',
        'applicant_address2',
        'applicant_city',
        'applicantzip',
      ].join(','),
    });

    const url = `https://${DEFAULT_HOST}/resource/${DEFAULT_DATASET_ID}.json?${params.toString()}`;
    console.error(`[AustinOpenDataScraper] Fetching offset=${offset} URL=${url}`);

    const data = await fetchWithBackoff(url);
    if (!Array.isArray(data)) {
      console.error('[AustinOpenDataScraper] Unexpected Socrata response shape');
      break;
    }

    console.error(`[AustinOpenDataScraper] Received ${data.length} rows`);
    if (data.length === 0) break;

    for (const row of data) {
      const permit = transformRow(row);
      if (permit) permits.push(permit);
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const seen = new Set<string>();
  const unique = permits.filter((permit) => {
    if (seen.has(permit.permitNumber)) return false;
    seen.add(permit.permitNumber);
    return true;
  });

  console.error(`[AustinOpenDataScraper] Returning ${unique.length} unique permits`);
  return unique;
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? '1', 10);
  const permits = await scrapeAustinOpenDataPermits(days);
  console.log(JSON.stringify(permits, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
