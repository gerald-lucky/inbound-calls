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
  if (all[0]) {
    console.log('[rm] Tenant sample keys:', Object.keys(all[0]).join(', '));
    const firstLease = all[0].Leases?.[0];
    if (firstLease) console.log('[rm] Lease sample keys:', Object.keys(firstLease).join(', '));
  }
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

async function lookupTenantByName(firstName, lastName, communityName) {
  const fn = (firstName || '').trim();
  const ln = (lastName  || '').trim();
  if (!fn && !ln) return null;

  // Resolve property IDs if community name is given — used to disambiguate duplicate names
  let communityPropIDs = [];
  if (communityName) {
    try {
      const propMap = await getPropertyMap();
      const q       = communityName.toLowerCase().replace(/[,.']/g, '');
      const STOP    = new Set(['community','communities','mobile','home','park','parks',
                               'property','properties','llc','inc','corp','ltd','mhc',
                               'the','and','of','at','in','management','realty']);
      const words   = q.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''))
                       .filter(w => w.length >= 4 && !STOP.has(w));
      communityPropIDs = [...propMap.entries()]
        .filter(([, pname]) => {
          const pn = pname.toLowerCase();
          if (pn.includes(q)) return true;
          return words.length > 0 && words.every(w => pn.includes(w));
        })
        .map(([id]) => String(id));
      if (!communityPropIDs.length && words.length) {
        communityPropIDs = [...propMap.entries()]
          .filter(([, pname]) => words.some(w => pname.toLowerCase().includes(w)))
          .map(([id]) => String(id));
      }
      console.log(`[rm] Name lookup: communityName="${communityName}" → propIDs [${communityPropIDs.join(', ')}]`);
    } catch { /* community filter optional — continue without it */ }
  }

  // Filter a candidate list to the right community, then name-match within it
  function pickFromList(items) {
    const scoped = communityPropIDs.length
      ? items.filter(t => communityPropIDs.includes(String(t.PropertyID)))
      : items;
    // Prefer community-scoped match; fall back to unscoped if nothing found
    return bestNameMatch(scoped, fn, ln) ?? (scoped.length ? null : bestNameMatch(items, fn, ln));
  }

  // Server-side search
  try {
    const params = { pagesize: 50 };
    if (ln) params.LastName  = ln;
    if (fn) params.FirstName = fn;
    const qs    = await buildTenantQS(params);
    const data  = await rmGet(`/tenants?${qs}`);
    const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
    if (items.length) {
      const tenant = pickFromList(items);
      if (tenant) {
        console.log(`[rm] Name match (server): ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
        return tenant;
      }
      console.log(`[rm] Server returned ${items.length} results but none matched "${fn} ${ln}" — falling through`);
    }
  } catch { /* fall through */ }

  // Last-name-only fallback (handles compound first names like "Jose Francisco")
  if (ln) {
    try {
      const qs    = await buildTenantQS({ LastName: ln, pagesize: 50 });
      const data  = await rmGet(`/tenants?${qs}`);
      const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
      if (items.length) {
        const tenant = pickFromList(items);
        if (tenant) {
          console.log(`[rm] Name match (server last-name-only): ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
          return tenant;
        }
      }
    } catch { /* fall through */ }
  }

  // Cache fallback
  try {
    const tenants = await getAllTenants();
    const tenant  = pickFromList(tenants);
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
  const queryNum    = queryDigits ? Number(queryDigits) : NaN;

  // Exact string match OR numeric match (handles leading zeros: "02" matches "2")
  function nameMatches(name) {
    const n = (name || '').toLowerCase().trim();
    if (!n) return false;
    if (n === query) return true;
    const d = n.replace(/\D/g, '');
    if (queryDigits && d && !isNaN(queryNum) && Number(d) === queryNum) return true;
    return false;
  }

  try {
    // Resolve property IDs from communityName to narrow results
    let propIDs = [];
    if (communityName) {
      const propMap = await getPropertyMap();
      const q       = communityName.toLowerCase().replace(/[,.']/g, '');
      // Strip generic words that appear in almost every property name
      const STOP = new Set(['community', 'communities', 'mobile', 'home', 'park', 'parks',
                            'property', 'properties', 'llc', 'inc', 'corp', 'ltd', 'mhc',
                            'the', 'and', 'of', 'at', 'in', 'management', 'realty']);
      const words = q.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''))
                     .filter(w => w.length >= 4 && !STOP.has(w));
      propIDs = [...propMap.entries()]
        .filter(([, pname]) => {
          const pn = pname.toLowerCase();
          // Prefer full-string include first
          if (pn.includes(q)) return true;
          // Fall back to meaningful-word match (all words must appear)
          return words.length > 0 && words.every(w => pn.includes(w));
        })
        .map(([id]) => String(id));
      // If word-AND produced 0, try word-OR as a last resort
      if (!propIDs.length && words.length) {
        propIDs = [...propMap.entries()]
          .filter(([, pname]) => words.some(w => pname.toLowerCase().includes(w)))
          .map(([id]) => String(id));
      }
      console.log(`[rm] Unit lookup: communityName="${communityName}" → propIDs [${propIDs.join(', ')}]`);
    }

    // Find candidate units in the unit cache
    const allUnits     = await getAllUnits();
    let candidateUnits = allUnits.filter(u =>
      nameMatches(u.Name || '') || nameMatches(u.UnitNumber || '') || nameMatches(u.LotNumber || '')
    );
    if (propIDs.length) {
      const filtered = candidateUnits.filter(u => propIDs.includes(String(u.PropertyID)));
      if (filtered.length) candidateUnits = filtered;
    }
    if (!candidateUnits.length) {
      console.log(`[rm] No unit found matching "${unitNumber}"${communityName ? ` in "${communityName}"` : ''}`);
      return null;
    }
    console.log(`[rm] Candidate units: ${candidateUnits.map(u => `${u.Name}(pid=${u.PropertyID})`).join(', ')}`);

    const candidatePropIDs = propIDs.length
      ? propIDs
      : [...new Set(candidateUnits.map(u => String(u.PropertyID)).filter(Boolean))];

    // Strategy 0: unit record may carry the current tenant ID directly
    for (const u of candidateUnits) {
      const tid = u.TenantID ?? u.CurrentTenantID ?? u.OccupantID ?? u.ResidentID;
      if (tid) {
        try {
          const qs   = await buildTenantQS({});
          const data = await rmGet(`/tenants/${tid}${qs ? '?' + qs : ''}`);
          if (data?.TenantID) {
            console.log(`[rm] Unit ${u.Name} → tenant from unit record TenantID: ${data.FirstName} ${data.LastName}`);
            data._unitName = u.Name;
            return data;
          }
        } catch { /* skip */ }
      }
    }

    // Strategy 1: server-side tenant filter by unit number param.
    // Only accept results verified by UnitID in lease data — RM may ignore the
    // filter param and return unfiltered results, so we never use scoped[0] blindly.
    for (const param of ['UnitNumber', 'UnitName', 'LotNumber']) {
      try {
        const qs    = await buildTenantQS({ [param]: unitNumber.trim(), pagesize: 20 });
        const data  = await rmGet(`/tenants?${qs}`);
        const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
        if (items.length) {
          const scoped = candidatePropIDs.length
            ? items.filter(t => candidatePropIDs.includes(String(t.PropertyID)))
            : items;
          // Require UnitID verification — proves the filter actually worked
          const verified = scoped.find(t =>
            (t.Leases || []).some(l => l.UnitID && candidateUnitIDs.has(Number(l.UnitID)))
          );
          if (verified) {
            console.log(`[rm] Unit match (server ${param}, verified): ${verified.FirstName} ${verified.LastName} (ID ${verified.TenantID})`);
            return verified;
          }
          console.log(`[rm] Server ${param} returned ${scoped.length} scoped results but none had verified UnitID — skipping`);
        }
      } catch { /* param not supported by this RM instance */ }
    }

    // Strategy 2: tenant cache — match by UnitID from candidate units (most reliable),
    // then fall back to UnitName/UnitNumber string matching
    const candidateUnitIDs = new Set(candidateUnits.map(u => Number(u.UnitID)).filter(Boolean));
    console.log(`[rm] Candidate UnitIDs: [${[...candidateUnitIDs].join(', ')}]`);

    const tenants    = await getAllTenants();
    const candidates = candidatePropIDs.length
      ? tenants.filter(t => candidatePropIDs.includes(String(t.PropertyID)))
      : tenants;

    const tenant = candidates.find(t =>
      (t.Leases || []).some(l => {
        if (l.UnitID && candidateUnitIDs.has(Number(l.UnitID))) return true;
        if (nameMatches(l.UnitName || '') || nameMatches(l.UnitNumber || '')) return true;
        return (l.UnitLeases || []).some(ul =>
          (ul.UnitID && candidateUnitIDs.has(Number(ul.UnitID))) ||
          nameMatches(ul.UnitName || '') || nameMatches(ul.UnitNumber || ''));
      })
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
  const base = `/tenants/${tenantId}/Transactions`;

  const fetchPage = async (qs) => {
    const data  = await rmGet(`${base}?${qs}`);
    const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
    return { items, data };
  };

  const newestFirst = (arr) =>
    arr
      .filter(t => t.TransactionDate)
      .sort((a, b) => new Date(b.TransactionDate) - new Date(a.TransactionDate));

  try {
    // ── Strategy 1: server-side sort (1 small request if RM honours it) ───────
    // Try several format variants — verify the result is actually descending.
    const sortVariants = [
      `pagesize=${limit + 10}&orderby=TransactionDate:desc`,
      `pagesize=${limit + 10}&$orderby=TransactionDate+desc`,
      `pagesize=${limit + 10}&sortby=TransactionDate&sortdirection=Desc`,
    ];
    for (const qs of sortVariants) {
      try {
        const { items } = await fetchPage(qs);
        if (items.length >= 2) {
          const d0 = new Date(items[0].TransactionDate);
          const dN = new Date(items[items.length - 1].TransactionDate);
          if (!isNaN(d0) && !isNaN(dN) && d0 >= dN) {
            console.log(`[rm] Transactions: server sort worked (${qs.split('&').slice(-1)[0]})`);
            return newestFirst(items).slice(0, limit);
          }
        }
      } catch { /* try next variant */ }
    }

    // ── Strategy 2: probe for total count, jump directly to last page ─────────
    const { items: probe, data: probeData } = await fetchPage('pagesize=1&pagenumber=1');
    if (probe[0]) console.log(`[rm] Transaction keys:`, Object.keys(probe[0]).join(', '));
    if (probeData && !Array.isArray(probeData))
      console.log(`[rm] Transaction response keys:`, Object.keys(probeData).join(', '));

    const total = probeData?.TotalCount ?? probeData?.totalCount ?? probeData?.TotalRecords
               ?? probeData?.RecordCount ?? probeData?.Total ?? probeData?.TotalItems ?? null;
    console.log(`[rm] Transactions: total hint = ${total} for tenant ${tenantId}`);

    if (total && Number(total) > 1) {
      const ps       = Math.max(limit * 4, 40);
      const lastPage = Math.ceil(Number(total) / ps);
      const pages    = [lastPage, lastPage > 1 ? lastPage - 1 : null].filter(Boolean);
      const chunks   = await Promise.all(
        pages.map(p => fetchPage(`pagesize=${ps}&pagenumber=${p}`).then(r => r.items).catch(() => []))
      );
      return newestFirst(chunks.flat()).slice(0, limit);
    }

    // ── Strategy 3: paginate forward with no cap — stop at the natural last page
    const pageSize = 200;
    let all = [], page = 1;
    while (true) {
      const { items } = await fetchPage(`pagesize=${pageSize}&pagenumber=${page}`);
      all = all.concat(items);
      if (items.length < pageSize) break; // RM returned a partial page → we're done
      page++;
    }
    console.log(`[rm] Transactions: ${all.length} fetched (${page} pages) for tenant ${tenantId}`);
    return newestFirst(all).slice(0, limit);

  } catch (err) {
    console.error('[rm] getPaymentHistory:', err.message);
    return [];
  }
}

async function getTenantBalance(tenantId) {
  // Fetch single tenant record with balance embeds to get accurate balance due
  for (const embed of ['CurrentBalance', 'Balance', 'AccountBalance', '']) {
    try {
      const qs   = embed ? `embeds=${embed}` : '';
      const data = await rmGet(`/tenants/${tenantId}${qs ? '?' + qs : ''}`);
      const bal  = data?.CurrentBalance ?? data?.Balance ?? data?.BalanceDue ?? data?.AmountDue ?? null;
      if (bal !== null) {
        console.log(`[rm] Balance via embed "${embed}": ${bal}`);
        return Number(bal);
      }
    } catch { /* try next */ }
  }
  return null;
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
    // Include UnitType embed so we get the type name (e.g. "Abandoned H", "Lot")
    const data  = await rmGet(`${endpoint}?pagesize=${pagesize}&pagenumber=${page}&embeds=UnitType`);
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
  // Reuse the tenant cache (already includes Leases embed) so we can extract
  // UnitIDs from active leases — far more accurate than counting by status.
  const tenants    = await getAllTenants();
  const now        = new Date();
  const byID       = new Set();
  const byName     = new Set();
  const countByProp = new Map();
  const statusSeen  = new Set();

  for (const t of tenants) {
    const status = (t.Status || '').toLowerCase();
    statusSeen.add(status || 'empty');

    if (ACTIVE_STATUSES.has(status)) {
      const pid = String(t.PropertyID);
      countByProp.set(pid, (countByProp.get(pid) || 0) + 1);

      // Extract UnitIDs from active leases — this gives us exact unit-level occupancy
      for (const l of (t.Leases || [])) {
        const leaseActive = !l.EndDate || new Date(l.EndDate) > now;
        if (leaseActive && l.UnitID) byID.add(Number(l.UnitID));
        // Also check nested UnitLeases
        for (const ul of (l.UnitLeases || [])) {
          if (ul.UnitID) byID.add(Number(ul.UnitID));
        }
      }
    }

    // Keep name-based fallback for units without IDs
    const n = (t.UnitNumber || t.LotNumber || '').trim();
    if (n) byName.add(n.toLowerCase());
  }

  console.log(`[rm] Occupancy map: ${byID.size} unit IDs from leases, ${byName.size} names, ${countByProp.size} props`);
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

  // Build UnitID → last-lease-end-date map from tenant cache for days-vacant calculation
  const tenants = await getAllTenants();
  const unitLastVacated = new Map(); // UnitID → Date
  for (const t of tenants) {
    for (const l of (t.Leases || [])) {
      if (!l.UnitID || !l.EndDate) continue;
      const end  = new Date(l.EndDate);
      const uid  = Number(l.UnitID);
      const prev = unitLastVacated.get(uid);
      if (!prev || end > prev) unitLastVacated.set(uid, end);
      for (const ul of (l.UnitLeases || [])) {
        if (!ul.UnitID) continue;
        const uid2 = Number(ul.UnitID);
        const prev2 = unitLastVacated.get(uid2);
        if (!prev2 || end > prev2) unitLastVacated.set(uid2, end);
      }
    }
  }

  // Helper: extract unit type name from several possible field shapes
  function unitTypeName(u) {
    return u.UnitType?.Name ?? u.UnitType?.UnitTypeName ?? u.UnitTypeName
        ?? u.UnitTypeDescription ?? u.Type ?? null;
  }

  // Helper: extract rent from unit record
  function unitRent(u) {
    const r = u.MarketRent ?? u.Rent ?? u.RentAmount ?? u.DefaultRent ?? u.BaseRent ?? null;
    return r !== null ? `$${Number(r).toFixed(0)}/mo` : null;
  }

  // Helper: days vacant from unit record or last-vacated map
  function daysVacant(u) {
    // Some RM unit records carry VacantOn / VacancyDate directly
    const raw = u.VacantOn ?? u.VacancyDate ?? u.VacantSince ?? u.LastVacancyDate ?? null;
    if (raw) {
      const d = Math.floor((Date.now() - new Date(raw)) / 86400000);
      return d >= 0 ? d : null;
    }
    // Fall back to last lease end date from tenant cache
    const uid  = Number(u.UnitID);
    const last = unitLastVacated.get(uid);
    if (last) {
      const d = Math.floor((Date.now() - last) / 86400000);
      return d >= 0 ? d : null;
    }
    return null;
  }

  let occupiedCount, vacantCount, vacantUnits, note;

  if (hasUnitLevelData) {
    const occupied  = units.filter(isOccupied);
    const vacant    = units.filter(u => !isOccupied(u));
    occupiedCount   = occupied.length;
    vacantCount     = vacant.length;
    vacantUnits     = vacant;
    note            = '';
  } else {
    const activeInMatched = matchedSet
      ? [...matchedSet].reduce((sum, pid) => sum + (countByProp.get(pid) || 0), 0)
      : [...countByProp.values()].reduce((a, b) => a + b, 0);
    occupiedCount = Math.min(activeInMatched, units.length);
    vacantCount   = units.length - occupiedCount;
    vacantUnits   = [];
    note          = '\n(Occupancy estimated from active tenant count — specific vacant unit numbers require a Rent Manager unit-assignment sync)';
  }

  const vacancyRate = units.length ? ((vacantCount / units.length) * 100).toFixed(1) : 0;

  let vacantDetail = '';
  if (vacantUnits.length) {
    const rows = vacantUnits.slice(0, 30).map(u => {
      const name    = u.Name || u.UnitNumber || String(u.UnitID);
      const type    = unitTypeName(u) ?? '—';
      const days    = daysVacant(u);
      const daysStr = days !== null ? `${days} days vacant` : 'vacant';
      const rent    = unitRent(u) ?? '—';
      const comment = (u.Comments || u.Comment || u.Notes || '').trim();
      const addr    = (u.Address || u.DefaultAddress || u.StreetAddress || '').trim();
      let line = `• ${name} | Type: ${type} | ${daysStr} | Rent: ${rent}`;
      if (addr)    line += ` | ${addr}`;
      if (comment) line += ` | Note: ${comment}`;
      return line;
    });
    vacantDetail = `\n\nVacant Units:\n${rows.join('\n')}`;
    if (vacantCount > 30) vacantDetail += `\n  ... and ${vacantCount - 30} more`;
  }

  return `${header}:
Total Units: ${units.length}
Occupied: ${occupiedCount}
Vacant: ${vacantCount}
Vacancy Rate: ${vacancyRate}%${note}${vacantDetail}`;
}



async function getCashPayCode(tenantId) {
  // 1. Official endpoint confirmed by RM support
  try {
    const data = await rmGet(`/Tenants/${tenantId}/CashPayUser`);
    console.log(`[rm] CashPayUser response:`, JSON.stringify(data));
    const code = data?.AccountNumber ?? data?.BarcodeNumber ?? data?.Code ?? data?.CashPayAccountNumber ?? null;
    if (code) {
      console.log(`[rm] CashPay: found via /CashPayUser for tenant ${tenantId}`);
      return { code: String(code), source: 'existing' };
    }
  } catch (err) {
    console.log(`[rm] CashPay GET /CashPayUser: ${err.message}`);
  }

  // 2. POST to generate a new code only if no existing code found
  console.log(`[rm] CashPay: generating new code via POST for tenant ${tenantId}`);
  try {
    const data = await rmPost(`/tenants/${tenantId}/cashpaybarcodes`, { LocationID: LOC_ID });
    const code  = data?.BarcodeNumber ?? data?.AccountNumber ?? data?.Code ?? null;
    return { code: code ? String(code) : null, source: 'generated', raw: data };
  } catch (err) {
    console.log(`[rm] CashPay POST also failed: ${err.message}`);
    return { code: null, source: 'none', raw: { error: err.message } };
  }
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

// Resolve unit name and community name for a tenant by cross-referencing
// lease.UnitID against the unit cache and tenant.PropertyID against propMap.
async function resolveTenantLocation(tenant) {
  try {
    const [allUnits, propMap] = await Promise.all([getAllUnits(), getPropertyMap()]);

    // Pick the active lease (no end date or end date in future); fall back to first
    const now         = new Date();
    const activeLease = (tenant.Leases || []).find(l =>
      !l.EndDate || new Date(l.EndDate) > now
    ) ?? tenant.Leases?.[0] ?? null;

    const unitId = activeLease?.UnitID
      ?? activeLease?.UnitLeases?.[0]?.UnitID
      ?? null;

    let unitName = tenant._unitName
      ?? activeLease?.UnitName
      ?? activeLease?.UnitNumber
      ?? null;

    if (!unitName && unitId) {
      const u = allUnits.find(u => Number(u.UnitID) === Number(unitId));
      if (u) unitName = u.Name || u.UnitNumber || String(unitId);
    }

    const propId      = String(tenant.PropertyID || '');
    const communityName = propMap.get(Number(propId)) ?? propMap.get(propId) ?? null;

    console.log(`[rm] Location resolved: unit="${unitName}" community="${communityName}" (UnitID=${unitId}, PropID=${propId})`);
    return { unitName: unitName ?? '—', communityName: communityName ?? '—' };
  } catch (err) {
    console.error('[rm] resolveTenantLocation:', err.message);
    return { unitName: '—', communityName: '—' };
  }
}


function buildAccountSummary(tenant, payments = [], location = null) {
  const displayId     = tenant.TenantDisplayID ?? tenant.TenantID;
  const unit          = location?.unitName      ?? '—';
  const communityName = location?.communityName ?? '—';

  // Balance: tenant record usually has no balance field — use running balance from most
  // recent transaction, fall back to any balance field on the tenant record
  const balanceFromTx = payments.length > 0
    ? (payments[0].Balance ?? payments[0].CurrentBalance ?? payments[0].RunningBalance ?? null)
    : null;
  const balance = balanceFromTx
    ?? tenant.Balance ?? tenant.CurrentBalance ?? tenant.BalanceDue ?? tenant.AmountDue ?? 0;

  const name   = `${tenant.FirstName} ${tenant.LastName}`;
  const twaUrl = `https://${COMPANY_CODE}.tenantwebaccess.com`;

  // Log what we got so we can debug missing fields
  if (balanceFromTx === null) console.log(`[rm] Balance fields on tenant:`, { Balance: tenant.Balance, CurrentBalance: tenant.CurrentBalance, BalanceDue: tenant.BalanceDue });
  if (payments[0]) console.log(`[rm] Transaction fields sample:`, Object.keys(payments[0]).join(', '));

  const historyLines = payments.length
    ? payments.map((t) =>
        `  - ${fmtDate(t.TransactionDate)}: ${t.Description || t.TransactionType || 'Transaction'} ${fmtAmount(t.Amount)}`
      ).join('\n')
    : '  No recent transactions on record.';

  return `RESIDENT ACCOUNT (Rent Manager):
Name: ${name}
Account#: ${displayId}
Community: ${communityName}
Unit: ${unit}
Balance Due: $${Number(balance).toFixed(2)}

RECENT TRANSACTIONS:
${historyLines}

TWA (Tenant Web Access):
  Account Number: ${displayId}
  URL: ${twaUrl}
  (Tenant uses their Account# to register/log in)

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

// ── Tenant documents ──────────────────────────────────────────────────────────

async function getTenantStatements(tenantId, limit = 5) {
  try {
    const data  = await rmGet(`/AccountStatements?filters=AccountID:eq:${tenantId}&pagesize=${limit}`);
    const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
    console.log(`[rm] AccountStatements for tenant ${tenantId}: ${items.length} records`);
    if (items[0]) console.log('[rm] Statement sample keys:', Object.keys(items[0]).join(', '));
    return items;
  } catch (err) {
    console.error('[rm] getTenantStatements:', err.message);
    return [];
  }
}

async function getTenantHistoryFiles(tenantId, limit = 10) {
  try {
    const data  = await rmGet(
      `/HistoryNotes?filters=ParentID:eq:${tenantId},EntityType:eq:Tenant&embeds=HistoryAttachments,Attachment&pagesize=${limit}`
    );
    const items = data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []);
    const withFiles = items.filter(h =>
      (h.HistoryAttachments?.length > 0) || h.Attachment || h.FileID
    );
    console.log(`[rm] History notes for tenant ${tenantId}: ${items.length} total, ${withFiles.length} with files`);
    if (withFiles[0]) console.log('[rm] HistoryNote sample keys:', Object.keys(withFiles[0]).join(', '));
    return withFiles;
  } catch (err) {
    console.error('[rm] getTenantHistoryFiles:', err.message);
    return [];
  }
}

async function downloadRmFile(url) {
  // Try with RM auth headers first (internal URLs), then bare (pre-signed S3 URLs)
  for (const useAuth of [true, false]) {
    try {
      const token   = useAuth ? await getToken() : null;
      const headers = token
        ? { 'X-RM12Api-ApiToken': token, 'X-RM12Api-LocationId': String(LOC_ID) }
        : {};
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer      = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      const disposition = res.headers.get('content-disposition') || '';
      const fnMatch     = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      const filename    = fnMatch ? fnMatch[1].replace(/['"]/g, '') : 'document.pdf';
      console.log(`[rm] Downloaded ${buffer.length} bytes (${contentType}) from ${url.slice(0, 60)}`);
      return { buffer, contentType, filename };
    } catch (err) {
      if (!useAuth) throw err;
      console.log(`[rm] downloadRmFile auth attempt failed (${err.message}), retrying without auth`);
    }
  }
}

// Returns ALL tenants whose first+last name exactly matches (case-insensitive).
// Scoped to communityName's property IDs when provided.
// Used by executeTool to detect duplicates and ask for disambiguation.
async function findAllNameMatches(firstName, lastName, communityName) {
  const fn = (firstName || '').trim().toLowerCase();
  const ln = (lastName  || '').trim().toLowerCase();
  if (!fn && !ln) return [];

  let propIDs = [];
  if (communityName) {
    const propMap = await getPropertyMap();
    const q     = communityName.toLowerCase().replace(/[,.']/g, '');
    const STOP  = new Set(['community','communities','mobile','home','park','parks',
                           'property','properties','llc','inc','corp','ltd','mhc',
                           'the','and','of','at','in','management','realty']);
    const words = q.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''))
                   .filter(w => w.length >= 4 && !STOP.has(w));
    propIDs = [...propMap.entries()]
      .filter(([, pn]) => pn.toLowerCase().includes(q) || (words.length && words.every(w => pn.toLowerCase().includes(w))))
      .map(([id]) => String(id));
  }

  function isMatch(t) {
    const tf = (t.FirstName || '').toLowerCase(), tl = (t.LastName || '').toLowerCase();
    // 1. Both fields exact
    if ((!fn || tf === fn) && (!ln || tl === ln)) return true;
    // 2. Full concatenated name matches (handles "Jose" / "Francisco Barahona" vs "Jose Francisco" / "Barahona")
    const full  = `${tf} ${tl}`.trim();
    const query = `${fn} ${ln}`.trim();
    if (query && full === query) return true;
    // 3. Partial includes — same logic as bestNameMatch fallback
    //    Handles Claude passing "jose" when RM stores "jose francisco"
    const fnOk = !fn || tf.includes(fn) || fn.includes(tf);
    const lnOk = !ln || tl.includes(ln) || ln.includes(tl);
    return fnOk && lnOk;
  }

  // Collect from server search + cache, deduplicate by TenantID
  const seen = new Map();
  const addAll = (items) => {
    for (const t of items) {
      if (isMatch(t) && !seen.has(t.TenantID)) seen.set(t.TenantID, t);
    }
  };

  try {
    const params = { pagesize: 50 };
    if (ln) params.LastName  = lastName.trim();
    if (fn) params.FirstName = firstName.trim();
    const data  = await rmGet(`/tenants?${await buildTenantQS(params)}`);
    addAll(data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []));
  } catch { /* ignore */ }

  if (ln && seen.size === 0) {
    try {
      const data  = await rmGet(`/tenants?${await buildTenantQS({ LastName: lastName.trim(), pagesize: 50 })}`);
      addAll(data?.Items ?? data?.items ?? (Array.isArray(data) ? data : []));
    } catch { /* ignore */ }
  }

  try {
    addAll(await getAllTenants());
  } catch { /* ignore */ }

  let all = [...seen.values()];
  if (propIDs.length) {
    const scoped = all.filter(t => propIDs.includes(String(t.PropertyID)));
    if (scoped.length) all = scoped;
  }
  return all;
}

module.exports = {
  lookupTenantByPhone,
  listProperties,
  lookupTenantByName,
  lookupTenantByUnit,
  findAllNameMatches,
  getPaymentHistory,
  getTenantBalance,
  getCashPayCode,
  getVacancyReport,
  buildAccountSummary,
  resolveTenantLocation,
  buildCallerContext,
  getTenantStatements,
  getTenantHistoryFiles,
  downloadRmFile,
};
