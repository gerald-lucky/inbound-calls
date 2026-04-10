'use strict';

const TranscriptionService = require('./services/transcription');
const LLMService = require('./services/llm');
const TTSService = require('./services/tts');
const callLogger = require('./services/call-logger');

/**
 * CallSession manages the complete lifecycle of one inbound phone call.
 *
 * Constructor accepts a `meta` object with:
 *   callSid, callerNumber, twilioNumber, agentConfig (or null for env defaults)
 *
 * Data flow:
 *   Twilio WS → TranscriptionService (Scribe STT)
 *   TranscriptionService 'utterance' → LLMService (Claude)
 *   LLMService 'sentence' → TTSService (ElevenLabs TTS)
 *   TTSService 'audio' → Twilio WS
 *
 * After each LLM turn completes, a background lead extraction runs non-blocking.
 */
class CallSession {
  constructor(twilioWs, meta = {}) {
    this._twilioWs    = twilioWs;
    this._streamSid   = null;
    this._startedAt   = new Date();

    // Call metadata (from Twilio webhook, relayed via WS query params)
    this._callSid       = meta.callSid       || null;
    this._callerNumber  = meta.callerNumber  || 'unknown';
    this._twilioNumber  = meta.twilioNumber  || null;
    this._agentConfig   = meta.agentConfig   || null;
    this._callDbId      = null;  // set after DB insert

    // Resolve per-call config values (fall back to env vars)
    const cfg = this._agentConfig;
    this._systemPrompt = cfg?.system_prompt || process.env.AGENT_SYSTEM_PROMPT ||
      'You are a helpful assistant. Answer concisely since your responses will be read aloud.';
    this._greeting     = cfg?.greeting      || process.env.AGENT_GREETING ||
      "Hello! Thanks for calling. How can I help you today?";
    this._voiceId      = cfg?.voice_id      || process.env.ELEVENLABS_VOICE_ID;

    // Services (voice ID injected at construction)
    this._transcription = new TranscriptionService();
    this._llm           = new LLMService(this._systemPrompt);
    this._tts           = new TTSService(this._voiceId);

    this._isSpeaking          = false;
    this._abortController     = null;
    this._processingUtterance = false;
  }

  // ─── Startup ──────────────────────────────────────────────────────────────

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
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.event) {
        case 'connected':
          console.log('[call-session] Twilio connected');
          break;

        case 'start':
          this._streamSid = msg.start.streamSid;
          console.log(`[call-session] Stream started: ${this._streamSid}`);
          // Log call start to DB, then play greeting
          this._logCallStart().then(() => {
            setTimeout(() => this._speak(this._greeting), 500);
          });
          break;

        case 'media':
          if (msg.media?.payload) {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            this._transcription.sendAudio(audioBuffer);
          }
          break;

        case 'stop':
          console.log('[call-session] Call ended (stop event)');
          this._teardown();
          break;

        default:
          break;
      }
    });

    this._twilioWs.on('close', () => {
      console.log('[call-session] Twilio WS closed');
      this._teardown();
    });

    this._twilioWs.on('error', (err) => {
      console.error('[call-session] Twilio WS error:', err.message);
      this._teardown();
    });
  }

  // ─── Transcription ────────────────────────────────────────────────────────

  _wiredTranscription() {
    this._transcription.on('speech_started', () => {
      if (this._isSpeaking) {
        console.log('[call-session] Barge-in — interrupting agent');
        this._interrupt();
      }
    });

    this._transcription.on('utterance', async (text) => {
      if (this._processingUtterance) return;
      // Log caller's turn
      callLogger.appendTranscript(this._callDbId, { role: 'caller', text });
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

  async _handleUtterance(text) {
    console.log(`[call-session] Caller said: "${text}"`);
    this._processingUtterance = true;

    this._abortController = new AbortController();
    const { signal } = this._abortController;

    const onSentence = async (sentence) => {
      if (signal.aborted) return;
      await this._speakSentence(sentence);
    };

    const onDone = (fullResponse) => {
      this._llm.removeListener('sentence', onSentence);
      this._llm.removeListener('done', onDone);
      this._llm.removeListener('error', onError);
      this._processingUtterance = false;
      this._tts.flush();

      // Log agent's response and run background lead extraction
      callLogger.appendTranscript(this._callDbId, { role: 'agent', text: fullResponse });
      this._extractLeadInBackground();
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

  // ─── Barge-in ─────────────────────────────────────────────────────────────

  _interrupt() {
    this._clearTwilioBuffer();
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._tts.abort();
    this._isSpeaking = false;
    this._processingUtterance = false;
  }

  // ─── DB helpers ───────────────────────────────────────────────────────────

  async _logCallStart() {
    this._callDbId = await callLogger.startCall({
      callSid:       this._callSid,
      agentConfigId: this._agentConfig?.id || null,
      twilioNumber:  this._twilioNumber,
      callerNumber:  this._callerNumber,
    });
  }

  /**
   * After each LLM turn, check non-blocking whether a lead should be captured.
   * Runs entirely in the background — does not affect call latency.
   */
  _extractLeadInBackground() {
    if (!this._callDbId) return;
    this._llm.tryExtractLead(this._callerNumber).then((lead) => {
      if (lead) {
        console.log(`[call-session] Lead captured: ${JSON.stringify(lead)}`);
        callLogger.saveLead({
          callId:        this._callDbId,
          agentConfigId: this._agentConfig?.id || null,
          callerNumber:  this._callerNumber,
          name:          lead.name  || null,
          email:         lead.email || null,
          notes:         lead.notes || null,
        });
      }
    }).catch(() => {});
  }

  // ─── Twilio messaging ─────────────────────────────────────────────────────

  _clearTwilioBuffer() {
    if (!this._streamSid) return;
    this._sendToTwilio({ event: 'clear', streamSid: this._streamSid });
  }

  _sendAudioToTwilio(base64Payload) {
    if (!this._streamSid) return;
    this._sendToTwilio({
      event: 'media',
      streamSid: this._streamSid,
      media: { payload: base64Payload },
    });
  }

  _sendToTwilio(msg) {
    if (this._twilioWs.readyState !== 1) return;
    try {
      this._twilioWs.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[call-session] Send error:', err.message);
    }
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────

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

    // Persist call end time
    callLogger.endCall(this._callDbId, this._startedAt);
    console.log('[call-session] Torn down');
  }
}

module.exports = CallSession;
