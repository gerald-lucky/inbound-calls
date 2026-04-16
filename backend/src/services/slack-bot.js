'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const rm        = require('./rent-manager');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL     = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are Britney, an AI property management assistant for Lucky Community staff.

IMPORTANT CONTEXT: You are in STAFF MODE — you are chatting with a Lucky Community teammate via Slack, NOT with a tenant. Teammates can ask about any resident by name, unit number, or account.

You have live access to Rent Manager and can:
- Look up any resident's account, balance, and unit info
- Pull payment history for disputes or clarifications
- Generate CashPay codes (Zego) so a tenant can pay cash at Walmart
- Provide a tenant's TWA account number and URL for portal/auto-pay setup
- Get vacancy and occupancy stats for the property

Since this is a text chat you may use formatting, bullet points, and numbers for clarity.
Keep responses concise and factual — you are a tool for teammates, not a conversationalist.
Never make up account figures; always look them up first.`;

const TOOLS = [
  {
    name: 'lookup_resident',
    description:
      'Look up a resident in Rent Manager by name or unit/lot number. ' +
      'Returns account details, current balance, recent transactions, and TWA info.',
    input_schema: {
      type: 'object',
      properties: {
        first_name:  { type: 'string', description: "Resident's first name" },
        last_name:   { type: 'string', description: "Resident's last name" },
        unit_number: { type: 'string', description: "Resident's unit or lot number" },
      },
    },
  },
  {
    name: 'get_payment_history',
    description: "Fetch detailed payment/transaction history for a resident. Use for disputes or clarifications.",
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'number', description: "Resident's Rent Manager TenantID" },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'generate_cashpay_code',
    description: "Generate a Zego CashPay code so a tenant can pay cash at Walmart/CVS.",
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'number', description: "Resident's Rent Manager TenantID" },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'get_vacancy_report',
    description: 'Get vacancy and occupancy stats — total units, occupied, vacant counts, and vacant unit numbers. Optionally filter by community/property name.',
    input_schema: {
      type: 'object',
      properties: {
        community_name: { type: 'string', description: 'Optional community or property name to filter by (e.g. "Baudin", "Messer")' },
      },
    },
  },
];

async function executeTool(name, input) {
  console.log(`[slack-bot] tool: ${name}`, JSON.stringify(input));

  if (name === 'lookup_resident') {
    const { first_name, last_name, unit_number } = input;
    let tenant = null;
    if (unit_number) tenant = await rm.lookupTenantByUnit(unit_number);
    if (!tenant && (first_name || last_name)) tenant = await rm.lookupTenantByName(first_name, last_name);
    if (!tenant) return 'No resident found with that name or unit number.';
    const payments = await rm.getPaymentHistory(tenant.TenantID, 6);
    return rm.buildAccountSummary(tenant, payments);
  }

  if (name === 'get_payment_history') {
    const payments = await rm.getPaymentHistory(input.tenant_id, 12);
    if (!payments.length) return 'No transaction history found.';
    return payments.map((t) =>
      `• ${new Date(t.TransactionDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}: ` +
      `${t.Description || t.TransactionType || 'Transaction'} — $${Math.abs(Number(t.Amount || 0)).toFixed(2)}`
    ).join('\n');
  }

  if (name === 'generate_cashpay_code') {
    try {
      const result = await rm.generateCashPayCode(input.tenant_id);
      if (!result) return 'CashPay code generated — check Rent Manager for details.';
      const code    = result.BarcodeNumber || result.Code || result.barcode || JSON.stringify(result);
      const expires = result.ExpirationDate ? ` (expires ${result.ExpirationDate})` : '';
      return `CashPay code: *${code}*${expires}\nTenant can use this at Walmart, CVS, or any PayNearMe/Zego location.`;
    } catch (err) {
      return `Could not generate CashPay code: ${err.message}`;
    }
  }

  if (name === 'get_vacancy_report') {
    try {
      return await rm.getVacancyReport(input.community_name);
    } catch (err) {
      return `Could not fetch vacancy report: ${err.message}`;
    }
  }

  return 'Unknown tool.';
}

/**
 * Process a Slack message from a teammate and return a text response.
 * @param {string} userText - The message text (bot mention already stripped).
 * @returns {Promise<string>}
 */
async function processSlackMessage(userText) {
  const messages = [{ role: 'user', content: userText }];

  for (let turn = 0; turn < 5; turn++) {
    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      tools:      TOOLS,
      system:     SYSTEM_PROMPT,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      // Extract text from response
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    }

    // Execute tool calls
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = await executeTool(block.name, block.input);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return 'I hit the maximum number of lookup steps. Please try a more specific query.';
}

module.exports = { processSlackMessage };
