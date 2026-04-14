'use strict';

const { EventEmitter } = require('events');

const SCRIBE_URL        = 'https://api.elevenlabs.io/v1/speech-to-text';
const SAMPLE_RATE       = 8000;
const SILENCE_MS        = 1000;                  // flush after 1 s of silence
const MIN_SPEECH_BYTES  = SAMPLE_RATE * 0.3;    // ignore clips shorter than 300 ms
const SILENCE_RMS_THRESHOLD = 500;              // out of ~32 k max

// ─── µ-law helpers ────────────────────────────────────────────────────────────

function mulawToLinear(byte) {
  const u = (~byte) & 0xFF;
  const t = (((u & 0x0F) << 3) + 0x84) << ((u & 0x70) >> 4);
  return (u & 0x80) ? (0x84 - t) : (t - 0x84);
}

function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const s = mulawToLinear(buffer[i]);
    sum += s * s;
  }
  return Math.sqrt(sum / buffer.length);
}

function mulawToWav(mulawBuf) {
  // Decode µ-law → 16-bit signed PCM
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(mulawToLinear(mulawBuf[i]), i * 2);
  }
  // Standard 44-byte WAV header for 8 kHz 16-bit mono PCM
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);          // fmt chunk size
  hdr.writeUInt16LE(1, 20);           // PCM = 1
  hdr.writeUInt16LE(1, 22);           // mono
  hdr.writeUInt32LE(8000, 24);        // sample rate
  hdr.writeUInt32LE(16000, 28);       // byte rate (8000 × 2)
  hdr.writeUInt16LE(2, 32);           // block align
  hdr.writeUInt16LE(16, 34);          // bits/sample
  hdr.write('data', 36);
  hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

// ─── TranscriptionService ─────────────────────────────────────────────────────

/**
 * Batch-mode STT using ElevenLabs Scribe v2.
 *
 * Instead of a persistent WebSocket, this buffers incoming µ-law audio,
 * detects utterance boundaries via a 1-second silence timeout, converts the
 * buffer to a 16-bit PCM WAV, and POSTs it to the ElevenLabs batch API.
 *
 * Events emitted (same interface as the old real-time version):
 *   'utterance'      (text: string)
 *   'speech_started' ()
 *   'error'          (err: Error)
 */
class TranscriptionService extends EventEmitter {
  constructor() {
    super();
    this._chunks       = [];
    this._silenceTimer = null;
    this._speaking     = false;
    this._connected    = false;
  }

  /**
   * Batch mode requires no persistent connection — resolves immediately.
   */
  connect() {
    this._connected = true;
    console.log('[transcription] Batch STT ready (ElevenLabs Scribe v2)');
    return Promise.resolve();
  }

  /**
   * Receive a raw µ-law audio chunk from Twilio.
   * @param {Buffer} buffer
   */
  sendAudio(buffer) {
    if (!this._connected) return;

    const silent = rms(buffer) < SILENCE_RMS_THRESHOLD;

    if (!silent) {
      if (!this._speaking) {
        this._speaking = true;
        this.emit('speech_started');
      }
      this._chunks.push(buffer);
      this._resetSilenceTimer();
    } else if (this._speaking) {
      // Keep accumulating during brief pauses so we don't clip word endings
      this._chunks.push(buffer);
    }
  }

  _resetSilenceTimer() {
    clearTimeout(this._silenceTimer);
    this._silenceTimer = setTimeout(() => this._flush(), SILENCE_MS);
  }

  async _flush() {
    if (!this._speaking || this._chunks.length === 0) return;

    const raw = Buffer.concat(this._chunks);
    this._chunks  = [];
    this._speaking = false;

    if (raw.length < MIN_SPEECH_BYTES) return; // too short — likely noise

    const apiKey = (process.env.ELEVENLABS_API_KEY || '').trim();

    try {
      const wav  = mulawToWav(raw);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
      form.append('model_id', 'scribe_v2');
      form.append('language_code', 'en');

      const res = await fetch(SCRIBE_URL, {
        method:  'POST',
        headers: { 'xi-api-key': apiKey },
        body:    form,
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(`[transcription] Scribe batch error ${res.status}: ${body}`);
        this.emit('error', new Error(`Scribe ${res.status}`));
        return;
      }

      const json = await res.json();
      const text = (json.text || '').trim();
      if (text) {
        console.log(`[transcription] Final transcript: "${text}"`);
        this.emit('utterance', text);
      }
    } catch (err) {
      console.error('[transcription] Batch transcription failed:', err.message);
      this.emit('error', err);
    }
  }

  close() {
    clearTimeout(this._silenceTimer);
    this._chunks   = [];
    this._speaking = false;
    this._connected = false;
  }
}

module.exports = TranscriptionService;
