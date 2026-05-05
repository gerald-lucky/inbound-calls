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
- List and send tenant documents (account statements, history file attachments) directly into this Slack thread as PDF files

Since this is a text chat you may use formatting, bullet points, and numbers for clarity.
Keep responses concise and factual — you are a tool for teammates, not a conversationalist.
Never make up account figures; always look them up first.

COMMUNITY/PROPERTY NAMES: When a staff member mentions a park or community name:
1. Try the vacancy or lookup tool directly with the name given.
2. If no match is found, automatically call list_properties and pick the closest matching name — do NOT ask the user first, just retry with the best match.
3. Only ask for clarification if two or more properties are equally close matches (e.g. "Pinhook North" vs "Pinhook South"). In that case, list the options and ask which one they mean.
4. Common shorthand: "Pinhook" → "Pinhook Mobile Home Park", "Messer" → "Messer Community", etc. Always try the short name before giving up.`;

const TOOLS = [
  {
    name: 'lookup_resident',
    description:
      'Look up a resident in Rent Manager by name, unit/lot number, or both. ' +
      'Returns account details, current balance, recent transactions, and TWA info. ' +
      'Always pass community_name when the user mentions a park/community (e.g. "Oakview lot 2" → unit_number="2", community_name="Oakview").',
    input_schema: {
      type: 'object',
      properties: {
        first_name:     { type: 'string', description: "Resident's first name" },
        last_name:      { type: 'string', description: "Resident's last name" },
        unit_number:    { type: 'string', description: "Resident's unit or lot number (digits/ID only, e.g. '4', 'P-4')" },
        community_name: { type: 'string', description: "Park or community name to narrow the search (e.g. 'Oakview', 'Pinhook')" },
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
    description: "Look up (or generate if none exists) a tenant's Zego CashPay account number for paying cash at Walmart/CVS.",
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'number', description: "Resident's Rent Manager TenantID" },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'list_properties',
    description: 'List all property/community names in Rent Manager. Use this when you need to find the exact name of a community, or when a vacancy query returns no results.',
    input_schema: { type: 'object', properties: {} },
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
  {
    name: 'list_tenant_documents',
    description:
      'List available documents for a tenant — account statements and history file attachments. ' +
      'Returns a list with doc_url and description for each. Use this before send_tenant_document to find the right file.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'number', description: "Resident's Rent Manager TenantID" },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'send_tenant_document',
    description:
      'Download a tenant document from Rent Manager and upload it directly into this Slack thread as a file. ' +
      'Get the doc_url from list_tenant_documents first.',
    input_schema: {
      type: 'object',
      properties: {
        doc_url:  { type: 'string', description: 'The document URL returned by list_tenant_documents' },
        filename: { type: 'string', description: 'Filename to use (e.g. "statement-april-2025.pdf")' },
        title:    { type: 'string', description: 'Display title for the file in Slack' },
      },
      required: ['doc_url', 'filename', 'title'],
    },
  },
];

async function executeTool(name, input, slackContext = null) {
  console.log(`[slack-bot] tool: ${name}`, JSON.stringify(input));

  if (name === 'lookup_resident') {
    const { first_name, last_name, unit_number, community_name } = input;
    let tenant = null;
    // Try name first scoped to community if provided; unit lookup as fallback
    if (first_name || last_name) tenant = await rm.lookupTenantByName(first_name, last_name, community_name);
    if (!tenant && unit_number) tenant = await rm.lookupTenantByUnit(unit_number, community_name);
    if (!tenant) return 'No resident found with that name or unit number.';
    const [payments, balance, location] = await Promise.all([
      rm.getPaymentHistory(tenant.TenantID, 6),
      rm.getTenantBalance(tenant.TenantID),
      rm.resolveTenantLocation(tenant),
    ]);
    if (balance !== null) tenant.Balance = balance;
    return rm.buildAccountSummary(tenant, payments, location);
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
      const result  = await rm.getCashPayCode(input.tenant_id);
      const { code, source, raw } = result ?? {};
      if (!code) {
        const detail = raw ? ` Raw response: ${JSON.stringify(raw)}` : '';
        return `No CashPay account number found for this tenant.${detail}`;
      }
      const label   = source === 'existing' ? 'CashPay account number (existing)'
                    : source === 'udf'      ? 'CashPay account number (from tenant record)'
                    :                         'CashPay account number (newly generated)';
      return `${label}: *${code}*\nTenant can pay cash at Walmart, CVS, or any Zego/PayNearMe location using this number.`;
    } catch (err) {
      return `Could not retrieve CashPay code: ${err.message}`;
    }
  }

  if (name === 'list_properties') {
    const names = await rm.listProperties();
    return names.length
      ? `Properties in Rent Manager:\n${names.map(n => `• ${n}`).join('\n')}`
      : 'No properties found in Rent Manager.';
  }

  if (name === 'get_vacancy_report') {
    try {
      return await rm.getVacancyReport(input.community_name);
    } catch (err) {
      return `Could not fetch vacancy report: ${err.message}`;
    }
  }

  if (name === 'list_tenant_documents') {
    const tid      = input.tenant_id;
    const [stmts, histFiles] = await Promise.all([
      rm.getTenantStatements(tid, 5),
      rm.getTenantHistoryFiles(tid, 10),
    ]);

    const lines = [];

    for (const s of stmts) {
      const url  = s.StatementURL || s.DocumentURL || s.URL || null;
      const date = s.StatementDate ? new Date(s.StatementDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'unknown date';
      if (url) lines.push(`STATEMENT | ${date} | ${url}`);
    }

    for (const h of histFiles) {
      const attachments = h.HistoryAttachments || [];
      for (const a of attachments) {
        const url      = a.URL || a.FileURL || a.DownloadURL || (a.File?.URL) || null;
        const fname    = a.FileName || a.Name || 'attachment';
        const noteDate = h.Date ? new Date(h.Date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'unknown date';
        if (url) lines.push(`HISTORY | ${noteDate} — ${fname} | ${url}`);
      }
      // Legacy single-attachment field
      const legacyUrl = h.Attachment?.URL || h.Attachment?.FileURL || null;
      if (legacyUrl && !attachments.length) {
        const noteDate = h.Date ? new Date(h.Date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'unknown date';
        lines.push(`HISTORY | ${noteDate} — ${h.Attachment?.FileName || 'attachment'} | ${legacyUrl}`);
      }
    }

    if (!lines.length) return 'No documents found for this tenant (no statements or history file attachments).';

    return `Available documents (format: TYPE | Date | doc_url):\n${lines.join('\n')}`;
  }

  if (name === 'send_tenant_document') {
    if (!slackContext?.uploadFile) return 'Document upload is not available in this context.';
    try {
      const { buffer, filename: detectedName } = await rm.downloadRmFile(input.doc_url);
      const filename = input.filename || detectedName || 'document.pdf';
      const title    = input.title || filename;
      await slackContext.uploadFile(buffer, filename, title);
      return `✓ Uploaded "${title}" to this thread.`;
    } catch (err) {
      console.error('[slack-bot] send_tenant_document:', err.message);
      return `Could not upload document: ${err.message}`;
    }
  }

  return 'Unknown tool.';
}

// ── Thread memory (keyed by Slack thread_ts) ─────────────────────────────────

const _threads    = new Map(); // threadTs -> { history: [], lastActive: number }
const THREAD_TTL  = 2 * 60 * 60 * 1000; // expire after 2 hours of inactivity
const MAX_HISTORY = 40; // max stored message objects (~20 back-and-forth turns)

function getHistory(threadTs) {
  if (!threadTs) return [];
  const entry = _threads.get(threadTs);
  if (!entry) return [];
  if (Date.now() - entry.lastActive > THREAD_TTL) { _threads.delete(threadTs); return []; }
  return entry.history;
}

function hasFreshHistory(threadTs) {
  if (!threadTs) return false;
  const entry = _threads.get(threadTs);
  return !!entry && Date.now() - entry.lastActive <= THREAD_TTL;
}

function saveHistory(threadTs, history) {
  if (!threadTs) return;
  const trimmed = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;
  _threads.set(threadTs, { history: trimmed, lastActive: Date.now() });
}

/**
 * Process a Slack message from a teammate and return a text response.
 * @param {string} userText  - The message text (bot mention already stripped).
 * @param {string} threadTs  - Slack thread_ts used as conversation key.
 * @returns {Promise<string>}
 */
async function processSlackMessage(userText, threadTs, prefetchedHistory = null, slackContext = null) {
  const history  = prefetchedHistory ?? getHistory(threadTs);
  const messages = [...history, { role: 'user', content: userText }];

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
      const reply = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      saveHistory(threadTs, messages);
      return reply;
    }

    // Execute tool calls
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = await executeTool(block.name, block.input, slackContext);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  saveHistory(threadTs, messages);
  return 'I hit the maximum number of lookup steps. Please try a more specific query.';
}

module.exports = { processSlackMessage, hasFreshHistory };
