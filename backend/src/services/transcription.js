'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');

// ElevenLabs Scribe v2 Realtime STT WebSocket endpoint
const SCRIBE_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/stream';

/**
 * TranscriptionService wraps an ElevenLabs Scribe v2 Realtime WebSocket.
 *
 * Events emitted:
 *   'utterance'      (text: string)  — final, stable transcript for a turn
 *   'speech_started' ()              — caller started speaking (for barge-in)
 *   'error'          (err: Error)
 *   'close'          ()
 */
class TranscriptionService extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._connected = false;
    this._pendingAudio = []; // Buffer audio received before WS opens
  }

  /**
   * Open the Scribe WebSocket.
   * @returns {Promise<void>} Resolves when the connection is open.
   */
  connect() {
    return new Promise((resolve, reject) => {
      const url = `${SCRIBE_URL}?xi-api-key=${process.env.ELEVENLABS_API_KEY}`;
      const ws = new WebSocket(url, {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      });

      ws.on('open', () => {
        console.log('[transcription] Scribe WebSocket open');
        this._connected = true;

        // Send a configuration message to set audio format
        const config = {
          type: 'config',
          config: {
            encoding: 'ulaw',
            sample_rate: 8000,
            language_code: 'en',
          },
        };
        ws.send(JSON.stringify(config));

        // Flush any audio that arrived before the connection opened
        for (const chunk of this._pendingAudio) {
          ws.send(chunk);
        }
        this._pendingAudio = [];
        resolve();
      });

      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        switch (msg.type) {
          case 'speech_started':
            this.emit('speech_started');
            break;

          case 'transcript':
            if (msg.is_final && msg.text && msg.text.trim()) {
              console.log(`[transcription] Final transcript: "${msg.text.trim()}"`);
              this.emit('utterance', msg.text.trim());
            }
            break;

          case 'error':
            console.error('[transcription] Scribe error:', msg.message);
            this.emit('error', new Error(msg.message));
            break;

          default:
            break;
        }
      });

      ws.on('error', (err) => {
        console.error('[transcription] WebSocket error:', err.message);
        this.emit('error', err);
        reject(err);
      });

      ws.on('close', () => {
        console.log('[transcription] Scribe WebSocket closed');
        this._connected = false;
        this.emit('close');
      });

      this._ws = ws;
    });
  }

  /**
   * Send a raw audio chunk (Buffer of μ-law 8kHz bytes) to Scribe.
   * @param {Buffer} audioBuffer
   */
  sendAudio(audioBuffer) {
    if (!this._ws) return;
    if (!this._connected) {
      this._pendingAudio.push(audioBuffer);
      return;
    }
    if (this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(audioBuffer);
    }
  }

  /**
   * Gracefully close the Scribe connection.
   */
  close() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.close();
    }
    this._ws = null;
    this._connected = false;
    this._pendingAudio = [];
  }
}

module.exports = TranscriptionService;
