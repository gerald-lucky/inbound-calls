'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { EventEmitter } = require('events');
const rm        = require('./rent-manager');
const knowledge = require('./knowledge');
const { PSA_SYSTEM_PROMPT } = require('./psa-persona');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Sentence-boundary pattern — flush to TTS at natural speech breaks
const SENTENCE_END = /[.!?]\s+|[.!?]$/;

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'lookup_resident',
    description:
      'Look up a resident in Rent Manager by name or unit/lot number. ' +
      'Returns account details, balance, recent transactions, and TWA account number. ' +
      'Use whenever the caller provides their name or unit number. ' +
      'After a successful lookup, always verify identity before sharing account details.',
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
    name: 'verify_identity',
    description:
      'Verify the caller is the account holder before sharing any account-specific information. ' +
      'ALWAYS call this before reading account details aloud. ' +
      'Primary method: ask the caller their lot or unit number and pass it here. ' +
      'Fallback method: if the unit does not match, ask for the amount of their last rent payment and pass it here instead.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id:           { type: 'number', description: "Resident's TenantID from a prior lookup" },
        stated_unit:         { type: 'string', description: 'Lot or unit number the caller stated (primary verification method)' },
        stated_last_payment: { type: 'number', description: 'Dollar amount of last payment the caller stated (fallback method, used only if unit did not match)' },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'get_payment_history',
    description:
      'Fetch detailed payment/transaction history for a verified resident. ' +
      'Use for payment disputes, clarifications, or when the caller asks about past payments. ' +
      'Requires a verified session (verify_identity must have succeeded).',
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
    description:
      'Generate a CashPay barcode/code so the resident can pay rent in cash at Walmart, CVS, or other Zego/PayNearMe locations. ' +
      'Requires a verified session.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'number', description: "Resident's Rent Manager TenantID" },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'get_my_service_tickets',
    description:
      'Look up service tickets (maintenance/work orders) for the verified caller\'s unit. ' +
      'Returns ticket status, description, and resolution notes. ' +
      'Requires a verified session. Do not use for staff or community-wide lookups.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Filter by status. Use "open" for active requests, "all" for full history. Default: "all".',
        },
      },
    },
  },
  {
    name: 'search_knowledge',
    description:
      'Search the Lucky Communities knowledge base for policy information, SOPs, community rules, ' +
      'procedures, and operating standards. Use this whenever a caller asks about rules, policies, ' +
      'fees, pet policy, pool rules, maintenance procedures, lease terms, move-in/out processes, ' +
      'or any question that requires company-specific knowledge. ' +
      'Prefer this over guessing or relying on memory.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The caller\'s question or topic to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_my_statements',
    description:
      'Retrieve account statements for the verified caller. ' +
      'Returns monthly account statements only — not internal documents, compliance files, or staff notes. ' +
      'Requires a verified session.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'number', description: "Resident's Rent Manager TenantID" },
      },
      required: ['tenant_id'],
    },
  },
];

// ── Unit-number normalisation (strips "lot", "unit", spaces, leading zeros) ───

function normaliseUnit(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/\b(lot|unit|apt|space|sp)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/^0+(?=\d)/, '');
}

// ── LLMService ────────────────────────────────────────────────────────────────

/**
 * LLMService handles a single phone-call conversation with Claude.
 * Manages an identity verification state that gates account-level tool access.
 *
 * @param {string} systemPrompt  - Per-agent system prompt (agent_configs DB row or default PSA).
 * @param {string} callerContext - Pre-fetched account snapshot built from the caller's phone number.
 *
 * Events:
 *   'sentence'  (text: string)     — complete sentence ready for TTS
 *   'done'      (fullText: string) — full response committed to history
 *   'error'     (err: Error)
 */
class LLMService extends EventEmitter {
  constructor(systemPrompt, callerContext) {
    super();
    this._systemPrompt = systemPrompt || PSA_SYSTEM_PROMPT;
    this._callerContext = callerContext || '';

    // Identity verification state — scoped to this call session.
    // Verification requires 2 independent factors before account data is unlocked:
    //   Factor A — phone number matched to this account on pre-call lookup
    //   Factor B — caller confirms their unit/lot number
    // If phone did NOT match (unknown/spoofed number or family member calling),
    // both unit number AND last payment amount are required as factors B + C.
    this._verified         = false;
    this._verifiedTenantId = null;
    this._verifiedUnit     = null;
    this._verifiedCommunity = null;
    // True when the pre-call phone lookup found this account (Factor A)
    this._phoneMatched = callerContext
      ? !callerContext.includes('not matched to any Rent Manager tenant')
      : false;

    /** @type {Array<{role: string, content: string|Array}>} */
    this.conversationHistory = [];
  }

  // ── Tool execution ──────────────────────────────────────────────────────────

  async _executeToolCall(toolName, toolInput) {
    console.log(`[llm] tool: ${toolName}`, JSON.stringify(toolInput));

    // ── lookup_resident ───────────────────────────────────────────────────────
    if (toolName === 'lookup_resident') {
      const { first_name, last_name, unit_number } = toolInput;
      let tenant = null;

      if (unit_number) tenant = await rm.lookupTenantByUnit(unit_number);
      if (!tenant && (first_name || last_name)) tenant = await rm.lookupTenantByName(first_name, last_name);

      if (!tenant) {
        return 'No resident found with that name or unit number. Ask the caller to spell their name letter by letter, then try again with the corrected spelling.';
      }

      const payments = await rm.getPaymentHistory(tenant.TenantID, 6);
      // Return a prompt-safe summary that does NOT include the balance or detailed history —
      // those are only surfaced after identity is verified.
      const name    = `${tenant.FirstName} ${tenant.LastName}`;
      const display = tenant.TenantDisplayID ?? tenant.TenantID;
      return (
        `Account located:\n` +
        `Name: ${name}\n` +
        `TenantID (use for tools): ${tenant.TenantID}\n` +
        `Account#: ${display}\n` +
        `\nIdentity verification is required before sharing balance, payment history, or other account details. ` +
        `Ask the caller to confirm their lot or unit number to proceed.`
      );
    }

    // ── verify_identity ───────────────────────────────────────────────────────
    // Verification model (2-factor minimum):
    //
    //   Phone matched (Factor A) + unit number confirmed (Factor B) → PASS
    //   Phone matched (Factor A) + unit fails → offer last payment as Factor B → PASS
    //   Phone NOT matched            → require unit (Factor B) AND last payment (Factor C) → PASS
    //
    // Lot numbers are not considered private on their own; they are only used
    // as a confirming second factor alongside phone match, or alongside a second
    // secret (last payment amount) when phone match is absent.
    if (toolName === 'verify_identity') {
      const { tenant_id, stated_unit, stated_last_payment } = toolInput;

      // Pull actual unit/community from the pre-fetched caller context
      let actualUnit    = null;
      let communityName = null;
      if (this._callerContext) {
        const unitMatch = this._callerContext.match(/Unit:\s*([^\n]+)/i);
        const commMatch = this._callerContext.match(/Community:\s*([^\n]+)/i);
        if (unitMatch) actualUnit    = unitMatch[1].trim();
        if (commMatch) communityName = commMatch[1].trim();
      }

      // Fetch recent payments (needed for fallback and for summary on success)
      let payments = [];
      try { payments = await rm.getPaymentHistory(tenant_id, 6); } catch { /* ok */ }

      const unitKnown     = actualUnit && actualUnit !== '—';
      const unitProvided  = stated_unit != null && stated_unit !== '';
      const unitMatches   = unitKnown && unitProvided &&
                            normaliseUnit(stated_unit) === normaliseUnit(actualUnit);

      const paymentProvided = stated_last_payment != null;
      const lastAmount      = payments.length ? Math.abs(Number(payments[0].Amount || 0)) : null;
      const paymentMatches  = paymentProvided && lastAmount != null &&
                              Math.abs(lastAmount - Math.abs(stated_last_payment)) <= 5;

      // ── Determine if 2-factor threshold is met ─────────────────────────────
      let factorsMet = false;
      let failReason = '';

      if (this._phoneMatched) {
        // Factor A (phone) already satisfied — need one more factor
        if (unitMatches) {
          factorsMet = true;
        } else if (unitProvided && !unitMatches) {
          // Unit was given but didn't match — offer payment fallback
          console.log(`[llm] Unit mismatch (phone matched) for tenant ${tenant_id}: stated="${stated_unit}" actual="${actualUnit}"`);
          return (
            `The lot number provided did not match. ` +
            `Please ask the caller for the dollar amount of their most recent rent payment as an alternative. ` +
            `Then call verify_identity again with stated_last_payment.`
          );
        } else if (paymentMatches) {
          factorsMet = true;
        } else if (paymentProvided && !paymentMatches) {
          failReason = 'payment amount did not match';
        } else {
          // No second factor provided yet
          return (
            `Phone number is on file for this account. ` +
            `To complete verification, ask the caller to confirm their lot or unit number. ` +
            `Then call verify_identity with stated_unit.`
          );
        }
      } else {
        // Factor A absent — need both unit AND payment amount
        if (!unitProvided || !paymentProvided) {
          const missing = !unitProvided && !paymentProvided
            ? 'their lot number and the amount of their last rent payment'
            : !unitProvided ? 'their lot number' : 'the amount of their last rent payment';
          return (
            `This caller's phone number is not on file. ` +
            `To verify identity, two factors are required. ` +
            `Please ask the caller for ${missing}. ` +
            `Then call verify_identity with both stated_unit and stated_last_payment.`
          );
        }
        if (unitMatches && paymentMatches) {
          factorsMet = true;
        } else {
          failReason = !unitMatches ? 'lot number did not match' : 'payment amount did not match';
        }
      }

      // ── Verification failed ────────────────────────────────────────────────
      if (!factorsMet) {
        console.log(`[llm] Verification failed for tenant ${tenant_id}: ${failReason}`);
        return (
          `Identity could not be verified (${failReason}). ` +
          `Do not share account details. ` +
          `Offer to take a message for the property manager, or direct the caller to the Tenant Web Access portal at https://lucky.twa.rentmanager.com.`
        );
      }

      // ── Verification passed ────────────────────────────────────────────────
      this._verified          = true;
      this._verifiedTenantId  = tenant_id;
      this._verifiedUnit      = unitKnown ? normaliseUnit(actualUnit) : null;
      this._verifiedCommunity = communityName;
      console.log(`[llm] Identity verified for tenant ${tenant_id} (phoneMatched=${this._phoneMatched})`);

      const balance = payments[0]?.Balance ?? payments[0]?.CurrentBalance ?? payments[0]?.RunningBalance ?? 0;
      const historyLines = payments.length
        ? payments.map(t =>
            `  - ${new Date(t.TransactionDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}: ` +
            `${t.Description || t.TransactionType || 'Transaction'} — $${Math.abs(Number(t.Amount || 0)).toFixed(2)}`
          ).join('\n')
        : '  No recent transactions on record.';

      return (
        `Identity verified.\n\n` +
        `ACCOUNT DETAILS:\n` +
        `Unit: ${actualUnit || '—'} | Community: ${communityName || '—'}\n` +
        `Balance Due: $${Number(balance).toFixed(2)}\n\n` +
        `Recent transactions:\n${historyLines}\n\n` +
        `TWA: https://lucky.twa.rentmanager.com (account number = display Account#)`
      );
    }

    // ── Verified-only tools — gate check ─────────────────────────────────────
    const verifiedOnlyTools = ['get_payment_history', 'generate_cashpay_code', 'get_my_service_tickets', 'get_my_statements'];
    if (verifiedOnlyTools.includes(toolName) && !this._verified) {
      return `Identity has not been verified for this call. You must call verify_identity successfully before using ${toolName}.`;
    }

    // ── get_payment_history ───────────────────────────────────────────────────
    if (toolName === 'get_payment_history') {
      const payments = await rm.getPaymentHistory(toolInput.tenant_id, 12);
      if (!payments.length) return 'No transaction history found for this resident.';
      return payments.map(t =>
        `${new Date(t.TransactionDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}: ` +
        `${t.Description || t.TransactionType || 'Transaction'} — $${Math.abs(Number(t.Amount || 0)).toFixed(2)}`
      ).join('\n');
    }

    // ── generate_cashpay_code ─────────────────────────────────────────────────
    if (toolName === 'generate_cashpay_code') {
      try {
        const result = await rm.generateCashPayCode(toolInput.tenant_id);
        if (!result) return 'CashPay code generated but no details returned. Have the tenant log into TWA to generate one there.';
        const code    = result.BarcodeNumber || result.Code || result.barcode || JSON.stringify(result);
        const expires = result.ExpirationDate ? ` (expires ${result.ExpirationDate})` : '';
        return `CashPay code: ${code}${expires}. The resident can take this code to Walmart, CVS, or any PayNearMe/Zego location to pay in cash.`;
      } catch (err) {
        console.error('[llm] generateCashPayCode error:', err.message);
        return `Could not generate CashPay code: ${err.message}. The tenant can generate one by logging into the Tenant Web Access portal.`;
      }
    }

    // ── get_my_service_tickets ────────────────────────────────────────────────
    if (toolName === 'get_my_service_tickets') {
      const status = toolInput.status || 'all';
      try {
        const issues = await rm.getServiceIssues(
          this._verifiedCommunity || undefined,
          this._verifiedUnit      || undefined,
          status,
        );
        if (!issues || !issues.length) {
          return status === 'open'
            ? 'No open service tickets found for your unit.'
            : 'No service tickets found for your unit.';
        }
        return issues.map(i => {
          const date     = i.CreatedDate ? new Date(i.CreatedDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—';
          const resolved = i.ResolutionNotes || i.Resolution || '';
          return (
            `Ticket #${i.ServiceIssueID || i.IssueID || '—'} (${date}): ${i.Subject || i.Description || 'No description'} — Status: ${i.Status || '—'}` +
            (resolved ? ` | Resolution: ${resolved}` : '')
          );
        }).join('\n');
      } catch (err) {
        console.error('[llm] getServiceIssues error:', err.message);
        return `Could not retrieve service tickets: ${err.message}.`;
      }
    }

    // ── get_my_statements ─────────────────────────────────────────────────────
    if (toolName === 'get_my_statements') {
      try {
        const statements = await rm.getTenantStatements(toolInput.tenant_id, 6);
        if (!statements.length) return 'No account statements found.';
        return statements.map(s => {
          const date   = s.StatementDate || s.Date || s.CreatedDate || '—';
          const period = s.PeriodDescription || s.Period || '';
          const label  = period ? `${period} — ` : '';
          const url    = s.URL || s.StatementURL || s.DocumentURL || null;
          return `${label}Statement dated ${date}` + (url ? ` — available at: ${url}` : ' (available in TWA)');
        }).join('\n');
      } catch (err) {
        console.error('[llm] getTenantStatements error:', err.message);
        return `Could not retrieve statements: ${err.message}. The resident can view statements by logging into the Tenant Web Access portal.`;
      }
    }

    // ── search_knowledge ──────────────────────────────────────────────────────
    if (toolName === 'search_knowledge') {
      try {
        const chunks = await knowledge.searchKnowledge(toolInput.query, 4);
        if (!chunks || !chunks.length) {
          return 'No relevant information found in the knowledge base for that question. Answer from general knowledge if you can, or let the caller know you will follow up.';
        }
        return 'Relevant knowledge base results:\n\n' +
          chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n---\n\n');
      } catch (err) {
        console.warn('[llm] search_knowledge error:', err.message);
        return 'Knowledge base search is currently unavailable. Answer from your training if possible.';
      }
    }

    return 'Unknown tool.';
  }

  // ── Main respond loop ───────────────────────────────────────────────────────

  /**
   * Process a caller utterance: stream Claude's response while supporting
   * tool calls for live Rent Manager lookups. Emits 'sentence' for TTS chunks
   * and 'done' when the full response is committed.
   */
  async respond(utterance, signal) {
    this.conversationHistory.push({ role: 'user', content: utterance });

    const verificationStatus = this._verified
      ? `\nCALL VERIFICATION STATUS: Identity verified for TenantID ${this._verifiedTenantId} (Unit: ${this._verifiedUnit || '—'}). Account-level tools are unlocked for this call.`
      : '\nCALL VERIFICATION STATUS: Not yet verified. Do not share account-specific details until verify_identity succeeds.';

    const systemPrompt = [
      this._systemPrompt,
      this._callerContext ? `\n\n## Caller account context (pre-fetched by phone number)\n${this._callerContext}` : '',
      verificationStatus,
      '\n\n## Runtime reminders' +
      '\n- Respond in whatever language the caller is using. If they speak Spanish, reply in Spanish. If English, reply in English. Follow any mid-call language switch immediately.' +
      '\n- Keep responses to 2–4 sentences. No lists or markdown — speak naturally for phone.' +
      '\n- Say a brief hold phrase before every tool call (e.g. "One moment while I look that up.").' +
      '\n- When a caller spells their name letter by letter (e.g. "J-O-S-E"), reconstruct the full name before calling lookup_resident.' +
      '\n- For TWA access, the account number is the display Account# and the URL is https://lucky.twa.rentmanager.com.',
    ].join('');

    let fullTextResponse = '';

    try {
      for (let turn = 0; turn < 8; turn++) {
        if (signal?.aborted) break;

        let sentenceBuffer = '';

        const stream = anthropic.messages.stream(
          {
            model:      MODEL,
            max_tokens: 512,
            tools:      TOOLS,
            system:     systemPrompt,
            messages:   this.conversationHistory,
          },
          { signal },
        );

        stream.on('text', (token) => {
          if (signal?.aborted) return;
          sentenceBuffer   += token;
          fullTextResponse += token;

          const match = sentenceBuffer.search(SENTENCE_END);
          if (match !== -1) {
            const sentence = sentenceBuffer.slice(0, match + 1).trim();
            sentenceBuffer  = sentenceBuffer.slice(match + 1);
            if (sentence) this.emit('sentence', sentence);
          }
        });

        const finalMessage = await stream.finalMessage();

        if (sentenceBuffer.trim() && !signal?.aborted) {
          this.emit('sentence', sentenceBuffer.trim());
        }

        this.conversationHistory.push({ role: 'assistant', content: finalMessage.content });

        if (finalMessage.stop_reason !== 'tool_use' || signal?.aborted) {
          if (!signal?.aborted) this.emit('done', fullTextResponse);
          break;
        }

        const toolResults = [];
        for (const block of finalMessage.content) {
          if (block.type !== 'tool_use') continue;
          const result = await this._executeToolCall(block.name, block.input);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }

        if (signal?.aborted) break;
        this.conversationHistory.push({ role: 'user', content: toolResults });
      }
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) {
        console.log('[llm] Stream aborted (barge-in)');
      } else {
        console.error('[llm] Claude error:', err.message);
        this.emit('error', err);
      }
    }
  }

  // ── Lead extraction ─────────────────────────────────────────────────────────

  async tryExtractLead(callerNumber) {
    if (this.conversationHistory.length < 2) return null;

    const transcript = this.conversationHistory
      .filter(m => typeof m.content === 'string')
      .map(m => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`)
      .join('\n');

    try {
      const response = await anthropic.messages.create({
        model:      MODEL,
        max_tokens: 200,
        system:
          'You are a lead extraction assistant. Given a call transcript, determine if the caller provided contact information or expressed clear interest. Respond with valid JSON only: {"is_lead": true/false, "name": "...", "email": "...", "notes": "..."}. Use null for missing fields. Keep notes under 100 characters.',
        messages: [{ role: 'user', content: `Caller phone: ${callerNumber}\n\nTranscript:\n${transcript}` }],
      });

      const raw = response.content[0]?.text?.trim();
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed.is_lead) return null;
      return { name: parsed.name || null, email: parsed.email || null, notes: parsed.notes || null };
    } catch {
      return null;
    }
  }

  reset() {
    this.conversationHistory = [];
    this._verified           = false;
    this._verifiedTenantId   = null;
    this._verifiedUnit       = null;
    this._verifiedCommunity  = null;
    this._phoneMatched       = false;
  }
}

module.exports = LLMService;
