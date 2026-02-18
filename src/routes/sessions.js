/**
 * Rutas REST para gestión de sesiones de voz
 * Estas son las rutas que N8N llama via HTTP Request nodes
 * 
 * BASE URL: http://localhost:3030/api/v1
 * 
 * POST   /sessions              → Crear nueva sesión
 * GET    /sessions              → Listar sesiones activas
 * GET    /sessions/:id          → Info de una sesión
 * DELETE /sessions/:id          → Cerrar sesión
 * POST   /sessions/:id/text     → Enviar texto, recibir respuesta
 * POST   /sessions/:id/audio    → Enviar audio, recibir respuesta
 * POST   /sessions/:id/update   → Actualizar instrucciones
 * GET    /sessions/:id/history  → Historial de conversación
 */

import { Router } from 'express';
import { log } from '../utils/logger.js';
import { pcm16ToWavBase64, wavBase64ToPcm16Base64, isValidBase64 } from '../utils/audio.js';

export function createSessionsRouter(sessionManager) {
  const router = Router();

  // ─────────────────────────────────────────────
  //  POST /sessions - Crear nueva sesión
  // ─────────────────────────────────────────────
  /**
   * Body (JSON):
   * {
   *   "instructions": "Eres un agente de ventas...",  // opcional
   *   "voice": "alloy",                               // opcional
   *   "session_id": "mi-sesion-123",                  // opcional, para ID personalizado
   *   "metadata": { "user_id": "123", "canal": "whatsapp" }  // opcional
   * }
   */
  router.post('/', async (req, res) => {
    try {
      const { instructions, voice, session_id, metadata } = req.body || {};

      const result = await sessionManager.createSession({
        instructions,
        voice,
        sessionId: session_id,
        metadata,
      });

      log.info(`[API] Sesión creada: ${result.session_id}`);
      res.status(201).json({
        success: true,
        ...result,
        message: '✅ Sesión creada. Usa session_id para enviar mensajes.',
        endpoints: {
          send_text: `POST /api/v1/sessions/${result.session_id}/text`,
          send_audio: `POST /api/v1/sessions/${result.session_id}/audio`,
          get_history: `GET /api/v1/sessions/${result.session_id}/history`,
          close: `DELETE /api/v1/sessions/${result.session_id}`,
        },
      });
    } catch (err) {
      log.error('[API] Error creando sesión:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────
  //  GET /sessions - Listar sesiones activas
  // ─────────────────────────────────────────────
  router.get('/', (req, res) => {
    const sessions = sessionManager.listSessions();
    res.json({
      success: true,
      sessions,
      total: sessions.length,
    });
  });

  // ─────────────────────────────────────────────
  //  GET /sessions/:id - Info de sesión
  // ─────────────────────────────────────────────
  router.get('/:id', (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
    }
    res.json({ success: true, session });
  });

  // ─────────────────────────────────────────────
  //  DELETE /sessions/:id - Cerrar sesión
  // ─────────────────────────────────────────────
  router.delete('/:id', async (req, res) => {
    try {
      const result = await sessionManager.closeSession(req.params.id);
      if (!result.success) {
        return res.status(404).json({ success: false, error: result.error });
      }
      res.json({ success: true, message: 'Sesión cerrada', session_id: req.params.id });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────
  //  POST /sessions/:id/text - Enviar texto
  // ─────────────────────────────────────────────
  /**
   * Body (JSON):
   * {
   *   "message": "¿Cuál es el precio del producto X?",
   *   "return_audio": false    // opcional, si quieres audio de respuesta
   * }
   * 
   * Respuesta:
   * {
   *   "success": true,
   *   "response_text": "El precio del producto X es...",
   *   "duration_ms": 1245,
   *   "session_id": "...",
   *   "request_id": "...",
   *   "audio_base64": "...",   // solo si return_audio=true
   *   "audio_format": "pcm16",
   *   "audio_wav_base64": "..." // WAV listo para reproducir, solo si return_audio=true
   * }
   */
  router.post('/:id/text', async (req, res) => {
    try {
      const { message, return_audio } = req.body || {};

      if (!message || typeof message !== 'string' || message.trim() === '') {
        return res.status(400).json({
          success: false,
          error: 'El campo "message" es requerido y debe ser un texto no vacío',
        });
      }

      const result = await sessionManager.sendText(req.params.id, message.trim(), {
        returnAudio: !!return_audio,
      });

      // Si hay audio, también proveer versión WAV lista para usar
      if (result.audio_base64) {
        result.audio_wav_base64 = pcm16ToWavBase64(result.audio_base64);
      }

      res.json({ success: true, ...result });
    } catch (err) {
      log.error('[API] Error enviando texto:', err.message);
      const status = err.message.includes('no encontrada') ? 404 :
                     err.message.includes('Timeout') ? 408 : 500;
      res.status(status).json({ success: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────
  //  POST /sessions/:id/audio - Enviar audio
  // ─────────────────────────────────────────────
  /**
   * Body (JSON):
   * {
   *   "audio_base64": "UklGRiQ...",    // PCM16 o WAV en base64
   *   "audio_format": "wav",            // "pcm16" (default) o "wav"
   *   "return_audio": true              // opcional, default true
   * }
   * 
   * Respuesta:
   * {
   *   "success": true,
   *   "response_text": "Respuesta del asistente...",
   *   "input_transcript": "Lo que dijo el usuario (transcripción)...",
   *   "audio_base64": "...",        // PCM16 si return_audio=true
   *   "audio_wav_base64": "...",    // WAV listo para reproducir
   *   "duration_ms": 2100
   * }
   */
  router.post('/:id/audio', async (req, res) => {
    try {
      const { audio_base64, audio_format, return_audio } = req.body || {};

      if (!audio_base64) {
        return res.status(400).json({
          success: false,
          error: 'El campo "audio_base64" es requerido',
        });
      }

      if (!isValidBase64(audio_base64)) {
        return res.status(400).json({
          success: false,
          error: 'El campo "audio_base64" no es un string base64 válido',
        });
      }

      // Convertir WAV a PCM16 si es necesario
      let pcm16Base64 = audio_base64;
      if (audio_format === 'wav') {
        pcm16Base64 = wavBase64ToPcm16Base64(audio_base64);
      }

      const result = await sessionManager.sendAudio(req.params.id, pcm16Base64, {
        returnAudio: return_audio !== false,
      });

      if (result.audio_base64) {
        result.audio_wav_base64 = pcm16ToWavBase64(result.audio_base64);
      }

      res.json({ success: true, ...result });
    } catch (err) {
      log.error('[API] Error enviando audio:', err.message);
      const status = err.message.includes('no encontrada') ? 404 :
                     err.message.includes('Timeout') ? 408 : 500;
      res.status(status).json({ success: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────
  //  POST /sessions/:id/update - Actualizar instrucciones
  // ─────────────────────────────────────────────
  /**
   * Body (JSON):
   * {
   *   "instructions": "Nueva personalidad: eres un experto en marketing...",
   *   "voice": "nova"   // opcional, cambiar voz (solo afecta futuras respuestas)
   * }
   */
  router.post('/:id/update', async (req, res) => {
    try {
      const { instructions, voice } = req.body || {};

      if (!instructions && !voice) {
        return res.status(400).json({
          success: false,
          error: 'Provee al menos "instructions" o "voice" para actualizar',
        });
      }

      if (instructions) {
        await sessionManager.updateInstructions(req.params.id, instructions);
      }

      res.json({
        success: true,
        message: 'Sesión actualizada',
        session_id: req.params.id,
        updated: { instructions: !!instructions, voice: !!voice },
      });
    } catch (err) {
      log.error('[API] Error actualizando sesión:', err.message);
      const status = err.message.includes('no encontrada') ? 404 : 500;
      res.status(status).json({ success: false, error: err.message });
    }
  });

  // ─────────────────────────────────────────────
  //  GET /sessions/:id/history - Historial
  // ─────────────────────────────────────────────
  router.get('/:id/history', (req, res) => {
    try {
      const history = sessionManager.getHistory(req.params.id);
      res.json({ success: true, ...history });
    } catch (err) {
      const status = err.message.includes('no encontrada') ? 404 : 500;
      res.status(status).json({ success: false, error: err.message });
    }
  });

  return router;
}
