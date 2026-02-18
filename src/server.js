/**
 * OpenAI Realtime Voice Bridge Server
 * 
 * Servidor puente entre N8N y la OpenAI Realtime Voice API.
 * Expone una API REST simple que N8N puede consumir con HTTP Request nodes.
 * 
 * El bridge mantiene conexiones WebSocket persistentes con OpenAI,
 * permitiendo conversaciones multi-turno con contexto y sistema de instrucciones.
 * 
 * Para iniciar:
 *   cp .env.example .env
 *   # Edita .env con tu OPENAI_API_KEY
 *   npm install
 *   npm start
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { SessionManager } from './session-manager.js';
import { createSessionsRouter } from './routes/sessions.js';
import { log } from './utils/logger.js';

// ─────────────────────────────────────────────
//  Validación de variables de entorno críticas
// ─────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.error('\x1b[31m[ERROR] OPENAI_API_KEY no está configurada en .env\x1b[0m');
  console.error('  1. Copia .env.example → .env');
  console.error('  2. Agrega tu API key de OpenAI');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '3030');
const HOST = process.env.HOST || '0.0.0.0';
const BRIDGE_TOKEN = process.env.BRIDGE_API_TOKEN;

// ─────────────────────────────────────────────
//  Inicializar SessionManager (gestiona WebSockets con OpenAI)
// ─────────────────────────────────────────────
const sessionManager = new SessionManager();

// ─────────────────────────────────────────────
//  Configurar Express
// ─────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Token'],
}));

app.use(express.json({ limit: '50mb' })); // 50MB para audio grande
app.use(express.urlencoded({ extended: true }));

// Logging de requests
app.use((req, res, next) => {
  log.info(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
//  Middleware de autenticación (opcional)
// ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!BRIDGE_TOKEN) {
    // Sin token configurado = acceso libre (solo para desarrollo local)
    return next();
  }

  const token = req.headers['authorization']?.replace('Bearer ', '') ||
                req.headers['x-api-token'];

  if (!token || token !== BRIDGE_TOKEN) {
    return res.status(401).json({
      success: false,
      error: 'Token de autenticación inválido o faltante',
      hint: 'Incluye el header: Authorization: Bearer <tu_token>',
    });
  }
  next();
}

// ─────────────────────────────────────────────
//  Rutas
// ─────────────────────────────────────────────

// Health check - sin autenticación
app.get('/health', (req, res) => {
  const sessions = sessionManager.listSessions();
  res.json({
    status: 'ok',
    service: 'OpenAI Realtime Voice Bridge',
    version: '1.0.0',
    model: process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview',
    active_sessions: sessions.length,
    timestamp: new Date().toISOString(),
    auth_required: !!BRIDGE_TOKEN,
  });
});

// Info de la API - sin autenticación
app.get('/', (req, res) => {
  res.json({
    service: 'OpenAI Realtime Voice Bridge',
    description: 'Puente HTTP entre N8N y la OpenAI Realtime Voice API',
    version: '1.0.0',
    docs: 'https://github.com/tu-usuario/openai-realtime-bridge',
    endpoints: {
      health: 'GET /health',
      sessions: {
        create:  'POST /api/v1/sessions',
        list:    'GET  /api/v1/sessions',
        info:    'GET  /api/v1/sessions/:id',
        close:   'DELETE /api/v1/sessions/:id',
        text:    'POST /api/v1/sessions/:id/text',
        audio:   'POST /api/v1/sessions/:id/audio',
        update:  'POST /api/v1/sessions/:id/update',
        history: 'GET  /api/v1/sessions/:id/history',
      },
    },
    quick_start: [
      '1. POST /api/v1/sessions con instrucciones → obtén session_id',
      '2. POST /api/v1/sessions/:id/text con tu mensaje → obtén respuesta',
      '3. DELETE /api/v1/sessions/:id cuando termines',
    ],
  });
});

// API principal (con autenticación opcional)
app.use('/api/v1/sessions', authMiddleware, createSessionsRouter(sessionManager));

// ─────────────────────────────────────────────
//  Ruta de conveniencia: Conversación directa (crea sesión + envía + cierra)
//  Útil para casos simples donde no necesitas mantener sesión
// ─────────────────────────────────────────────
app.post('/api/v1/chat', authMiddleware, async (req, res) => {
  const { message, instructions, voice, return_audio } = req.body || {};

  if (!message) {
    return res.status(400).json({
      success: false,
      error: 'El campo "message" es requerido',
    });
  }

  let sessionId;
  try {
    // Crear sesión temporal
    const session = await sessionManager.createSession({ instructions, voice });
    sessionId = session.session_id;

    // Enviar mensaje
    const result = await sessionManager.sendText(sessionId, message, {
      returnAudio: !!return_audio,
    });

    // Si hay audio, convertir a WAV también
    if (result.audio_base64) {
      const { pcm16ToWavBase64 } = await import('./utils/audio.js');
      result.audio_wav_base64 = pcm16ToWavBase64(result.audio_base64);
    }

    res.json({ success: true, ...result, session_type: 'ephemeral' });
  } catch (err) {
    log.error('[API] Error en /chat:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    // Cerrar la sesión temporal
    if (sessionId) {
      await sessionManager.closeSession(sessionId).catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────
//  Manejo de errores 404
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Ruta no encontrada: ${req.method} ${req.path}`,
    hint: 'Visita GET / para ver todos los endpoints disponibles',
  });
});

// ─────────────────────────────────────────────
//  Manejo de errores global
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  log.error('[Express] Error no manejado:', err.message);
  res.status(500).json({ success: false, error: 'Error interno del servidor' });
});

// ─────────────────────────────────────────────
//  Iniciar servidor
// ─────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
  console.log('\n\x1b[32m╔══════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[32m║   OpenAI Realtime Voice Bridge - LISTO 🎙️    ║\x1b[0m');
  console.log('\x1b[32m╚══════════════════════════════════════════════╝\x1b[0m');
  console.log(`\n  URL Local:    \x1b[36mhttp://localhost:${PORT}\x1b[0m`);
  console.log(`  Health:       \x1b[36mhttp://localhost:${PORT}/health\x1b[0m`);
  console.log(`  API Base:     \x1b[36mhttp://localhost:${PORT}/api/v1\x1b[0m`);
  console.log(`  Modelo:       \x1b[33m${process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview'}\x1b[0m`);
  console.log(`  Auth:         \x1b[33m${BRIDGE_TOKEN ? 'Habilitada (Bearer token)' : 'Deshabilitada (solo desarrollo)'}\x1b[0m`);
  console.log(`\n  Para N8N, usa: \x1b[35mhttp://<tu-ip>:${PORT}/api/v1\x1b[0m\n`);
});

// ─────────────────────────────────────────────
//  Manejo de cierre graceful
// ─────────────────────────────────────────────
async function gracefulShutdown(signal) {
  log.info(`\n[Server] Recibida señal ${signal}, cerrando gracefully...`);
  server.close(() => {
    sessionManager.destroy();
    log.info('[Server] Servidor cerrado.');
    process.exit(0);
  });

  setTimeout(() => {
    log.error('[Server] Cierre forzado por timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
