'use strict';

const TranscriptionService = require('./services/transcription');
const LLMService = require('./services/llm');
const TTSService = require('./services/tts');

const GREETING =
  process.env.AGENT_GREETING ||
  "Hello! Thanks for calling. How can I help you today?";

/**
 * CallSession manages the complete lifecycle of one inbound phone call.
 *
 * Data flow:
 *   Twilio WS → TranscriptionService (Scribe STT)
 *   TranscriptionService 'utterance' → LLMService (Claude)
 *   LLMService 'sentence' → TTSService (ElevenLabs TTS)
 *   TTSService 'audio' → Twilio WS
 *
 * Barge-in:
 *   TranscriptionService 'speech_started' while speaking
 *   → clear Twilio buffer, abort Claude stream + TTS
 */
class CallSession {
  constructor(twilioWs) {
    this._twilioWs = twilioWs;
    this._streamSid = null;

    this._transcription = new TranscriptionService();
    this._llm = new LLMService();
    this._tts = new TTSService();

    this._isSpeaking = false;
    this._abortController = null;
    this._processingUtterance = false;
  }

  /**
   * Start the session: wire up event handlers and connect Scribe.
   */
  start() {
    this._wiredTwilio();
    this._wiredTranscription();
    this._wiredTTS();

    // Open Scribe connection eagerly so it's ready when audio arrives
    this._transcription.connect().catch((err) => {
      console.error('[call-session] Failed to connect Scribe:', err.message);
    });
  }

  // ─── Twilio WebSocket ──────────────────────────────────────────────────────

  _wiredTwilio() {
    this._twilioWs.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.event) {
        case 'connected':
          console.log('[call-session] Twilio connected');
          break;

        case 'start':
          this._streamSid = msg.start.streamSid;
          console.log(`[call-session] Stream started: ${this._streamSid}`);
          // Play the greeting after a brief settling delay
          setTimeout(() => this._speak(GREETING), 500);
          break;

        case 'media':
          // msg.media.payload is base64-encoded μ-law 8kHz audio
          if (msg.media && msg.media.payload) {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            this._transcription.sendAudio(audioBuffer);
          }
          break;

        case 'stop':
          console.log('[call-session] Call ended');
          this._teardown();
          break;

        default:
          break;
      }
    });

    this._twilioWs.on('close', () => {
      console.log('[call-session] Twilio WebSocket closed');
      this._teardown();
    });

    this._twilioWs.on('error', (err) => {
      console.error('[call-session] Twilio WS error:', err.message);
      this._teardown();
    });
  }

  // ─── Transcription (STT) events ───────────────────────────────────────────

  _wiredTranscription() {
    this._transcription.on('speech_started', () => {
      if (this._isSpeaking) {
        console.log('[call-session] Barge-in detected — interrupting agent');
        this._interrupt();
      }
    });

    this._transcription.on('utterance', async (text) => {
      if (this._processingUtterance) return; // Discard while still handling previous
      await this._handleUtterance(text);
    });

    this._transcription.on('error', (err) => {
      console.error('[call-session] Transcription error:', err.message);
    });
  }

  // ─── TTS events ───────────────────────────────────────────────────────────

  _wiredTTS() {
    this._tts.on('audio', (base64Payload) => {
      this._sendAudioToTwilio(base64Payload);
    });

    this._tts.on('done', () => {
      this._isSpeaking = false;
      console.log('[call-session] Agent finished speaking');
    });

    this._tts.on('error', (err) => {
      console.error('[call-session] TTS error:', err.message);
      this._isSpeaking = false;
    });
  }

  // ─── Core pipeline ────────────────────────────────────────────────────────

  /**
   * Handle a final, stable utterance from the caller.
   * @param {string} text
   */
  async _handleUtterance(text) {
    console.log(`[call-session] Caller said: "${text}"`);
    this._processingUtterance = true;

    // Create a new AbortController for this response turn
    this._abortController = new AbortController();
    const { signal } = this._abortController;

    // Wire LLM events for this turn
    const onSentence = async (sentence) => {
      if (signal.aborted) return;
      await this._speakSentence(sentence);
    };

    const onDone = () => {
      this._llm.removeListener('sentence', onSentence);
      this._llm.removeListener('done', onDone);
      this._llm.removeListener('error', onError);
      this._processingUtterance = false;
      // Flush TTS to ensure all buffered audio is sent
      this._tts.flush();
    };

    const onError = (err) => {
      console.error('[call-session] LLM error:', err.message);
      this._llm.removeListener('sentence', onSentence);
      this._llm.removeListener('done', onDone);
      this._llm.removeListener('error', onError);
      this._processingUtterance = false;
    };

    this._llm.on('sentence', onSentence);
    this._llm.on('done', onDone);
    this._llm.on('error', onError);

    await this._llm.respond(text, signal);
  }

  /**
   * Speak a full response string (used for the greeting).
   * Opens a fresh TTS connection, sends text, then flushes.
   * @param {string} text
   */
  async _speak(text) {
    if (!text) return;
    try {
      await this._tts.connect();
      this._isSpeaking = true;
      this._tts.sendText(text);
      this._tts.flush();
    } catch (err) {
      console.error('[call-session] Speak error:', err.message);
      this._isSpeaking = false;
    }
  }

  /**
   * Speak a single sentence chunk emitted by the LLM.
   * Connects a new TTS session on the first sentence of each turn.
   * @param {string} sentence
   */
  async _speakSentence(sentence) {
    if (!sentence.trim()) return;
    try {
      if (!this._tts.speaking) {
        await this._tts.connect();
        this._isSpeaking = true;
      }
      this._tts.sendText(sentence);
    } catch (err) {
      console.error('[call-session] speakSentence error:', err.message);
    }
  }

  /**
   * Interrupt the currently playing TTS response (barge-in).
   */
  _interrupt() {
    // 1. Clear Twilio's audio buffer so playback stops immediately
    this._clearTwilioBuffer();

    // 2. Abort the in-flight Claude stream
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // 3. Abort TTS WebSocket
    this._tts.abort();

    this._isSpeaking = false;
    this._processingUtterance = false;
  }

  /**
   * Send a Twilio 'clear' event to stop buffered audio playback.
   */
  _clearTwilioBuffer() {
    if (!this._streamSid) return;
    const msg = { event: 'clear', streamSid: this._streamSid };
    this._sendToTwilio(msg);
  }

  /**
   * Send an audio chunk to Twilio as a 'media' event.
   * @param {string} base64Payload - Base64-encoded μ-law 8kHz audio.
   */
  _sendAudioToTwilio(base64Payload) {
    if (!this._streamSid) return;
    const msg = {
      event: 'media',
      streamSid: this._streamSid,
      media: { payload: base64Payload },
    };
    this._sendToTwilio(msg);
  }

  /**
   * Send any JSON message to Twilio via the WebSocket.
   * @param {object} msg
   */
  _sendToTwilio(msg) {
    if (this._twilioWs.readyState !== 1 /* OPEN */) return;
    try {
      this._twilioWs.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[call-session] Failed to send to Twilio:', err.message);
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  _teardown() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._transcription.close();
    this._tts.abort();
    this._llm.reset();
    this._isSpeaking = false;
    this._processingUtterance = false;
    console.log('[call-session] Session torn down');
  }
}

module.exports = CallSession;
