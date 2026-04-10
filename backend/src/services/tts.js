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
  constructor() {
    super();
    this._ws = null;
    this._voiceId = process.env.ELEVENLABS_VOICE_ID;
    this._speaking = false;
  }

  get speaking() {
    return this._speaking;
  }

  /**
   * Open a fresh TTS WebSocket for one response turn.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(TTS_URL(this._voiceId), {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      });

      ws.on('open', () => {
        // Send voice configuration as the first message
        const initMsg = {
          text: ' ',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            use_speaker_boost: false,
          },
          generation_config: {
            chunk_length_schedule: [50, 90, 120, 150],
          },
          xi_api_key: process.env.ELEVENLABS_API_KEY,
        };
        ws.send(JSON.stringify(initMsg));
        this._speaking = true;
        console.log('[tts] ElevenLabs TTS WebSocket open');
        resolve();
      });

      ws.on('message', (data) => {
        // ElevenLabs sends either binary audio frames or JSON status messages
        if (data instanceof Buffer) {
          // Raw binary → base64 for Twilio
          const payload = data.toString('base64');
          this.emit('audio', payload);
        } else {
          let msg;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }

          if (msg.audio) {
            // Some ElevenLabs versions send base64 in JSON
            this.emit('audio', msg.audio);
          }

          if (msg.isFinal) {
            this._speaking = false;
            this._ws = null;
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
        this._speaking = false;
        this.emit('error', err);
        reject(err);
      });

      ws.on('close', () => {
        console.log('[tts] ElevenLabs TTS WebSocket closed');
        this._speaking = false;
        this._ws = null;
      });

      this._ws = ws;
    });
  }

  /**
   * Send a sentence of text to ElevenLabs for synthesis.
   * Call connect() before the first sendText() of each turn.
   * @param {string} text
   */
  sendText(text) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      console.warn('[tts] sendText called but WebSocket is not open');
      return;
    }
    const msg = { text: text + ' ', flush: false };
    this._ws.send(JSON.stringify(msg));
  }

  /**
   * Signal end-of-input to ElevenLabs — triggers final audio flush.
   * ElevenLabs will close the connection after sending remaining audio.
   */
  flush() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const msg = { text: '', flush: true };
    this._ws.send(JSON.stringify(msg));
  }

  /**
   * Abort the current TTS turn immediately (barge-in support).
   * The caller is responsible for sending a 'clear' message to Twilio.
   */
  abort() {
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
    this._speaking = false;
  }
}

module.exports = TTSService;
