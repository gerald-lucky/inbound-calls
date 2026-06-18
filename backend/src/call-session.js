'use strict';

const TranscriptionService = require('./services/transcription');
const LLMService           = require('./services/llm');
const TTSService           = require('./services/tts');
const callLogger           = require('./services/call-logger');
const parkData             = require('./services/park-data');
const agentConfigs         = require('./services/agent-configs');

/**
 * CallSession manages the complete lifecycle of one inbound phone call.
 *
 * Metadata (caller number, agent config, etc.) is read from Twilio's
 * `start` event customParameters — no query string needed on the WS URL.
 *
 * Data flow:
 *   Twilio WS → TranscriptionService (Scribe STT)
 *   TranscriptionService 'utterance' → LLMService (Claude)
 *   LLMService 'sentence' → TTSService (ElevenLabs TTS)
 *   TTSService 'audio' → Twilio WS
 */
class CallSession {
  constructor(twilioWs) {
    this._twilioWs   = twilioWs;
    this._streamSid  = null;
    this._startedAt  = new Date();

    // Populated from Twilio's `start` event customParameters
    this._callSid      = null;
    this._callerNumber = 'unknown';
    this._twilioNumber = null;
    this._agentConfig  = null;
    this._callDbId     = null;

    // Resolved in _initCall once we have the agentConfig
    this._systemPrompt = null;
    this._greeting     = null;
    this._voiceId      = null;

    this._transcription        = new TranscriptionService();
    this._llm                  = null;
    this._tts                  = null;
    this._isSpeaking           = false;
    this._abortController      = null;
    this._processingUtterance  = false;
  }

  // ─── Startup ──────────────────────────────────────────────────────────────

  start() {
    this._wiredTwilio();
    this._wiredTranscription(); // register error handler before connect() to avoid crash

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

        case 'start': {
          this._streamSid = msg.start.streamSid;
          console.log(`[call-session] Stream started: ${this._streamSid}`);

          // Read metadata from Twilio custom parameters
          const cp = msg.start.customParameters || {};
          this._callSid      = cp.callSid      || msg.start.callSid || null;
          this._callerNumber = cp.callerNumber || 'unknown';
          this._twilioNumber = cp.twilioNumber || null;
          const configId     = cp.configId     || null;

          this._initCall(configId).then(() => {
            this._wiredTTS();
            setTimeout(() => this._speak(this._greeting), 500);
          }).catch((err) => {
            console.error('[call-session] _initCall failed:', err.message);
          });
          break;
        }

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
      console.log(`[call-session] Forwarding audio to Twilio — streamSid: ${this._streamSid}, wsState: ${this._twilioWs.readyState}, bytes: ${Math.round(base64Payload.length * 0.75)}`);
      this._sendAudioToTwilio(base64Payload);
    });

    this._tts.on('done', () => {
      this._isSpeaking = false;
      this._transcription.setAgentSpeaking(false);
      console.log('[call-session] Agent finished speaking');
    });

    this._tts.on('error', (err) => {
      console.error('[call-session] TTS error:', err.message);
      this._isSpeaking = false;
      this._transcription.setAgentSpeaking(false);
    });
  }

  // ─── Core pipeline ────────────────────────────────────────────────────────

  async _handleUtterance(text) {
    if (!this._llm) return;
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
      this._transcription.setAgentSpeaking(true);
      this._tts.sendText(text);
      this._tts.flush();
    } catch (err) {
      console.error('[call-session] Speak error:', err.message);
      this._isSpeaking = false;
      this._transcription.setAgentSpeaking(false);
    }
  }

  async _speakSentence(sentence) {
    if (!sentence.trim()) return;
    try {
      if (!this._tts.speaking) {
        // Clear any audio Twilio has buffered from the previous turn before
        // sending new audio — prevents old and new responses from overlapping.
        this._clearTwilioBuffer();
        await this._tts.connect();
        this._isSpeaking = true;
        this._transcription.setAgentSpeaking(true);
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

  // ─── Initialisation (runs after start event) ───────────────────────────────

  async _initCall(configId) {
    // Look up agent config
    if (configId) {
      try {
        this._agentConfig = await agentConfigs.getById(configId);
      } catch (err) {
        console.error('[call-session] Agent config lookup failed:', err.message);
      }
    }

    // Resolve per-call values (fall back to env vars)
    const cfg = this._agentConfig;
    this._systemPrompt = cfg?.system_prompt || process.env.AGENT_SYSTEM_PROMPT ||
      'You are a helpful assistant. Answer concisely since your responses will be read aloud.';
    this._greeting = cfg?.greeting || process.env.AGENT_GREETING ||
      'Hello! Thanks for calling. How can I help you today?';
    this._voiceId = cfg?.voice_id || process.env.ELEVENLABS_VOICE_ID;

    // Create TTS now that we have the voice ID
    this._tts = new TTSService(this._voiceId);

    console.log(`[call-session] Init — caller: ${this._callerNumber}, agent: ${cfg?.name || 'default'}`);

    // Log call start + fetch caller context in parallel
    const [, callerContext] = await Promise.all([
      callLogger.startCall({
        callSid:       this._callSid,
        agentConfigId: this._agentConfig?.id || null,
        twilioNumber:  this._twilioNumber,
        callerNumber:  this._callerNumber,
      }).then((id) => { this._callDbId = id; }),
      parkData.buildCallerContext(this._callerNumber),
    ]);

    this._llm = new LLMService(this._systemPrompt, callerContext);
  }

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
    if (this._tts) this._tts.abort();
    if (this._llm) this._llm.reset();
    this._isSpeaking = false;
    this._processingUtterance = false;
    callLogger.endCall(this._callDbId, this._startedAt);
    console.log('[call-session] Torn down');
  }
}

module.exports = CallSession;
