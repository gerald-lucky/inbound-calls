'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { EventEmitter } = require('events');
const knowledgeBase = require('./knowledge-base');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Sentence-boundary pattern — flush to TTS at natural speech breaks
const SENTENCE_END = /[.!?]\s+|[.!?]$/;

/**
 * LLMService handles a single conversation with Claude Sonnet 4.6.
 *
 * Events emitted:
 *   'sentence'  (text: string)   — a complete sentence ready for TTS
 *   'done'      (fullText: string) — full response text, conversation updated
 *   'error'     (err: Error)
 */
class LLMService extends EventEmitter {
  constructor() {
    super();
    /** @type {Array<{role: string, content: string}>} */
    this.conversationHistory = [];
  }

  /**
   * Process a caller utterance: retrieve context, stream Claude's response,
   * and emit sentence chunks as they become available.
   *
   * @param {string} utterance - The caller's transcribed speech.
   * @param {AbortSignal} signal - AbortSignal to cancel mid-stream (barge-in).
   */
  async respond(utterance, signal) {
    // Add the user turn to history
    this.conversationHistory.push({ role: 'user', content: utterance });

    // Retrieve relevant knowledge base context
    const context = await knowledgeBase.search(utterance);

    const systemPrompt = [
      process.env.AGENT_SYSTEM_PROMPT ||
        'You are a helpful assistant. Answer concisely since your responses will be read aloud.',
      context
        ? `\n\nRelevant knowledge base information:\n${context}`
        : '',
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

          // Flush complete sentences to TTS immediately for low latency
          const match = sentenceBuffer.search(SENTENCE_END);
          if (match !== -1) {
            const sentence = sentenceBuffer.slice(0, match + 1).trim();
            sentenceBuffer = sentenceBuffer.slice(match + 1);
            if (sentence) {
              this.emit('sentence', sentence);
            }
          }
        }
      }

      // Flush any remaining text as a final sentence
      const remainder = sentenceBuffer.trim();
      if (remainder && !signal?.aborted) {
        this.emit('sentence', remainder);
      }

      if (!signal?.aborted) {
        // Add assistant turn to history
        this.conversationHistory.push({
          role: 'assistant',
          content: fullResponse,
        });
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
   * Reset conversation history (e.g. after hang-up).
   */
  reset() {
    this.conversationHistory = [];
  }
}

module.exports = LLMService;
