'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { EventEmitter } = require('events');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Sentence-boundary pattern — flush to TTS at natural speech breaks
const SENTENCE_END = /[.!?]\s+|[.!?]$/;

/**
 * LLMService handles a single conversation with Claude Sonnet 4.6.
 *
 * @param {string} systemPrompt - Per-agent system prompt (from agent config or env var).
 * @param {string} callerContext - Pre-fetched tenant account info injected once at call start.
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
    /** @type {Array<{role: string, content: string}>} */
    this.conversationHistory = [];
  }

  /**
   * Process a caller utterance: inject pre-fetched caller context, stream Claude's response,
   * and emit sentence chunks as they become available.
   *
   * @param {string} utterance
   * @param {AbortSignal} signal
   */
  async respond(utterance, signal) {
    this.conversationHistory.push({ role: 'user', content: utterance });

    const systemPrompt = [
      this._systemPrompt,
      this._callerContext ? `\n\n${this._callerContext}` : '',
      '\n\nIMPORTANT: Keep responses short and conversational (2-4 sentences max). Avoid lists or markdown — speak naturally.',
    ].join('');

    let sentenceBuffer = '';
    let fullResponse = '';

    try {
      const stream = await anthropic.messages.stream(
        {
          model: MODEL,
          max_tokens: 512,
          system: systemPrompt,
          messages: this.conversationHistory,
        },
        { signal },
      );

      for await (const event of stream) {
        if (signal?.aborted) break;

        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta'
        ) {
          const token = event.delta.text;
          sentenceBuffer += token;
          fullResponse += token;

          const match = sentenceBuffer.search(SENTENCE_END);
          if (match !== -1) {
            const sentence = sentenceBuffer.slice(0, match + 1).trim();
            sentenceBuffer = sentenceBuffer.slice(match + 1);
            if (sentence) this.emit('sentence', sentence);
          }
        }
      }

      const remainder = sentenceBuffer.trim();
      if (remainder && !signal?.aborted) {
        this.emit('sentence', remainder);
      }

      if (!signal?.aborted) {
        this.conversationHistory.push({ role: 'assistant', content: fullResponse });
        this.emit('done', fullResponse);
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
   * Non-blocking lead extraction: after a turn completes, ask Claude
   * whether the caller provided contact information worth capturing.
   * Returns null if no lead was detected, or { name, email, notes } if one was.
   *
   * This is intentionally a separate, non-streaming call so it never
   * affects call latency — it runs entirely in the background.
   *
   * @param {string} callerNumber
   * @returns {Promise<{name?:string, email?:string, notes:string}|null>}
   */
  async tryExtractLead(callerNumber) {
    if (this.conversationHistory.length < 2) return null;

    const transcript = this.conversationHistory
      .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`)
      .join('\n');

    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 200,
        system:
          'You are a lead extraction assistant. Given a call transcript, determine if the caller provided contact information or expressed clear interest in a product or service. Respond with valid JSON only: {"is_lead": true/false, "name": "...", "email": "...", "notes": "..."}. Use null for missing fields. Keep notes under 100 characters.',
        messages: [
          {
            role: 'user',
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
      // Lead extraction is best-effort; failures are silent
      return null;
    }
  }

  reset() {
    this.conversationHistory = [];
  }
}

module.exports = LLMService;
