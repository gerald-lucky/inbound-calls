'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const rm        = require('./rent-manager');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL     = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are Britney, an AI property management assistant for Lucky Community staff.

IMPORTANT CONTEXT: You are in STAFF MODE — you are chatting with a Lucky Community teammate via Slack, NOT with a tenant. Teammates can ask about any resident by name, unit number, or account.

You have live access to Rent Manager and can:
- Look up any resident's account, balance, unit info, and contact details (phone numbers, emails, co-applicants)
- Pull payment history for disputes or clarifications
- Generate CashPay codes (Zego) so a tenant can pay cash at Walmart
- Provide a tenant's TWA account number and URL for portal/auto-pay setup
- Get vacancy and occupancy stats for the property
- Look up recurring charges (waste removal, water, sewer, etc.) configured for a property
- Read tenant history notes (staff notes, lease events, move-in/out records, violations, communications)
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
        tenant_id: { type: 'number', description: "Resident's internal TenantID (the 'TenantID (use for tools)' field in the account summary — NOT the display Account#)" },
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
        tenant_id: { type: 'number', description: "Resident's internal TenantID (the 'TenantID (use for tools)' field in the account summary — NOT the display Account#)" },
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
    name: 'get_recurring_charges',
    description: 'List recurring charges (fees) configured in Rent Manager for a property — e.g. waste removal, water, sewer, late fees. Optionally filter by community name.',
    input_schema: {
      type: 'object',
      properties: {
        community_name: { type: 'string', description: 'Community or property name to filter by (e.g. "Country Estates", "Rainbow Terrace"). Omit to get all properties.' },
      },
    },
  },
  {
    name: 'get_vendors',
    description:
      'List vendors (contractors, service providers) configured in Rent Manager. ' +
      'Use when staff ask who the plumber, electrician, landscaper, or any contractor is for a community. ' +
      'Optionally filter by community name and/or service category.',
    input_schema: {
      type: 'object',
      properties: {
        community_name: {
          type: 'string',
          description: 'Community or property name to filter vendors by (e.g. "Country Estates", "Rainbow Terrace"). Omit to list all vendors.',
        },
        category: {
          type: 'string',
          description: 'Service type keyword to filter by (e.g. "plumber", "electrical", "landscaping"). Applied client-side on the results.',
        },
      },
    },
  },
  {
    name: 'get_service_issues',
    description:
      'Look up service tickets / work orders in Rent Manager. ' +
      'Use when staff ask about open maintenance requests, repairs, service tickets, or the resolution/details of a specific issue. ' +
      'Can look up a specific issue by ID number, or filter by community, lot/unit, and status.',
    input_schema: {
      type: 'object',
      properties: {
        issue_id: {
          type: 'number',
          description: 'Service issue or work order ID number for direct lookup (e.g. 406). Use this when staff ask about a specific ticket by number.',
        },
        community_name: {
          type: 'string',
          description: 'Community or property name (e.g. "Messer", "Country Estates"). Omit to search all communities.',
        },
        unit_number: {
          type: 'string',
          description: 'Lot or unit number to filter by (e.g. "25", "Lot 25", "42B"). Omit to return all units.',
        },
        status: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Filter by status: "open" (default), "closed", or "all". Ignored when issue_id is provided.',
        },
      },
    },
  },
  {
    name: 'get_contact_info',
    description:
      'Get all phone numbers and email addresses for a tenant, including co-applicants, spouses, and occupants on the account. ' +
      'Use this whenever a staff member asks for a phone number or contact info.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'number', description: "Resident's internal TenantID (the 'TenantID (use for tools)' field — NOT the display Account#)" },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'get_history_notes',
    description:
      'Fetch history notes (staff notes, lease events, communications log) for a tenant from Rent Manager. ' +
      'Returns note date, subject, body text, and flags any file attachments. ' +
      'Use this to check for signed leases, move-in/out notes, violation records, or any staff communications.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'number', description: "Resident's internal TenantID (the 'TenantID (use for tools)' field — NOT the display Account#)" },
        limit:     { type: 'number', description: 'Max number of notes to return (default 20, most recent first)' },
      },
      required: ['tenant_id'],
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
        tenant_id: { type: 'number', description: "Resident's internal TenantID (the 'TenantID (use for tools)' field — NOT the display Account#)" },
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

    if (first_name || last_name) {
      // Check for duplicate names before committing to one tenant
      const matches = await rm.findAllNameMatches(first_name, last_name, community_name);
      // Only ask for disambiguation when EVERY match has the exact same full name
      // (true duplicates). Partial matches returning multiple results should just
      // pick the best one rather than confusing staff with a disambiguation prompt.
      const fullName = t => `${(t.FirstName || '').toLowerCase()} ${(t.LastName || '').toLowerCase()}`.trim();
      const allIdentical = matches.length > 1 && matches.every(t => fullName(t) === fullName(matches[0]));
      if (allIdentical && !community_name && !unit_number) {
        // Resolve location for each candidate so staff can identify the right one
        const details = await Promise.all(matches.map(t => rm.resolveTenantLocation(t)));
        const list = matches.map((t, i) => {
          const loc = details[i];
          return `• ${t.FirstName} ${t.LastName} — Unit ${loc.unitName}, ${loc.communityName} (Account# ${t.TenantDisplayID ?? t.TenantID})`;
        }).join('\n');
        return `Multiple residents match that name. Please specify the community or unit number:\n${list}`;
      }
      tenant = matches[0] ?? null;
    }

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

  if (name === 'get_recurring_charges') {
    try {
      return await rm.getRecurringCharges(input.community_name);
    } catch (err) {
      return `Could not fetch recurring charges: ${err.message}`;
    }
  }

  if (name === 'get_vendors') {
    try {
      let result = await rm.getVendors(input.community_name);
      if (input.category && result && !result.startsWith('No ') && !result.startsWith('Could not') && !result.startsWith('No property')) {
        const cat      = input.category.toLowerCase();
        const blocks   = result.split('\n\n');
        const header   = blocks[0];
        const filtered = blocks.slice(1).filter(b => b.toLowerCase().includes(cat));
        result = filtered.length
          ? `${header}\n\n${filtered.join('\n\n')}`
          : `No vendors matching category "${input.category}" found.`;
      }
      return result;
    } catch (err) {
      return `Could not fetch vendors: ${err.message}`;
    }
  }

  if (name === 'get_service_issues') {
    try {
      return await rm.getServiceIssues(input.community_name, input.unit_number, input.status ?? 'open', input.issue_id ?? null);
    } catch (err) {
      return `Could not fetch service issues: ${err.message}`;
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

  if (name === 'get_contact_info') {
    try {
      const contacts = await rm.getTenantContacts(input.tenant_id);
      if (!contacts.length) return 'No contact records found for this tenant.';

      const lines = contacts.map(c => {
        const name  = [c.FirstName, c.MiddleName, c.LastName].filter(Boolean).join(' ');
        const role  = c.ApplicantType || (c.ContactTypeID === -1 ? 'Primary' : null) || `Contact #${c.ContactID}`;
        const email = (c.Email || '').trim();
        const phones = (c.PhoneNumbers || []).map(p => {
          const primary  = p.IsPrimary ? ' (primary)' : '';
          const textable = p.IsTextReady ? ' 📱' : '';
          return `    • ${p.PhoneNumber}${primary}${textable}`;
        });
        const parts = [`**${name}** — ${role}`];
        if (phones.length) parts.push(...phones);
        if (email) parts.push(`    • Email: ${email}`);
        return parts.join('\n');
      });

      return `CONTACTS & PHONE NUMBERS:\n${lines.join('\n')}`;
    } catch (err) {
      return `Could not fetch contact info: ${err.message}`;
    }
  }

  if (name === 'get_history_notes') {
    try {
      const notes = await rm.getHistoryNotes(input.tenant_id, input.limit ?? 20);
      if (!notes.length) return 'No history notes found for this tenant.';

      const lines = notes.map(n => {
        const date    = n.Date ? new Date(n.Date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'unknown date';
        const subject = n.Subject || n.Title || n.Category || '(no subject)';
        const body    = (n.Body || n.Note || n.Description || n.Comments || n.Comment || '').trim();
        const attachments = (n.HistoryAttachments || []);
        const legacyFile  = n.Attachment?.FileName || n.Attachment?.Name || null;
        const fileCount   = attachments.length || (legacyFile ? 1 : 0);
        const fileNote    = fileCount ? ` [${fileCount} attachment${fileCount > 1 ? 's' : ''}]` : '';
        return `• ${date} — ${subject}${fileNote}${body ? `\n  ${body.slice(0, 300)}${body.length > 300 ? '…' : ''}` : ''}`;
      });

      return `HISTORY NOTES (${notes.length} most recent):\n${lines.join('\n')}`;
    } catch (err) {
      return `Could not fetch history notes: ${err.message}`;
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
    let response;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        response = await anthropic.messages.create({
          model:      MODEL,
          max_tokens: 1024,
          tools:      TOOLS,
          system:     SYSTEM_PROMPT,
          messages,
        });
        break; // success
      } catch (err) {
        const status = err.status ?? err.statusCode ?? 0;
        const isOverloaded = status === 529 || status === 529 ||
          (err.message || '').toLowerCase().includes('overloaded');
        const isRateLimit  = status === 429;
        if ((isOverloaded || isRateLimit) && attempt < 3) {
          const wait = [5000, 15000, 30000][attempt];
          console.warn(`[slack-bot] Anthropic ${status} on attempt ${attempt + 1}, retrying in ${wait / 1000}s`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }

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
