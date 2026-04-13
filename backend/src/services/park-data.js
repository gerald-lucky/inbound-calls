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
  // Keep leading + then strip all non-digits
  const hasPlus = phone.trim().startsWith('+');
  const digits = phone.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Look up a tenant by their phone number (Twilio From field).
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
 * Get a tenant's payment history, newest first.
 * @param {string} tenantId
 * @param {number} months - How many recent months to return.
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
 * @returns {Promise<object|null>} Payment row if found, null if unpaid.
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

/**
 * Format a date string for natural speech.
 * e.g. "2021-03-15" → "March 15, 2021"
 */
function fmtDate(dateStr) {
  if (!dateStr) return 'unknown';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Format a YYYY-MM month_year string for natural speech.
 * e.g. "2025-04" → "April 2025"
 */
function fmtMonthYear(monthYear) {
  if (!monthYear) return 'unknown';
  const [y, m] = monthYear.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

/**
 * Build the caller context string injected into Claude's system prompt.
 * This replaces the RAG vector search — all data is structured and pre-fetched
 * once at call start, adding zero per-turn latency.
 *
 * @param {string} phoneNumber - Twilio From field.
 * @returns {Promise<string>}
 */
async function buildCallerContext(phoneNumber) {
  const tenant = await lookupTenant(phoneNumber);

  if (!tenant) {
    return `CALLER STATUS: Not found in system (phone: ${phoneNumber}).
If asked about their account, let them know you can't locate their record and ask them to contact the office directly.`;
  }

  const [currentPayment, recentPayments] = await Promise.all([
    getCurrentMonthPayment(tenant.id),
    getRecentPayments(tenant.id, 6),
  ]);

  const now = new Date();
  const currentMonthLabel = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });

  const currentMonthStatus = currentPayment
    ? `PAID — $${Number(currentPayment.amount).toFixed(2)} on ${fmtDate(currentPayment.payment_date)}${currentPayment.status === 'partial' ? ' (partial)' : ''}`
    : `UNPAID`;

  const historyLines = recentPayments.length
    ? recentPayments.map((p) => {
        const label = fmtMonthYear(p.month_year);
        const date  = fmtDate(p.payment_date);
        const status = p.status === 'partial' ? 'Partial payment' : p.status === 'waived' ? 'Waived' : 'Paid';
        return `  - ${label}: ${status} $${Number(p.amount).toFixed(2)} on ${date}`;
      }).join('\n')
    : '  No payment history on record.';

  return `CALLER ACCOUNT:
Name: ${tenant.first_name} ${tenant.last_name}
Lot: ${tenant.lot_number}
Monthly Rent: $${Number(tenant.lot_rent_amount).toFixed(2)}/month
Move-in Date: ${fmtDate(tenant.move_in_date)}
Balance Due: $${Number(tenant.balance_due).toFixed(2)}

${currentMonthLabel} (current month): ${currentMonthStatus}

PAYMENT HISTORY (last 6 months):
${historyLines}

Address the caller by their first name (${tenant.first_name}). Use the account information above to answer questions about rent, balance, and payment history accurately.`;
}

module.exports = { lookupTenant, getRecentPayments, getCurrentMonthPayment, buildCallerContext };
