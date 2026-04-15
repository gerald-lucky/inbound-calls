'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { EventEmitter } = require('events');
const parkData = require('./park-data');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Sentence-boundary pattern — flush to TTS at natural speech breaks
const SENTENCE_END = /[.!?]\s+|[.!?]$/;

// ── Tools Claude can call to query the database ───────────────────────────────

const TOOLS = [
  {
    name: 'lookup_resident_account',
    description:
      'Look up a resident\'s account, balance, and payment history by name or lot number. ' +
      'Use this whenever the caller provides their name or lot number and you need their account details.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: {
          type: 'string',
          description: "Resident's first name (optional if lot_number is provided)",
        },
        last_name: {
          type: 'string',
          description: "Resident's last name (optional if lot_number is provided)",
        },
        lot_number: {
          type: 'string',
          description: "Resident's lot number (optional if name is provided)",
        },
      },
    },
  },
];

/**
 * Execute a tool call requested by Claude.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {Promise<string>} Result string to send back to Claude.
 */
async function executeToolCall(toolName, toolInput) {
  if (toolName !== 'lookup_resident_account') {
    return 'Unknown tool.';
  }

  const { first_name, last_name, lot_number } = toolInput;
  console.log(`[llm] lookup_resident_account — name: "${first_name || ''} ${last_name || ''}".trim(), lot: "${lot_number || ''}"`);

  let tenant = null;

  if (lot_number) {
    tenant = await parkData.lookupTenantByLot(lot_number);
  }
  if (!tenant && (first_name || last_name)) {
    tenant = await parkData.lookupTenantByName(first_name, last_name);
  }

  if (!tenant) {
    return 'No resident found with that name or lot number. Ask the caller to spell their name letter by letter so you can try again with the correct spelling.';
  }

  console.log(`[llm] Found resident: ${tenant.first_name} ${tenant.last_name} (lot ${tenant.lot_number})`);
  return parkData.buildAccountContext(tenant);
}

// ── LLMService ────────────────────────────────────────────────────────────────

/**
 * LLMService handles a single conversation with Claude Sonnet 4.6.
 * Supports tool use so Claude can query the residents database by name/lot.
 *
 * @param {string} systemPrompt - Per-agent system prompt (from agent config or env var).
 * @param {string} callerContext - Pre-fetched tenant account info (or "not found" hint).
 *
 * Events emitted:
 *   'sentence'  (text: string)     — complete sentence ready for TTS
 *   'done'      (fullText: string) — full response committed to history
 *   'error'     (err: Error)
 */
class LLMService extends EventEmitter {
  constructor(systemPrompt, callerContext) {
    super();
    this._systemPrompt = systemPrompt ||
      'You are a helpful assistant. Answer concisely since your responses will be read aloud.';
    this._callerContext = callerContext || '';
    /** @type {Array<{role: string, content: string|Array}>} */
    this.conversationHistory = [];
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
      this._callerContext ? `\n\n${this._callerContext}` : '',
      '\n\nIMPORTANT: Keep responses short and conversational (2-4 sentences max). Avoid lists or markdown — speak naturally as this is a phone call.' +
      '\nYou are fully bilingual in English and Spanish. If the caller speaks Spanish, asks if you speak Spanish, or asks you to switch to Spanish, immediately switch to Spanish and continue the entire conversation in Spanish. Confirm with something like "Sí, hablo español con gusto." Stay in Spanish for the rest of the call once switched.' +
      '\nWhenever you are about to call the lookup_resident_account tool, first say a brief phrase out loud such as "Give me just a moment" or "Dame un momento" (if in Spanish) — then call the tool.' +
      '\nIf a caller gives you their name and the account lookup fails, ask them to spell their name letter by letter before trying the lookup again with the corrected spelling.' +
      '\nIf a name sounds ambiguous or unclear from speech, always confirm the spelling before searching.',
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

  reset() {
    this.conversationHistory = [];
  }
}

module.exports = LLMService;
