/**
 * SessionManager - Gestiona las conexiones WebSocket con OpenAI Realtime API
 * 
 * Cada "sesión" es una conversación continua con OpenAI.
 * N8N puede enviar múltiples mensajes a la misma sesión para mantener contexto.
 * 
 * Flujo:
 * 1. N8N crea sesión → se abre WebSocket con OpenAI → retorna session_id
 * 2. N8N envía mensaje (texto o audio) → se manda a OpenAI via WS → se espera respuesta
 * 3. N8N puede cerrar la sesión o dejarla expirar por inactividad
 */

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { log } from './utils/logger.js';

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime';

export class SessionManager {
  constructor(config = {}) {
    this.sessions = new Map(); // session_id → SessionState
    this.config = {
      model: config.model || process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-mini-realtime-preview',
      defaultVoice: config.defaultVoice || process.env.OPENAI_VOICE || 'alloy',
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      responseTimeoutMs: parseInt(config.responseTimeoutMs || process.env.RESPONSE_TIMEOUT_MS || '30000'),
      sessionMaxIdleMs: parseInt(config.sessionMaxIdleMs || process.env.SESSION_MAX_IDLE_MS || '300000'),
      defaultInstructions: config.defaultInstructions || process.env.DEFAULT_INSTRUCTIONS || 'Eres un asistente útil.',
      maxSessions: parseInt(config.maxSessions || process.env.MAX_SESSIONS || '0'),
    };

    // Limpieza periódica de sesiones inactivas
    this._cleanupInterval = setInterval(() => this._cleanupIdleSessions(), 60000);
    log.info('[SessionManager] Inicializado', { model: this.config.model });
  }

  /**
   * Crea una nueva sesión conversacional con OpenAI
   * @param {Object} options - Opciones de la sesión
   * @param {string} options.instructions - Instrucciones del sistema (personalidad del asistente)
   * @param {string} options.voice - Voz del asistente
   * @param {string} options.sessionId - ID de sesión personalizado (opcional)
   * @param {Object} options.metadata - Metadata adicional (ej: usuario, canal)
   * @returns {Promise<{session_id, status, model, voice, created_at}>}
   */
  async createSession(options = {}) {
    if (this.config.maxSessions > 0 && this.sessions.size >= this.config.maxSessions) {
      throw new Error(`Límite de sesiones alcanzado (${this.config.maxSessions})`);
    }

    const sessionId = options.sessionId || uuidv4();
    const voice = options.voice || this.config.defaultVoice;
    const instructions = options.instructions || this.config.defaultInstructions;

    log.info(`[Session ${sessionId}] Creando sesión...`);

    return new Promise((resolve, reject) => {
      const wsUrl = `${OPENAI_WS_URL}?model=${this.config.model}`;
      const ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      const sessionState = {
        id: sessionId,
        ws,
        status: 'connecting',
        instructions,
        voice,
        model: this.config.model,
        metadata: options.metadata || {},
        createdAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        conversationHistory: [],
        pendingResponses: new Map(), // request_id → {resolve, reject, timeout, buffer}
      };

      this.sessions.set(sessionId, sessionState);

      const connectTimeout = setTimeout(() => {
        ws.terminate();
        this.sessions.delete(sessionId);
        reject(new Error('Timeout al conectar con OpenAI Realtime API'));
      }, 15000);

      ws.on('open', () => {
        clearTimeout(connectTimeout);
        log.info(`[Session ${sessionId}] WebSocket conectado`);
        sessionState.status = 'connected';

        // Configurar la sesión con las instrucciones y parámetros
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: instructions,
            voice: voice,
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
              model: 'whisper-1',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        }));

        resolve({
          session_id: sessionId,
          status: 'ready',
          model: this.config.model,
          voice: voice,
          instructions_preview: instructions.substring(0, 100) + (instructions.length > 100 ? '...' : ''),
          created_at: sessionState.createdAt,
        });
      });

      ws.on('message', (rawData) => {
        try {
          const event = JSON.parse(rawData.toString());
          this._handleOpenAIEvent(sessionState, event);
        } catch (err) {
          log.error(`[Session ${sessionId}] Error parseando evento`, err.message);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        log.error(`[Session ${sessionId}] Error WebSocket:`, err.message);
        sessionState.status = 'error';
        this._rejectAllPending(sessionState, err);
        if (sessionState.status === 'connecting') {
          this.sessions.delete(sessionId);
          reject(err);
        }
      });

      ws.on('close', (code, reason) => {
        log.info(`[Session ${sessionId}] WebSocket cerrado (${code}): ${reason}`);
        sessionState.status = 'closed';
        const closeErr = new Error(`Sesión cerrada (código: ${code})`);
        this._rejectAllPending(sessionState, closeErr);
        this.sessions.delete(sessionId);
      });
    });
  }

  /**
   * Envía un mensaje de texto a la sesión y espera la respuesta completa
   * @param {string} sessionId
   * @param {string} text - Mensaje del usuario
   * @param {Object} options
   * @param {boolean} options.returnAudio - Si true, incluye audio en la respuesta
   * @returns {Promise<{response_text, audio_base64, duration_ms, tokens}>}
   */
  async sendText(sessionId, text, options = {}) {
    const session = this._getSession(sessionId);
    session.lastActivityAt = Date.now();

    const requestId = uuidv4();
    log.info(`[Session ${sessionId}] Enviando texto [req:${requestId.slice(0,8)}]: "${text.substring(0,60)}..."`);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const responseBuffer = {
        textDelta: '',
        audioDelta: [],  // chunks de audio base64
        inputTranscript: text,
        eventId: null,
        itemId: null,
      };

      const timeout = setTimeout(() => {
        session.pendingResponses.delete(requestId);
        reject(new Error(`Timeout esperando respuesta de OpenAI (${this.config.responseTimeoutMs}ms)`));
      }, this.config.responseTimeoutMs);

      session.pendingResponses.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          const durationMs = Date.now() - startTime;

          // Guardar en historial
          session.conversationHistory.push({
            role: 'user',
            content: text,
            timestamp: new Date().toISOString(),
          });
          session.conversationHistory.push({
            role: 'assistant',
            content: data.textDelta,
            timestamp: new Date().toISOString(),
            has_audio: data.audioDelta.length > 0,
          });

          const result = {
            response_text: data.textDelta,
            duration_ms: durationMs,
            session_id: sessionId,
            request_id: requestId,
          };

          if (options.returnAudio && data.audioDelta.length > 0) {
            result.audio_base64 = data.audioDelta.join('');
            result.audio_format = 'pcm16';
            result.audio_sample_rate = 24000;
          }

          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        buffer: responseBuffer,
        returnAudio: options.returnAudio || false,
      });

      // 1. Agregar el mensaje del usuario a la conversación
      session.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: text,
          }],
        },
        event_id: `msg_${requestId}`,
      }));

      // 2. Solicitar que genere una respuesta
      session.ws.send(JSON.stringify({
        type: 'response.create',
        event_id: `res_${requestId}`,
        response: {
          modalities: options.returnAudio ? ['text', 'audio'] : ['text'],
        },
      }));
    });
  }

  /**
   * Envía audio (PCM16 base64) y espera la respuesta
   * @param {string} sessionId
   * @param {string} audioBase64 - Audio en formato PCM16 codificado en base64
   * @param {Object} options
   * @param {boolean} options.returnAudio - Si incluir audio en la respuesta
   * @returns {Promise<{response_text, input_transcript, audio_base64, duration_ms}>}
   */
  async sendAudio(sessionId, audioBase64, options = {}) {
    const session = this._getSession(sessionId);
    session.lastActivityAt = Date.now();

    const requestId = uuidv4();
    log.info(`[Session ${sessionId}] Enviando audio [req:${requestId.slice(0,8)}]`);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const responseBuffer = {
        textDelta: '',
        audioDelta: [],
        inputTranscript: '',
        eventId: null,
        itemId: null,
      };

      const timeout = setTimeout(() => {
        session.pendingResponses.delete(requestId);
        reject(new Error(`Timeout esperando respuesta de OpenAI (${this.config.responseTimeoutMs}ms)`));
      }, this.config.responseTimeoutMs);

      session.pendingResponses.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          const durationMs = Date.now() - startTime;

          session.conversationHistory.push({
            role: 'user',
            content: data.inputTranscript || '[audio]',
            content_type: 'audio',
            timestamp: new Date().toISOString(),
          });
          session.conversationHistory.push({
            role: 'assistant',
            content: data.textDelta,
            timestamp: new Date().toISOString(),
            has_audio: data.audioDelta.length > 0,
          });

          const result = {
            response_text: data.textDelta,
            input_transcript: data.inputTranscript,
            duration_ms: durationMs,
            session_id: sessionId,
            request_id: requestId,
          };

          if (options.returnAudio !== false && data.audioDelta.length > 0) {
            result.audio_base64 = data.audioDelta.join('');
            result.audio_format = 'pcm16';
            result.audio_sample_rate = 24000;
          }

          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        buffer: responseBuffer,
        returnAudio: options.returnAudio !== false,
        isAudioInput: true,
      });

      // Limpiar el buffer de audio primero
      session.ws.send(JSON.stringify({
        type: 'input_audio_buffer.clear',
      }));

      // Enviar el audio en chunks (máximo ~15KB por mensaje)
      const CHUNK_SIZE = 15000;
      for (let i = 0; i < audioBase64.length; i += CHUNK_SIZE) {
        session.ws.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: audioBase64.slice(i, i + CHUNK_SIZE),
        }));
      }

      // Confirmar que terminamos de enviar el audio
      session.ws.send(JSON.stringify({
        type: 'input_audio_buffer.commit',
        event_id: `audio_${requestId}`,
      }));

      // Solicitar respuesta
      session.ws.send(JSON.stringify({
        type: 'response.create',
        event_id: `res_${requestId}`,
        response: {
          modalities: options.returnAudio !== false ? ['text', 'audio'] : ['text'],
        },
      }));
    });
  }

  /**
   * Actualiza las instrucciones de la sesión en curso
   * @param {string} sessionId
   * @param {string} instructions - Nuevas instrucciones del sistema
   */
  async updateInstructions(sessionId, instructions) {
    const session = this._getSession(sessionId);
    session.instructions = instructions;
    session.lastActivityAt = Date.now();

    session.ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: instructions,
      },
    }));

    log.info(`[Session ${sessionId}] Instrucciones actualizadas`);
    return { success: true, session_id: sessionId };
  }

  /**
   * Obtiene información y estado de una sesión
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      session_id: session.id,
      status: session.status,
      model: session.model,
      voice: session.voice,
      created_at: session.createdAt,
      last_activity_at: new Date(session.lastActivityAt).toISOString(),
      message_count: session.conversationHistory.length,
      instructions_preview: session.instructions.substring(0, 100) + (session.instructions.length > 100 ? '...' : ''),
      metadata: session.metadata,
    };
  }

  /**
   * Obtiene el historial de conversación de una sesión
   */
  getHistory(sessionId) {
    const session = this._getSession(sessionId);
    return {
      session_id: sessionId,
      messages: session.conversationHistory,
      total: session.conversationHistory.length,
    };
  }

  /**
   * Lista todas las sesiones activas
   */
  listSessions() {
    const sessions = [];
    for (const [id, session] of this.sessions) {
      sessions.push(this.getSession(id));
    }
    return sessions;
  }

  /**
   * Cierra una sesión y libera recursos
   */
  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: 'Sesión no encontrada' };

    this._rejectAllPending(session, new Error('Sesión cerrada manualmente'));
    session.ws.terminate();
    this.sessions.delete(sessionId);
    log.info(`[Session ${sessionId}] Sesión cerrada manualmente`);
    return { success: true, session_id: sessionId };
  }

  // ─────────────────────────────────────────────
  //  Handlers internos de eventos de OpenAI
  // ─────────────────────────────────────────────

  _handleOpenAIEvent(session, event) {
    const { type } = event;
    log.debug(`[Session ${session.id}] Evento: ${type}`);

    switch (type) {
      case 'session.created':
      case 'session.updated':
        log.debug(`[Session ${session.id}] Sesión configurada en OpenAI`);
        break;

      // Texto delta - soporta tanto beta (response.text.delta) como GA (response.output_text.delta)
      case 'response.text.delta':
      case 'response.output_text.delta': {
        const pending = this._getLatestPending(session);
        if (pending) {
          pending.buffer.textDelta += event.delta || '';
        }
        break;
      }

      // Audio delta - soporta tanto beta (response.audio.delta) como GA (response.output_audio.delta)
      case 'response.audio.delta':
      case 'response.output_audio.delta': {
        const pending = this._getLatestPending(session);
        if (pending && pending.returnAudio) {
          pending.buffer.audioDelta.push(event.delta || '');
        }
        break;
      }

      // Transcripción del audio de respuesta - soporta beta y GA
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta': {
        const pending = this._getLatestPending(session);
        if (pending && !pending.buffer.textDelta) {
          pending.buffer.textDelta += event.delta || '';
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const pending = this._getLatestPending(session);
        if (pending && pending.isAudioInput) {
          pending.buffer.inputTranscript = event.transcript || '';
          log.info(`[Session ${session.id}] Transcripción usuario: "${event.transcript?.substring(0,60)}"`);
        }
        break;
      }

      case 'response.done': {
        const pending = this._getLatestPending(session);
        if (pending) {
          const requestId = this._getLatestPendingId(session);
          log.info(`[Session ${session.id}] Respuesta completa: "${pending.buffer.textDelta?.substring(0,60)}..."`);
          pending.resolve(pending.buffer);
          if (requestId) {
            session.pendingResponses.delete(requestId);
          }
        }
        break;
      }

      case 'error': {
        log.error(`[Session ${session.id}] Error de OpenAI:`, event.error);
        const pending = this._getLatestPending(session);
        if (pending) {
          const requestId = this._getLatestPendingId(session);
          pending.reject(new Error(event.error?.message || 'Error desconocido de OpenAI'));
          if (requestId) {
            session.pendingResponses.delete(requestId);
          }
        }
        break;
      }

      case 'rate_limits.updated':
      case 'response.created':
      case 'response.output_item.added':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_item.done':
      case 'input_audio_buffer.committed':
      case 'input_audio_buffer.cleared':
      case 'conversation.item.created':
      case 'conversation.item.added':
      case 'conversation.item.done':
      case 'conversation.item.input_audio_transcription.delta':
        // Eventos informativos que no necesitamos manejar
        break;

      default:
        log.debug(`[Session ${session.id}] Evento no manejado: ${type}`);
    }
  }

  _getLatestPending(session) {
    const entries = [...session.pendingResponses.entries()];
    if (entries.length === 0) return null;
    return entries[entries.length - 1][1];
  }

  _getLatestPendingId(session) {
    const entries = [...session.pendingResponses.keys()];
    if (entries.length === 0) return null;
    return entries[entries.length - 1];
  }

  _rejectAllPending(session, err) {
    for (const [id, pending] of session.pendingResponses) {
      pending.reject(err);
    }
    session.pendingResponses.clear();
  }

  _getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sesión no encontrada: ${sessionId}`);
    }
    if (session.status === 'closed' || session.status === 'error') {
      throw new Error(`Sesión no disponible (estado: ${session.status})`);
    }
    return session;
  }

  _cleanupIdleSessions() {
    const now = Date.now();
    const maxIdle = this.config.sessionMaxIdleMs;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > maxIdle) {
        log.info(`[SessionManager] Limpiando sesión inactiva: ${id}`);
        this.closeSession(id);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupInterval);
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
  }
}
