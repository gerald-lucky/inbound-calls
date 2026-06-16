'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { EventEmitter } = require('events');
const rm  = require('./rent-manager');
const rag = require('./rag');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Sentence-boundary pattern — flush to TTS at natural speech breaks
const SENTENCE_END = /[.!?]\s+|[.!?]$/;

// ── Tools Claude can call against Rent Manager ────────────────────────────────

const TOOLS = [
  {
    name: 'lookup_resident',
    description:
      'Look up a resident in Rent Manager by name or unit/lot number. ' +
      'Returns account details, balance, recent transactions, and TWA account number. ' +
      'Use whenever the caller provides their name or unit number.',
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
    description:
      'Fetch detailed payment/transaction history for a resident from Rent Manager. ' +
      'Use for payment disputes, clarifications, or when the caller asks about past payments. ' +
      'Requires the TenantID from a prior lookup.',
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
      'Generate a CashPay barcode/code so the resident can pay their rent in cash at Walmart, CVS, or other retail locations through the Zego network. ' +
      'Requires the TenantID from a prior lookup.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'number', description: "Resident's Rent Manager TenantID" },
      },
      required: ['tenant_id'],
    },
  },
];

/**
 * Execute a tool call requested by Claude and return a result string.
 */
async function executeToolCall(toolName, toolInput) {
  console.log(`[llm] tool: ${toolName}`, JSON.stringify(toolInput));

  if (toolName === 'lookup_resident') {
    const { first_name, last_name, unit_number } = toolInput;
    let tenant = null;

    if (unit_number) tenant = await rm.lookupTenantByUnit(unit_number);
    if (!tenant && (first_name || last_name)) tenant = await rm.lookupTenantByName(first_name, last_name);

    if (!tenant) {
      return 'No resident found with that name or unit number. Ask the caller to spell their name letter by letter, then try again with the corrected spelling.';
    }

    const payments = await rm.getPaymentHistory(tenant.TenantID, 6);
    return rm.buildAccountSummary(tenant, payments);
  }

  if (toolName === 'get_payment_history') {
    const payments = await rm.getPaymentHistory(toolInput.tenant_id, 12);
    if (!payments.length) return 'No transaction history found for this resident.';
    return payments.map((t) =>
      `${new Date(t.TransactionDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}: ` +
      `${t.Description || t.TransactionType || 'Transaction'} — $${Math.abs(Number(t.Amount || 0)).toFixed(2)}`
    ).join('\n');
  }

  if (toolName === 'generate_cashpay_code') {
    try {
      const result = await rm.generateCashPayCode(toolInput.tenant_id);
      if (!result) return 'CashPay code generated but no details returned. Please check Rent Manager or have the tenant log into TWA.';
      const code    = result.BarcodeNumber || result.Code || result.barcode || JSON.stringify(result);
      const expires = result.ExpirationDate ? ` (expires ${result.ExpirationDate})` : '';
      return `CashPay code generated: ${code}${expires}. The resident can take this code to Walmart, CVS, or any PayNearMe/Zego location to pay in cash. No account or card needed.`;
    } catch (err) {
      console.error('[llm] generateCashPayCode error:', err.message);
      return `Could not generate CashPay code: ${err.message}. The tenant can also generate one by logging into the Tenant Web Access portal.`;
    }
  }

  return 'Unknown tool.';
}

// ── LLMService ────────────────────────────────────────────────────────────────

/**
 * LLMService handles a single conversation with Claude Sonnet 4.6.
 * Supports tool use so Claude can query the residents database by name/lot.
 *
 * @param {string} systemPrompt   - Per-agent system prompt (from agent config or env var).
 * @param {string} callerContext  - Pre-fetched tenant account info (or "not found" hint).
 * @param {string} ragContext     - Pre-loaded KB context injected once into every system prompt.
 * @param {string} agentConfigId  - Agent config ID used for per-utterance KB search.
 *
 * Events emitted:
 *   'sentence'  (text: string)     — complete sentence ready for TTS
 *   'done'      (fullText: string) — full response committed to history
 *   'error'     (err: Error)
 */
class LLMService extends EventEmitter {
  constructor(systemPrompt, callerContext, ragContext, agentConfigId) {
    super();
    this._systemPrompt   = systemPrompt ||
      'You are a helpful assistant. Answer concisely since your responses will be read aloud.';
    this._callerContext  = callerContext  || '';
    this._ragContext     = ragContext     || '';
    this._agentConfigId  = agentConfigId || null;
    this._utteranceRagContext = ''; // set per-utterance before respond() is called
    /** @type {Array<{role: string, content: string|Array}>} */
    this.conversationHistory = [];
  }

  /**
   * Fetch KB context relevant to the current utterance.
   * Only runs for substantive utterances (>5 words) to avoid overhead on greetings.
   * Emits the hold phrase only if KB results are found, so the caller doesn't hear
   * "Let me check that" before a simple reply that doesn't need KB lookup.
   *
   * @param {string}   utterance
   * @param {AbortSignal} signal
   * @param {Function} onHoldPhrase - async callback to speak a brief hold phrase
   */
  async injectUtteranceContext(utterance, signal) {
    this._utteranceRagContext = '';
    if (!this._agentConfigId || signal?.aborted) return;
    // Skip KB search for short utterances (greetings, yes/no, names, etc.)
    if (utterance.trim().split(/\s+/).length < 6) return;
    try {
      const ctx = await rag.buildContext(utterance, this._agentConfigId, 3);
      if (ctx && !signal?.aborted) {
        this._utteranceRagContext = ctx; // inject silently — no hold phrase
      }
    } catch {
      this._utteranceRagContext = '';
    }
  }

  /**
   * Process a caller utterance: stream Claude's response while supporting
   * tool calls for live database lookups. Emits 'sentence' for each TTS chunk
   * and 'done' when the full response is committed.
   *
   * @param {string} utterance
   * @param {AbortSignal} signal
   */
  async respond(utterance, signal) {
    this.conversationHistory.push({ role: 'user', content: utterance });

    const systemPrompt = [
      this._systemPrompt,
      this._callerContext        ? `\n\n${this._callerContext}`        : '',
      this._ragContext           ? `\n\n${this._ragContext}`           : '',
      this._utteranceRagContext  ? `\n\n${this._utteranceRagContext}`  : '',
      '\n\nIMPORTANT: Keep responses short and conversational (2-4 sentences max). Avoid lists or markdown — speak naturally as this is a phone call.' +
      '\nYou speak English and Spanish only. If the caller speaks Spanish, switch to Spanish immediately and continue the entire call in Spanish. If the caller speaks any other language, politely inform them in English that you can only assist in English or Spanish, and ask which they prefer.' +
      '\nOnly when calling lookup_resident or get_payment_history, say a brief natural hold phrase first (e.g. "Let me pull up your account." or "One moment while I check that."). Do not say a hold phrase for generate_cashpay_code or for anything else.' +
      '\nWhen a caller spells out their name letter by letter (e.g. "J-O-S-E" or "M, A, R, I, A"), reconstruct the full name from those letters and pass it to the lookup tool — do not pass the individual letters.' +
      '\nIf a caller gives their name and the lookup fails, ask them to spell it letter by letter. After they spell it, attempt the lookup again with the reconstructed spelling.' +
      '\nIf a name still cannot be found after spelling confirmation, ask for their unit or lot number as an alternative.' +
      '\nFor payment history questions or disputes, use the get_payment_history tool with the tenant_id from the lookup.' +
      '\nFor cash payments at Walmart or retail stores, use generate_cashpay_code to create a Zego CashPay code — read the code clearly to the caller.' +
      '\nFor auto-pay setup or online account access, provide the resident\'s Tenant ID and the TWA URL from their account record — they register at that URL using their Tenant ID as their account number.',
    ].join('');

    let fullTextResponse = '';

    try {
      // Agentic loop: repeat until Claude stops requesting tool calls (max 5 turns)
      for (let turn = 0; turn < 5; turn++) {
        if (signal?.aborted) break;

        let sentenceBuffer = '';

        const stream = anthropic.messages.stream(
          {
            model:    MODEL,
            max_tokens: 512,
            tools:    TOOLS,
            system:   systemPrompt,
            messages: this.conversationHistory,
          },
          { signal },
        );

        // Stream text to TTS in real-time as tokens arrive
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

        // Wait for the complete response (text + any tool_use blocks)
        const finalMessage = await stream.finalMessage();

        // Flush any trailing text that didn't end with sentence punctuation
        if (sentenceBuffer.trim() && !signal?.aborted) {
          this.emit('sentence', sentenceBuffer.trim());
        }

        // Commit this assistant turn to history
        this.conversationHistory.push({
          role:    'assistant',
          content: finalMessage.content,
        });

        // If no tool calls, we're done
        if (finalMessage.stop_reason !== 'tool_use' || signal?.aborted) {
          if (!signal?.aborted) {
            this.emit('done', fullTextResponse);
          }
          break;
        }

        // Execute every tool call Claude requested
        const toolResults = [];
        for (const block of finalMessage.content) {
          if (block.type !== 'tool_use') continue;
          const result = await executeToolCall(block.name, block.input);
          toolResults.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     result,
          });
        }

        if (signal?.aborted) break;

        // Feed results back so Claude can respond
        this.conversationHistory.push({ role: 'user', content: toolResults });
        // Loop continues → Claude sees the tool results and gives a final answer
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

  /**
   * Non-blocking lead extraction after a turn completes.
   * @param {string} callerNumber
   * @returns {Promise<{name?:string, email?:string, notes:string}|null>}
   */
  async tryExtractLead(callerNumber) {
    if (this.conversationHistory.length < 2) return null;

    const transcript = this.conversationHistory
      .filter((m) => typeof m.content === 'string')
      .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`)
      .join('\n');

    try {
      const response = await anthropic.messages.create({
        model:      MODEL,
        max_tokens: 200,
        system:
          'You are a lead extraction assistant. Given a call transcript, determine if the caller provided contact information or expressed clear interest. Respond with valid JSON only: {"is_lead": true/false, "name": "...", "email": "...", "notes": "..."}. Use null for missing fields. Keep notes under 100 characters.',
        messages: [
          {
            role:    'user',
            content: `Caller phone: ${callerNumber}\n\nTranscript:\n${transcript}`,
          },
        ],
      });

      const raw = response.content[0]?.text?.trim();
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed.is_lead) return null;

      return {
        name:  parsed.name  || null,
        email: parsed.email || null,
        notes: parsed.notes || null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Generate a short AI summary of the call after it ends.
   * @returns {Promise<string|null>}
   */
  async generateSummary() {
    const turns = this.conversationHistory.filter((m) => typeof m.content === 'string');
    if (turns.length < 2) return null;

    const transcript = turns
      .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`)
      .join('\n');

    try {
      const response = await anthropic.messages.create({
        model:      MODEL,
        max_tokens: 250,
        system:     "Summarize this phone call in 2-3 sentences. Cover: the caller's purpose, key information exchanged, and the outcome or next steps. Be factual and concise.",
        messages:   [{ role: 'user', content: transcript }],
      });
      return response.content[0]?.text?.trim() || null;
    } catch {
      return null;
    }
  }

  reset() {
    this.conversationHistory = [];
  }
}

module.exports = LLMService;
