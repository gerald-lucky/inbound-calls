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
  _token        = json.Token;           // RM returns Token (capital T)
  _tokenExpires = Date.now() + 3600_000; // tokens last ~1 hour; refresh 1 min early
  console.log('[rm] Token refreshed');
  return _token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function rmGet(path, retry = true) {
  const token = await getToken();
  const res   = await fetch(`${BASE}${path}`, {
    headers: { 'X-RM12Api-ApiToken': token, Accept: 'application/json' },
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

// ── Tenant lookup ─────────────────────────────────────────────────────────────

const TENANT_EMBEDS = 'embeds[]=PhoneNumbers&embeds[]=Units';

async function lookupTenantByPhone(phoneNumber) {
  const digits = (phoneNumber || '').replace(/\D/g, '');
  try {
    const data = await rmGet(
      `/tenants?${TENANT_EMBEDS}&filterExpression=PhoneNumbers.PhoneNumber,ct,${digits}&pagesize=1`
    );
    const tenant = data?.items?.[0] ?? null;
    if (tenant) console.log(`[rm] Phone match: ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
    return tenant;
  } catch (err) {
    console.error('[rm] lookupTenantByPhone:', err.message);
    return null;
  }
}

async function lookupTenantByName(firstName, lastName) {
  const fn = (firstName || '').trim();
  const ln = (lastName  || '').trim();

  // Use filterExpression with proper RM syntax — filters at API level, no pagination needed
  const attempts = [];
  if (fn && ln) attempts.push(`filterExpression=LastName,eq,${encodeURIComponent(ln)};FirstName,eq,${encodeURIComponent(fn)}`);
  if (fn && ln) attempts.push(`filterExpression=LastName,ct,${encodeURIComponent(ln)};FirstName,ct,${encodeURIComponent(fn)}`);
  if (ln)       attempts.push(`filterExpression=LastName,eq,${encodeURIComponent(ln)}`);
  if (fn)       attempts.push(`filterExpression=FirstName,eq,${encodeURIComponent(fn)}`);
  if (ln)       attempts.push(`filterExpression=LastName,ct,${encodeURIComponent(ln)}`);

  for (const filter of attempts) {
    try {
      const data   = await rmGet(`/tenants?${TENANT_EMBEDS}&${filter}&pagesize=5`);
      const tenant = data?.items?.[0];
      if (tenant) {
        console.log(`[rm] Name match: ${tenant.FirstName} ${tenant.LastName} (ID ${tenant.TenantID})`);
        return tenant;
      }
    } catch (err) {
      console.error('[rm] lookupTenantByName attempt:', err.message);
    }
  }
  return null;
}

async function lookupTenantByUnit(unitNumber) {
  try {
    const data = await rmGet(
      `/tenants?${TENANT_EMBEDS}&filterExpression=Units.UnitNumber,eq,${encodeURIComponent(unitNumber.trim())}&pagesize=1`
    );
    const tenant = data?.items?.[0] ?? null;
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
    const data = await rmGet(
      `/transactions?` +
      `filters[]=TenantID,eq,${tenantId}&` +
      `orderby=TransactionDate desc&pagesize=${limit}`
    );
    return data?.items ?? [];
  } catch (err) {
    console.error('[rm] getPaymentHistory:', err.message);
    return [];
  }
}

// ── CashPay / Zego ────────────────────────────────────────────────────────────

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
  lookupTenantByName,
  lookupTenantByUnit,
  getPaymentHistory,
  generateCashPayCode,
  buildAccountSummary,
  buildCallerContext,
};
