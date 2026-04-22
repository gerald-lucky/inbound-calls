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

// ── Tenant embed detection (cached) ──────────────────────────────────────────

let _tenantEmbed = undefined; // undefined = not yet probed; null = no embed works

async function detectTenantEmbed() {
  if (_tenantEmbed !== undefined) return _tenantEmbed;
  for (const e of ['PhoneNumbers,Leases', 'PhoneNumbers', 'Leases', '']) {
    try {
      const qs   = e ? `embeds=${e}&pagesize=1` : 'pagesize=1';
      const data = await rmGet(`/tenants?${qs}`);
      const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
      if (Array.isArray(items)) { _tenantEmbed = e || null; console.log(`[rm] Tenant embed: "${e || 'none'}"`); return _tenantEmbed; }
    } catch { /* try next */ }
  }
  _tenantEmbed = null;
  return null;
}

// Build a query string with the right embed + caller-supplied params
async function buildTenantQS(extra = {}) {
  const embed = await detectTenantEmbed();
  const params = embed ? { embeds: embed, ...extra } : { ...extra };
  return new URLSearchParams(params).toString();
}

// ── Tenant list cache (only used for occupancy map / phone fallback) ──────────

let _tenantCache     = null;
let _tenantCacheTime = 0;
const TENANT_CACHE_TTL = 5 * 60 * 1000;

async function getAllTenants() {
  if (_tenantCache && Date.now() - _tenantCacheTime < TENANT_CACHE_TTL) return _tenantCache;

  const pagesize = 500;
  let all  = [];
  let page = 1;

  while (true) {
    const qs    = await buildTenantQS({ pagesize, pagenumber: page });
    const data  = await rmGet(`/tenants?${qs}`);
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

// Pick the best matching tenant from an array (exact before partial)
function bestNameMatch(items, fn, ln) {
  const f = fn.toLowerCase(), l = ln.toLowerCase();
  return items.find(t => t.FirstName?.toLowerCase() === f && t.LastName?.toLowerCase() === l)
      ?? items.find(t => (!f || t.FirstName?.toLowerCase().includes(f)) && (!l || t.LastName?.toLowerCase().includes(l)))
      ?? null;
}

async function lookupTenantByPhone(phoneNumber) {
  const digits = (phoneNumber || '').replace(/\D/g, '');
  if (!digits) return null;

  // Server-side: try RM's phone number filter (may or may not be supported)
  try {
    const qs     = await buildTenantQS({ PhoneNumber: digits.slice(-10), pagesize: 10 });
    const data   = await rmGet(`/tenants?${qs}`);
    const items  = (data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []));
    const tenant = items.find(t =>
      (t.PhoneNumbers || []).some(p => (p.PhoneNumber || '').replace(/\D/g, '').includes(digits))
    ) ?? (items.length === 1 ? items[0] : null);
    if (tenant) { console.log(`[rm] Phone match (server): ${tenant.FirstName} ${tenant.LastName}`); return tenant; }
  } catch { /* filter not supported — fall through to cache */ }

  // Cache fallback: scan all tenants (needed when PhoneNumbers aren't filterable server-side)
  try {
    const tenants = await getAllTenants();
    const tenant  = tenants.find(t =>
      (t.PhoneNumbers || []).some(p => (p.PhoneNumber || '').replace(/\D/g, '').includes(digits))
    ) ?? null;
    if (tenant) console.log(`[rm] Phone match (cache): ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
    return tenant;
  } catch (err) {
    console.error('[rm] lookupTenantByPhone:', err.message);
    return null;
  }
}

async function lookupTenantByName(firstName, lastName) {
  const fn = (firstName || '').trim();
  const ln = (lastName  || '').trim();
  if (!fn && !ln) return null;

  // Server-side search: like typing into RM's search box
  try {
    const params = { pagesize: 20 };
    if (ln) params.LastName  = ln;
    if (fn) params.FirstName = fn;
    const qs     = await buildTenantQS(params);
    const data   = await rmGet(`/tenants?${qs}`);
    const items  = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
    if (items.length) {
      const tenant = bestNameMatch(items, fn, ln) ?? items[0];
      console.log(`[rm] Name match (server): ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
      return tenant;
    }
  } catch { /* filter not supported — fall through to cache */ }

  // Cache fallback for fuzzy / partial matches
  try {
    const tenants = await getAllTenants();
    const tenant  = bestNameMatch(tenants, fn, ln);
    if (tenant) console.log(`[rm] Name match (cache): ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
    return tenant;
  } catch (err) {
    console.error('[rm] lookupTenantByName:', err.message);
    return null;
  }
}

async function lookupTenantByUnit(unitNumber, communityName) {
  const query = (unitNumber || '').trim().toLowerCase();
  if (!query) return null;
  const queryDigits = query.replace(/\D/g, '');

  // Strict matching: exact string or exact digit sequence only.
  // Avoids "12".includes("2") = true matching unrelated units.
  function nameMatches(name) {
    const n = (name || '').toLowerCase().trim();
    if (!n) return false;
    if (n === query) return true;
    const d = n.replace(/\D/g, '');
    if (queryDigits && d && queryDigits === d) return true;
    return false;
  }

  try {
    // Resolve property IDs from communityName to narrow results
    let propIDs = [];
    if (communityName) {
      const propMap = await getPropertyMap();
      const q       = communityName.toLowerCase();
      const words   = q.split(/\s+/).filter(w => w.length > 2);
      propIDs = [...propMap.entries()]
        .filter(([, pname]) => pname.toLowerCase().includes(q) ||
                               words.some(w => pname.toLowerCase().includes(w)))
        .map(([id]) => String(id));
      console.log(`[rm] Unit lookup: communityName="${communityName}" → propIDs [${propIDs.join(', ')}]`);
    }

    // Build set of candidate unit names from the unit cache to confirm the unit exists
    const allUnits       = await getAllUnits();
    let candidateUnits   = allUnits.filter(u => nameMatches(u.Name || u.UnitNumber || ''));
    if (propIDs.length) {
      const filtered = candidateUnits.filter(u => propIDs.includes(String(u.PropertyID)));
      if (filtered.length) candidateUnits = filtered;
    }
    if (!candidateUnits.length) {
      console.log(`[rm] No unit found matching "${unitNumber}"${communityName ? ` in "${communityName}"` : ''}`);
      return null;
    }
    console.log(`[rm] Candidate units: ${candidateUnits.map(u => u.Name).join(', ')}`);

    // Derive property IDs from matched units if not already set
    const candidatePropIDs = propIDs.length
      ? propIDs
      : [...new Set(candidateUnits.map(u => String(u.PropertyID)).filter(Boolean))];

    // Strategy 1: server-side tenant filter by unit number param
    for (const param of ['UnitNumber', 'UnitName', 'LotNumber']) {
      try {
        const qs    = await buildTenantQS({ [param]: unitNumber.trim(), pagesize: 20 });
        const data  = await rmGet(`/tenants?${qs}`);
        const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
        if (items.length) {
          const scoped = candidatePropIDs.length
            ? items.filter(t => candidatePropIDs.includes(String(t.PropertyID)))
            : items;
          const active = scoped.find(t => ACTIVE_STATUSES.has((t.Status || '').toLowerCase()))
                      ?? scoped[0];
          if (active) {
            console.log(`[rm] Unit match (server ${param}): ${active.FirstName} ${active.LastName} (ID ${active.TenantID})`);
            return active;
          }
        }
      } catch { /* param not supported by this RM instance */ }
    }

    // Strategy 2: tenant cache lease data (only valid when Leases embed is available)
    const tenants    = await getAllTenants();
    const candidates = candidatePropIDs.length
      ? tenants.filter(t => candidatePropIDs.includes(String(t.PropertyID)))
      : tenants;

    const tenant = candidates.find(t =>
      (t.Leases || []).some(l =>
        nameMatches(l.UnitName || '') ||
        nameMatches(l.UnitNumber || '') ||
        (l.UnitLeases || []).some(ul =>
          nameMatches(ul.UnitName || '') || nameMatches(ul.UnitNumber || ''))
      )
    ) ?? null;
    if (tenant) console.log(`[rm] Unit match via lease: ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
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
let _unitEndpoint  = null;
let _unitCache     = null;
let _unitCacheTime = 0;
const UNIT_CACHE_TTL = 10 * 60 * 1000;

async function detectUnitEndpoint() {
  if (_unitEndpoint) return _unitEndpoint;
  for (const ep of ['/Units', '/Lots', '/units', '/lots']) {
    try {
      const probe = await rmGet(`${ep}?pagesize=1&pagenumber=1`);
      const items = probe?.Items ?? probe?.items ?? probe?.Value ?? probe?.value ?? (Array.isArray(probe) ? probe : null);
      if (Array.isArray(items)) {
        console.log(`[rm] Unit endpoint detected: ${ep}`);
        _unitEndpoint = ep;
        return ep;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function getAllUnits() {
  if (_unitCache && Date.now() - _unitCacheTime < UNIT_CACHE_TTL) return _unitCache;

  const endpoint = await detectUnitEndpoint();
  if (!endpoint) return [];

  const pagesize = 500;
  let all  = [];
  let page = 1;
  while (true) {
    const data  = await rmGet(`${endpoint}?pagesize=${pagesize}&pagenumber=${page}`);
    const items = data?.Items ?? data?.items ?? data?.Value ?? data?.value ?? (Array.isArray(data) ? data : []);
    console.log(`[rm] Units page ${page}: ${items.length} items`);
    all = all.concat(items);
    if (items.length < pagesize) break;
    if (++page > 20) break;
  }

  if (all[0]) console.log('[rm] Unit record sample keys:', Object.keys(all[0]).join(', '));
  console.log(`[rm] Units cache loaded — ${all.length} units`);
  _unitCache     = all;
  _unitCacheTime = Date.now();
  return all;
}

// Tenant status values that mean "actively occupying a unit"
const ACTIVE_STATUSES = new Set(['current', 'eviction', 'notice', 'active']);

async function buildOccupancyMap() {
  const pagesize   = 500;
  const byID       = new Set();
  const byName     = new Set();
  const countByProp = new Map(); // PropertyID string → count of active tenants
  const statusSeen  = new Set();
  let page         = 1;

  while (true) {
    const data  = await rmGet(`/tenants?pagesize=${pagesize}&pagenumber=${page}`);
    const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
    console.log(`[rm] Occupancy page ${page}: ${items.length} items`);
    if (page === 1 && items[0]) console.log('[rm] Basic tenant keys:', Object.keys(items[0]).join(', '));

    for (const t of items) {
      // Unit-ID-based occupancy (if RM ever exposes these directly)
      if (t.UnitID)        byID.add(Number(t.UnitID));
      if (t.CurrentUnitID) byID.add(Number(t.CurrentUnitID));
      if (t.LotID)         byID.add(Number(t.LotID));
      const n = (t.UnitNumber || t.LotNumber || '').trim();
      if (n) byName.add(n.toLowerCase());

      // Count-based fallback: active tenants per property
      const status = (t.Status || '').toLowerCase();
      statusSeen.add(status || 'empty');
      if (ACTIVE_STATUSES.has(status)) {
        const pid = String(t.PropertyID);
        countByProp.set(pid, (countByProp.get(pid) || 0) + 1);
      }
    }

    if (items.length < pagesize) break;
    if (++page > 20) break;
  }

  console.log(`[rm] Occupancy map: ${byID.size} IDs, ${byName.size} names, ${countByProp.size} props with active tenants`);
  console.log(`[rm] Tenant statuses seen: ${[...statusSeen].join(', ')}`);
  return { byID, byName, countByProp };
}

async function getVacancyReport(communityName) {
  // Run all three fetches in parallel — units and properties are cached after first call
  const [allUnits, occupancy, propMap] = await Promise.all([
    getAllUnits(),
    buildOccupancyMap(),
    getPropertyMap(),
  ]);

  if (!allUnits.length) return 'No unit data available from Rent Manager.';

  const { byID, byName, countByProp } = occupancy;
  const hasUnitLevelData = byID.size > 0 || byName.size > 0;

  // Match a unit as occupied by ID first, then by name
  const isOccupied = u => {
    if (byID.has(Number(u.UnitID))) return true;
    const name = (u.Name || u.UnitNumber || '').trim().toLowerCase();
    return !!name && byName.has(name);
  };

  // Filter by community/property name if requested
  let units        = allUnits;
  let matchedSet   = null;
  if (communityName) {
    const words = communityName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const q     = communityName.toLowerCase();

    let matchedPropIDs = [...propMap.entries()]
      .filter(([, name]) => name.toLowerCase().includes(q))
      .map(([id]) => id);

    if (!matchedPropIDs.length && words.length) {
      matchedPropIDs = [...propMap.entries()]
        .filter(([, name]) => words.some(w => name.toLowerCase().includes(w)))
        .map(([id]) => id);
    }

    if (!matchedPropIDs.length) {
      const allNames = [...propMap.values()].filter(Boolean).sort().map(n => `• ${n}`).join('\n');
      return `No property matching "${communityName}" found.\n\nAvailable communities:\n${allNames || 'none found'}`;
    }

    matchedSet = new Set(matchedPropIDs.map(String));

    if (matchedPropIDs.length > 1) {
      const matched = matchedPropIDs.map(id => propMap.get(id)).filter(Boolean);
      units = allUnits.filter(u => matchedSet.has(String(u.PropertyID)));
      if (!units.length) {
        return `Found multiple communities matching "${communityName}": ${matched.join(', ')}. Please specify which one.`;
      }
    } else {
      units = allUnits.filter(u => matchedSet.has(String(u.PropertyID)));
    }
    console.log(`[rm] Filtered to ${units.length} units for "${communityName}" (propIDs: ${[...matchedSet].join(', ')})`);
  }

  const header = communityName
    ? `VACANCY REPORT — ${communityName}`
    : 'VACANCY REPORT (All Communities)';

  let occupiedCount, vacantCount, vacantList, note;

  if (hasUnitLevelData) {
    // Unit-level match: we know exactly which units are occupied
    const occupied = units.filter(isOccupied);
    const vacant   = units.filter(u => !isOccupied(u));
    occupiedCount  = occupied.length;
    vacantCount    = vacant.length;
    vacantList     = vacant.slice(0, 30).map(u => u.Name || u.UnitID).join(', ');
    note           = '';
  } else {
    // Count-based fallback: use active tenant count per property
    const activeInMatched = matchedSet
      ? [...matchedSet].reduce((sum, pid) => sum + (countByProp.get(pid) || 0), 0)
      : [...countByProp.values()].reduce((a, b) => a + b, 0);

    occupiedCount = Math.min(activeInMatched, units.length);
    vacantCount   = units.length - occupiedCount;
    vacantList    = '';
    note          = '\n(Occupancy estimated from active tenant count — specific vacant unit numbers require a Rent Manager unit-assignment sync)';
  }

  const vacancyRate = units.length ? ((vacantCount / units.length) * 100).toFixed(1) : 0;

  return `${header}:
Total Units: ${units.length}
Occupied: ${occupiedCount}
Vacant: ${vacantCount}
Vacancy Rate: ${vacancyRate}%${note}${vacantList ? `\n\nVacant Units: ${vacantList}${vacantCount > 30 ? ` ... and ${vacantCount - 30} more` : ''}` : ''}`;
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
  // Unit number: from embedded Units (if embed works), injected _unitName, or lease
  const unit = tenant._unitName
    ?? tenant.Units?.[0]?.UnitNumber
    ?? tenant.Leases?.[0]?.UnitLeases?.[0]?.UnitName
    ?? tenant.Leases?.[0]?.UnitName
    ?? '—';
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
