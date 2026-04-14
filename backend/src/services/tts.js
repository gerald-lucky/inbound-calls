'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');

// ElevenLabs TTS streaming WebSocket — ulaw_8000 output matches Twilio's format
const TTS_URL = (voiceId) =>
  `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
  `?output_format=ulaw_8000&optimize_streaming_latency=4`;

/**
 * TTSService streams text to ElevenLabs TTS and emits audio chunks in the
 * format Twilio Media Streams expects (base64-encoded μ-law 8kHz).
 *
 * Events emitted:
 *   'audio'  (base64Payload: string) — one audio chunk, ready to send to Twilio
 *   'done'   ()                      — ElevenLabs finished speaking this turn
 *   'error'  (err: Error)
 */
class TTSService extends EventEmitter {
  /**
   * @param {string} [voiceId] - ElevenLabs voice ID. Defaults to ELEVENLABS_VOICE_ID env var.
   */
  constructor(voiceId) {
    super();
    this._ws             = null;
    this._voiceId        = voiceId || (process.env.ELEVENLABS_VOICE_ID || '').trim();
    this._speaking       = false;
    this._connectPromise = null; // deduplicate concurrent connect() calls
  }

  get speaking() {
    return this._speaking;
  }

  /**
   * Open a TTS WebSocket for one response turn.
   * If a connection attempt is already in progress, the same Promise is
   * returned so concurrent _speakSentence calls share one socket.
   * @returns {Promise<void>}
   */
  connect() {
    // Already open — reuse
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    // Already connecting — share the in-flight promise
    if (this._connectPromise) {
      return this._connectPromise;
    }

    const apiKey = (process.env.ELEVENLABS_API_KEY || '').trim();

    this._connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(TTS_URL(this._voiceId), {
        headers: { 'xi-api-key': apiKey },
      });

      ws.on('open', () => {
        this._ws             = ws;
        this._connectPromise = null;
        this._speaking       = true;

        // Send voice configuration as the first message
        ws.send(JSON.stringify({
          text: ' ',
          voice_settings: {
            stability:        0.5,
            similarity_boost: 0.8,
            use_speaker_boost: false,
          },
          generation_config: {
            chunk_length_schedule: [50, 90, 120, 150],
          },
          xi_api_key: apiKey,
        }));

        console.log('[tts] ElevenLabs TTS WebSocket open');
        resolve();
      });

      ws.on('message', (data) => {
        if (data instanceof Buffer) {
          this.emit('audio', data.toString('base64'));
        } else {
          let msg;
          try { msg = JSON.parse(data.toString()); } catch { return; }

          if (msg.audio) this.emit('audio', msg.audio);

          if (msg.isFinal) {
            this._speaking = false;
            this._ws       = null;
            this.emit('done');
          }

          if (msg.error) {
            console.error('[tts] ElevenLabs error:', msg.message || msg.error);
            this.emit('error', new Error(msg.message || msg.error));
          }
        }
      });

      ws.on('error', (err) => {
        console.error('[tts] WebSocket error:', err.message);
        this._connectPromise = null;
        this._speaking       = false;
        this._ws             = null;
        this.emit('error', err);
        reject(err);
      });

      ws.on('close', () => {
        console.log('[tts] ElevenLabs TTS WebSocket closed');
        this._speaking = false;
        if (this._ws === ws) this._ws = null;
      });
    });

    return this._connectPromise;
  }

  /**
   * Send a sentence of text to ElevenLabs for synthesis.
   * @param {string} text
   */
  sendText(text) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      console.warn('[tts] sendText called but WebSocket is not open');
      return;
    }
    this._ws.send(JSON.stringify({ text: text + ' ', flush: false }));
  }

  /**
   * Signal end-of-input to ElevenLabs — triggers final audio flush.
   */
  flush() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ text: '', flush: true }));
  }

  /**
   * Abort the current TTS turn immediately (barge-in support).
   */
  abort() {
    this._connectPromise = null;
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
    this._speaking = false;
  }
}

module.exports = TTSService;
