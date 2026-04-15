'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Normalize a phone number to E.164 digits only for comparison.
 * e.g. "+1 (555) 123-4567" → "+15551234567"
 */
function normalizePhone(phone) {
  if (!phone) return '';
  const hasPlus = phone.trim().startsWith('+');
  const digits = phone.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Look up a tenant by phone number.
 * Tries the number as-is, then normalized.
 * @param {string} phoneNumber
 * @returns {Promise<object|null>}
 */
async function lookupTenant(phoneNumber) {
  const normalized = normalizePhone(phoneNumber);

  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .or(`phone_number.eq.${phoneNumber},phone_number.eq.${normalized}`)
    .maybeSingle();

  if (error) {
    console.error('[park-data] Tenant lookup error:', error.message);
    return null;
  }
  return data;
}

/**
 * Look up a tenant by name using multiple fallback strategies.
 * Tries increasingly broad searches so accent/transcription variations still match.
 *   1. Both first AND last name match
 *   2. First name only
 *   3. Last name only
 * @param {string} firstName
 * @param {string} lastName
 * @returns {Promise<object|null>}
 */
async function lookupTenantByName(firstName, lastName) {
  const fn = (firstName || '').trim();
  const ln = (lastName  || '').trim();

  // Strategy 1: both names provided and both match
  if (fn && ln) {
    const { data, error } = await supabase
      .from('tenants').select('*')
      .ilike('first_name', `%${fn}%`)
      .ilike('last_name',  `%${ln}%`)
      .limit(1).maybeSingle();
    if (error) console.error('[park-data] Name lookup (both) error:', error.message);
    if (data) return data;
  }

  // Strategy 2: first name only
  if (fn) {
    const { data, error } = await supabase
      .from('tenants').select('*')
      .ilike('first_name', `%${fn}%`)
      .limit(1).maybeSingle();
    if (error) console.error('[park-data] Name lookup (first) error:', error.message);
    if (data) return data;
  }

  // Strategy 3: last name only
  if (ln) {
    const { data, error } = await supabase
      .from('tenants').select('*')
      .ilike('last_name', `%${ln}%`)
      .limit(1).maybeSingle();
    if (error) console.error('[park-data] Name lookup (last) error:', error.message);
    if (data) return data;
  }

  return null;
}

/**
 * Look up a tenant by lot number (exact, case-insensitive).
 * @param {string} lotNumber
 * @returns {Promise<object|null>}
 */
async function lookupTenantByLot(lotNumber) {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .ilike('lot_number', lotNumber.trim())
    .maybeSingle();

  if (error) {
    console.error('[park-data] Lot lookup error:', error.message);
    return null;
  }
  return data;
}

/**
 * Get a tenant's payment history, newest first.
 * @param {string} tenantId
 * @param {number} months
 * @returns {Promise<Array>}
 */
async function getRecentPayments(tenantId, months = 6) {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('payment_date', { ascending: false })
    .limit(months);

  if (error) {
    console.error('[park-data] Payment lookup error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Check whether the current calendar month has a payment recorded.
 * @param {string} tenantId
 * @returns {Promise<object|null>}
 */
async function getCurrentMonthPayment(tenantId) {
  const now = new Date();
  const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('month_year', monthYear)
    .maybeSingle();

  if (error) {
    console.error('[park-data] Current month payment error:', error.message);
    return null;
  }
  return data;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtDate(dateStr) {
  if (!dateStr) return 'unknown';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtMonthYear(monthYear) {
  if (!monthYear) return 'unknown';
  const [y, m] = monthYear.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

// ── Context builders ──────────────────────────────────────────────────────────

/**
 * Build the account context string for a known tenant.
 * Used both for the phone-number pre-fetch and for tool call results.
 * @param {object} tenant - Tenant row from the database.
 * @returns {Promise<string>}
 */
async function buildAccountContext(tenant) {
  const [currentPayment, recentPayments] = await Promise.all([
    getCurrentMonthPayment(tenant.id),
    getRecentPayments(tenant.id, 6),
  ]);

  const now = new Date();
  const currentMonthLabel = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });

  const currentMonthStatus = currentPayment
    ? `PAID — $${Number(currentPayment.amount).toFixed(2)} on ${fmtDate(currentPayment.payment_date)}${currentPayment.status === 'partial' ? ' (partial)' : ''}`
    : 'UNPAID';

  const historyLines = recentPayments.length
    ? recentPayments.map((p) => {
        const label  = fmtMonthYear(p.month_year);
        const date   = fmtDate(p.payment_date);
        const status = p.status === 'partial' ? 'Partial payment' : p.status === 'waived' ? 'Waived' : 'Paid';
        return `  - ${label}: ${status} $${Number(p.amount).toFixed(2)} on ${date}`;
      }).join('\n')
    : '  No payment history on record.';

  return `RESIDENT ACCOUNT:
Name: ${tenant.first_name} ${tenant.last_name}
Lot: ${tenant.lot_number}
Monthly Rent: $${Number(tenant.lot_rent_amount).toFixed(2)}/month
Move-in Date: ${fmtDate(tenant.move_in_date)}
Balance Due: $${Number(tenant.balance_due).toFixed(2)}

${currentMonthLabel} (current month): ${currentMonthStatus}

PAYMENT HISTORY (last 6 months):
${historyLines}

Address the caller by their first name (${tenant.first_name}).`;
}

/**
 * Build the caller context injected into Claude's system prompt at call start.
 * Looks up by phone number; if not found, tells Claude to use the lookup tool.
 * @param {string} phoneNumber - Twilio From field.
 * @returns {Promise<string>}
 */
async function buildCallerContext(phoneNumber) {
  const tenant = await lookupTenant(phoneNumber);

  if (!tenant) {
    return `CALLER STATUS: Phone number ${phoneNumber} is not matched to any resident record.
If the caller tells you their name or lot number, use the lookup_resident_account tool to find their account.
Until you find their account, avoid making up any figures — just say you need their name or lot number to pull up the record.`;
  }

  return buildAccountContext(tenant);
}

module.exports = {
  lookupTenant,
  lookupTenantByName,
  lookupTenantByLot,
  getRecentPayments,
  getCurrentMonthPayment,
  buildAccountContext,
  buildCallerContext,
};
