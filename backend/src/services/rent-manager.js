'use strict';

// Rent Manager Cloud (v3) API client
// Docs: https://{company}.api.rentmanager.com/swagger

const BASE         = (process.env.RM_API_BASE_URL  || '').replace(/\/$/, '');
const RM_USER      = process.env.RM_USERNAME        || '';
const RM_PASS      = process.env.RM_PASSWORD        || '';
const LOC_ID       = Number(process.env.RM_LOCATION_ID) || 1;
const COMPANY_CODE = process.env.RM_COMPANY_CODE    || '';

// ── Auth token cache ──────────────────────────────────────────────────────────

let _token        = null;
let _tokenExpires = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpires - 60_000) return _token;

  const res = await fetch(`${BASE}/Authentication/AuthorizeUser`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ Username: RM_USER, Password: RM_PASS, LocationID: LOC_ID }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`RM auth failed ${res.status}: ${txt}`);
  }

  const json    = await res.json();
  // RM returns the token as a plain JSON string, not an object
  _token        = typeof json === 'string' ? json : (json.Token ?? json.token ?? json.access_token ?? '');
  _tokenExpires = Date.now() + 3600_000; // tokens last ~1 hour; refresh 1 min early
  console.log(`[rm] Token refreshed (LOC=${LOC_ID}, token prefix=${_token.slice(0,16)}`);
  return _token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function rmGet(path, retry = true) {
  const token = await getToken();
  const url   = `${BASE}${path}`;
  console.log(`[rm] GET ${url}`);
  const res   = await fetch(url, {
    headers: {
      'X-RM12Api-ApiToken':    token,
      'X-RM12Api-LocationId':  String(LOC_ID),
      Accept: 'application/json',
    },
  });
  if (res.status === 401 && retry) {
    _token = null; // force re-auth
    return rmGet(path, false);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`RM GET ${path} → ${res.status}: ${txt}`);
  }
  return res.json();
}

async function rmPost(path, body = {}, retry = true) {
  const token = await getToken();
  const res   = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'X-RM12Api-ApiToken': token, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (res.status === 401 && retry) {
    _token = null;
    return rmPost(path, body, false);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`RM POST ${path} → ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Tenant list cache (5 min TTL) ─────────────────────────────────────────────

let _tenantCache     = null;
let _tenantCacheTime = 0;
const TENANT_CACHE_TTL = 5 * 60 * 1000;

async function getAllTenants() {
  if (_tenantCache && Date.now() - _tenantCacheTime < TENANT_CACHE_TTL) return _tenantCache;

  const pagesize = 500;
  let all = [];
  let page = 1;

  while (true) {
    const data  = await rmGet(`/tenants?embeds=Units&pagesize=${pagesize}&pagenumber=${page}`);
    const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
    all = all.concat(items);
    console.log(`[rm] Tenants page ${page}: ${items.length} items`);
    if (items.length < pagesize) break;
    page++;
    if (page > 20) break; // safety cap
  }

  _tenantCache     = all;
  _tenantCacheTime = Date.now();
  if (all[0]) console.log('[rm] Tenant sample keys:', Object.keys(all[0]).join(', '));
  console.log(`[rm] Tenant cache loaded — ${_tenantCache.length} tenants`);
  return _tenantCache;
}

// ── Tenant lookup ─────────────────────────────────────────────────────────────

async function lookupTenantByPhone(phoneNumber) {
  const digits = (phoneNumber || '').replace(/\D/g, '');
  if (!digits) return null;
  try {
    const tenants = await getAllTenants();
    const tenant  = tenants.find(t =>
      (t.PhoneNumbers || []).some(p => (p.PhoneNumber || '').replace(/\D/g, '').includes(digits))
    ) ?? null;
    if (tenant) console.log(`[rm] Phone match: ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
    return tenant;
  } catch (err) {
    console.error('[rm] lookupTenantByPhone:', err.message);
    return null;
  }
}

async function lookupTenantByName(firstName, lastName) {
  const fn = (firstName || '').trim().toLowerCase();
  const ln = (lastName  || '').trim().toLowerCase();
  if (!fn && !ln) return null;
  try {
    const tenants = await getAllTenants();

    // Exact match first, then partial
    const match = (t, exact) => {
      const tfn = (t.FirstName || '').toLowerCase();
      const tln = (t.LastName  || '').toLowerCase();
      if (fn && ln) return exact ? (tfn === fn && tln === ln) : (tfn.includes(fn) && tln.includes(ln));
      if (ln)       return exact ? tln === ln : tln.includes(ln);
      return          exact ? tfn === fn : tfn.includes(fn);
    };

    const tenant = tenants.find(t => match(t, true)) ?? tenants.find(t => match(t, false)) ?? null;
    if (tenant) console.log(`[rm] Name match: ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
    return tenant;
  } catch (err) {
    console.error('[rm] lookupTenantByName:', err.message);
    return null;
  }
}

async function lookupTenantByUnit(unitNumber) {
  const unit = (unitNumber || '').trim().toLowerCase();
  if (!unit) return null;
  // Extract just digits for fuzzy matching (e.g. "Lot #4" → "4", matches "P-4", "004", "Lot-4")
  const unitDigits = unit.replace(/\D/g, '');

  function unitMatches(u) {
    const n = (u.UnitNumber || '').toLowerCase().trim();
    const d = n.replace(/\D/g, '');
    return n === unit || n.includes(unit) || unit.includes(n) ||
           (unitDigits && d && unitDigits === d);
  }

  try {
    const tenants = await getAllTenants();
    const tenant  = tenants.find(t => (t.Units || []).some(unitMatches)) ?? null;
    if (tenant) console.log(`[rm] Unit match: ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
    return tenant;
  } catch (err) {
    console.error('[rm] lookupTenantByUnit:', err.message);
    return null;
  }
}

// ── Payment history ───────────────────────────────────────────────────────────

async function getPaymentHistory(tenantId, limit = 8) {
  try {
    const data = await rmGet(`/tenants/${tenantId}/Transactions?pagesize=${limit}`);
    return data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('[rm] getPaymentHistory:', err.message);
    return [];
  }
}

// ── Properties cache ──────────────────────────────────────────────────────────

let _propCache     = null;
let _propCacheTime = 0;

async function getPropertyMap() {
  if (_propCache && Date.now() - _propCacheTime < TENANT_CACHE_TTL) return _propCache;
  try {
    const data  = await rmGet('/Properties?pagesize=200');
    const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
    _propCache     = new Map(items.map(p => [p.PropertyID, p.Name || p.PropertyName || '']));
    _propCacheTime = Date.now();
    console.log(`[rm] Properties loaded — ${_propCache.size} properties`);
  } catch (err) {
    console.error('[rm] getPropertyMap:', err.message);
    _propCache = new Map();
  }
  return _propCache;
}

// ── Vacancy report ────────────────────────────────────────────────────────────

// Cache which unit endpoint works for this RM account
let _unitEndpoint = null;

async function detectUnitEndpoint() {
  if (_unitEndpoint) return _unitEndpoint;
  for (const ep of ['/Units', '/Lots', '/units', '/lots']) {
    try {
      const probe = await rmGet(`${ep}?pagesize=1&pagenumber=1`);
      const items = probe?.Items ?? probe?.items ?? (Array.isArray(probe) ? probe : null);
      if (Array.isArray(items)) {
        console.log(`[rm] Unit endpoint detected: ${ep}`);
        _unitEndpoint = ep;
        return ep;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function getVacancyReport(communityName) {
  const endpoint = await detectUnitEndpoint();
  if (!endpoint) return 'Could not find a unit/lot endpoint in Rent Manager (tried /Units and /Lots).';

  const pagesize = 500;
  let allUnits   = [];
  let page       = 1;
  while (true) {
    const data  = await rmGet(`${endpoint}?pagesize=${pagesize}&pagenumber=${page}`);
    const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
    allUnits    = allUnits.concat(items);
    if (items.length < pagesize) break;
    if (++page > 20) break;
  }
  if (!allUnits.length) return 'No unit data available from Rent Manager.';

  const [tenants, propMap] = await Promise.all([getAllTenants(), getPropertyMap()]);

  // Build occupied set from tenants — check every likely field name
  if (tenants[0]) console.log('[rm] Tenant keys for occ check:', Object.keys(tenants[0]).join(', '));
  const sampleUnit = tenants.find(t => t.Units?.length > 0)?.Units?.[0];
  if (sampleUnit) console.log('[rm] Embedded unit sample keys:', Object.keys(sampleUnit).join(', '));

  const occupiedUnitIDs     = new Set();
  const occupiedUnitNumbers = new Set();

  for (const t of tenants) {
    if (t.UnitID)        occupiedUnitIDs.add(Number(t.UnitID));
    if (t.CurrentUnitID) occupiedUnitIDs.add(Number(t.CurrentUnitID));
    if (t.LotID)         occupiedUnitIDs.add(Number(t.LotID));
    for (const u of (t.Units || t.CurrentUnits || [])) {
      if (u.UnitID) occupiedUnitIDs.add(Number(u.UnitID));
      if (u.ID)     occupiedUnitIDs.add(Number(u.ID));
      const n = (u.UnitNumber || '').trim();
      if (n) occupiedUnitNumbers.add(n.toLowerCase());
    }
  }
  console.log(`[rm] Occupied: ${occupiedUnitIDs.size} IDs, ${occupiedUnitNumbers.size} unit numbers`);
  if (allUnits[0]) console.log('[rm] /Units record sample keys:', Object.keys(allUnits[0]).join(', '));

  // Match by ID first; fall back to unit number (works even when embedded unit IDs are absent)
  const isOccupied = u => {
    if (occupiedUnitIDs.has(Number(u.UnitID))) return true;
    const name = (u.Name || u.UnitNumber || '').trim().toLowerCase();
    return !!name && occupiedUnitNumbers.has(name);
  };

  // Filter by community/property name if requested
  let units = allUnits;
  if (communityName) {
    const words = communityName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const q     = communityName.toLowerCase();

    // 1. Try substring match first
    let matchedPropIDs = [...propMap.entries()]
      .filter(([, name]) => name.toLowerCase().includes(q))
      .map(([id]) => id);

    // 2. Fall back to any-word match
    if (!matchedPropIDs.length && words.length) {
      matchedPropIDs = [...propMap.entries()]
        .filter(([, name]) => words.some(w => name.toLowerCase().includes(w)))
        .map(([id]) => id);
    }

    if (!matchedPropIDs.length) {
      const allNames = [...propMap.values()].filter(Boolean).sort().map(n => `• ${n}`).join('\n');
      return `No property matching "${communityName}" found.\n\nAvailable communities:\n${allNames || 'none found'}`;
    }

    // If multiple fuzzy matches, list them so Claude can ask for clarification
    if (matchedPropIDs.length > 1) {
      const matched = matchedPropIDs.map(id => propMap.get(id)).filter(Boolean);
      // Still run report with all matched properties combined
      units = allUnits.filter(u => matchedPropIDs.includes(u.PropertyID));
      if (!units.length) {
        return `Found multiple communities matching "${communityName}": ${matched.join(', ')}. Please specify which one.`;
      }
    } else {
      units = allUnits.filter(u => u.PropertyID === matchedPropIDs[0]);
    }
  }

  const occupied = units.filter(isOccupied);
  const vacant   = units.filter(u => !isOccupied(u));

  const vacantList = vacant.slice(0, 30).map(u => u.Name || u.UnitID).join(', ');
  const header     = communityName
    ? `VACANCY REPORT — ${communityName}`
    : 'VACANCY REPORT (All Communities)';

  return `${header}:
Total Units: ${units.length}
Occupied: ${occupied.length}
Vacant: ${vacant.length}
Vacancy Rate: ${units.length ? ((vacant.length / units.length) * 100).toFixed(1) : 0}%
${vacant.length ? `\nVacant Units: ${vacantList}${vacant.length > 30 ? ` ... and ${vacant.length - 30} more` : ''}` : '\nAll units are occupied.'}`;
}



async function generateCashPayCode(tenantId) {
  // Zego CashPay barcode via Rent Manager API
  // Endpoint: POST /tenants/{id}/cashpaybarcodes  — verify in RM Swagger if this 404s
  const data = await rmPost(`/tenants/${tenantId}/cashpaybarcodes`, { LocationID: LOC_ID });
  return data;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtDate(dateStr) {
  if (!dateStr) return 'unknown';
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function fmtAmount(val) {
  return `$${Math.abs(Number(val || 0)).toFixed(2)}`;
}

async function listProperties() {
  const propMap = await getPropertyMap();
  return [...propMap.values()].filter(Boolean).sort();
}

// ── Context builders ──────────────────────────────────────────────────────────

function buildAccountSummary(tenant, payments = []) {
  const unit    = tenant.Units?.[0]?.UnitNumber ?? '—';
  const balance = tenant.Balance ?? tenant.CurrentBalance ?? tenant.BalanceDue ?? 0;
  const name    = `${tenant.FirstName} ${tenant.LastName}`;
  const twaUrl  = `https://${COMPANY_CODE}.tenantwebaccess.com`;

  const historyLines = payments.length
    ? payments.map((t) =>
        `  - ${fmtDate(t.TransactionDate)}: ${t.Description || t.TransactionType || 'Transaction'} ${fmtAmount(t.Amount)}`
      ).join('\n')
    : '  No recent transactions on record.';

  return `RESIDENT ACCOUNT (Rent Manager):
Name: ${name}
Tenant ID: ${tenant.TenantID}
Unit: ${unit}
Balance Due: $${Number(balance).toFixed(2)}

RECENT TRANSACTIONS:
${historyLines}

TWA (Tenant Web Access):
  Account Number: ${tenant.TenantID}
  URL: ${twaUrl}
  (Tenant uses their Tenant ID as account number to register/log in)

Address the caller by their first name (${tenant.FirstName}).`;
}

async function buildCallerContext(phoneNumber) {
  const tenant = await lookupTenantByPhone(phoneNumber);

  if (!tenant) {
    return `CALLER STATUS: Phone number ${phoneNumber} not matched to any Rent Manager tenant.
If the caller provides their name or unit number, use the lookup_resident tool to find their account.
Do not make up any account figures until you find their record.`;
  }

  const payments = await getPaymentHistory(tenant.TenantID, 6);
  return buildAccountSummary(tenant, payments);
}

module.exports = {
  lookupTenantByPhone,
  listProperties,
  lookupTenantByName,
  lookupTenantByUnit,
  getPaymentHistory,
  generateCashPayCode,
  getVacancyReport,
  buildAccountSummary,
  buildCallerContext,
};
