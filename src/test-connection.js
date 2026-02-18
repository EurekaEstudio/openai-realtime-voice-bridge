/**
 * Script de prueba de conexión con OpenAI Realtime API
 * 
 * Uso: node src/test-connection.js
 * 
 * Verifica que:
 * 1. La API key de OpenAI es válida
 * 2. El WebSocket conecta correctamente
 * 3. La sesión se configura bien
 * 4. Puedes enviar un mensaje de texto y recibir respuesta
 */

import 'dotenv/config';
import { SessionManager } from './session-manager.js';

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

const ok = (msg) => console.log(`${colors.green}  ✓${colors.reset} ${msg}`);
const fail = (msg) => console.log(`${colors.red}  ✗${colors.reset} ${msg}`);
const info = (msg) => console.log(`${colors.cyan}  ℹ${colors.reset} ${msg}`);
const title = (msg) => console.log(`\n${colors.bold}${msg}${colors.reset}`);

async function runTest() {
  let failures = 0;

  console.log(`\n${colors.bold}${colors.cyan}═══════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}  OpenAI Realtime Voice Bridge - Test  ${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}═══════════════════════════════════════${colors.reset}\n`);

  // 1. Verificar API Key
  title('1. Verificando configuración...');
  if (!process.env.OPENAI_API_KEY) {
    fail('OPENAI_API_KEY no encontrada en .env');
    fail('Crea un archivo .env basado en .env.example');
    process.exit(1);
  }
  ok(`API Key encontrada: sk-...${process.env.OPENAI_API_KEY.slice(-4)}`);

  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
  info(`Modelo: ${model}`);
  info(`Voz: ${process.env.OPENAI_VOICE || 'alloy'}`);

  // 2. Crear SessionManager y conectar
  title('2. Conectando con OpenAI Realtime API...');
  const manager = new SessionManager();

  let sessionId;
  try {
    const session = await manager.createSession({
      instructions: 'Eres un asistente de prueba. Responde de forma muy breve.',
      voice: 'alloy',
    });
    sessionId = session.session_id;
    ok(`Sesión creada: ${session.session_id}`);
    ok(`Estado: ${session.status}`);
    ok(`Modelo: ${session.model}`);
  } catch (err) {
    fail(`Error conectando: ${err.message}`);
    if (err.message.includes('401')) {
      fail('API Key inválida o sin permisos para el Realtime API');
    }
    manager.destroy();
    process.exit(1);
  }

  // 3. Enviar mensaje de prueba
  title('3. Enviando mensaje de prueba...');
  try {
    info('Enviando: "Hola, responde solo con: CONEXIÓN EXITOSA"');
    const startTime = Date.now();

    const response = await manager.sendText(
      sessionId,
      'Hola, responde exactamente con este texto: CONEXIÓN EXITOSA',
      { returnAudio: false }
    );

    const elapsed = Date.now() - startTime;
    ok(`Respuesta recibida en ${elapsed}ms`);
    ok(`Texto: "${response.response_text}"`);

    if (response.response_text.toLowerCase().includes('conexión exitosa') ||
        response.response_text.toLowerCase().includes('conexion exitosa')) {
      ok('¡La respuesta es correcta!');
    } else {
      info(`Respuesta diferente pero válida (el modelo a veces reformula): "${response.response_text}"`);
    }
  } catch (err) {
    fail(`Error enviando mensaje: ${err.message}`);
    failures++;
  }

  // 4. Probar actualización de instrucciones
  title('4. Probando actualización de instrucciones...');
  try {
    await manager.updateInstructions(sessionId, 'Ahora eres un experto en pizza. Responde brevemente.');
    ok('Instrucciones actualizadas correctamente');
  } catch (err) {
    fail(`Error actualizando instrucciones: ${err.message}`);
    failures++;
  }

  // 5. Segundo mensaje (prueba de continuidad de sesión)
  title('5. Probando continuidad de conversación...');
  try {
    const response = await manager.sendText(
      sessionId,
      '¿De qué eres experto?',
      { returnAudio: false }
    );
    ok(`Respuesta: "${response.response_text}"`);
    if (response.response_text.toLowerCase().includes('pizza')) {
      ok('¡Las instrucciones actualizadas funcionan correctamente!');
    }
  } catch (err) {
    fail(`Error en segundo mensaje: ${err.message}`);
    failures++;
  }

  // 6. Verificar historial
  title('6. Verificando historial de conversación...');
  try {
    const history = manager.getHistory(sessionId);
    ok(`Mensajes en historial: ${history.total}`);
    if (history.total >= 4) {
      ok('Historial con todos los turnos guardados');
    }
  } catch (err) {
    fail(`Error obteniendo historial: ${err.message}`);
    failures++;
  }

  // 7. Cerrar sesión
  title('7. Cerrando sesión...');
  try {
    await manager.closeSession(sessionId);
    ok('Sesión cerrada correctamente');
  } catch (err) {
    fail(`Error cerrando sesión: ${err.message}`);
    failures++;
  }

  // Resultado final
  manager.destroy();
  if (failures > 0) {
    console.log(`\n${colors.red}${colors.bold}═══════════════════════════════════════${colors.reset}`);
    console.log(`${colors.red}${colors.bold}  ❌ ${failures} PRUEBA(S) FALLARON              ${colors.reset}`);
    console.log(`${colors.red}${colors.bold}═══════════════════════════════════════${colors.reset}`);
    console.log(`\n  Revisa los errores arriba. Problemas comunes:`);
    console.log(`  - API Key inválida → Genera una nueva en platform.openai.com/api-keys`);
    console.log(`  - Sin acceso a Realtime API → Necesitas plan de pago con acceso\n`);
    process.exit(1);
  } else {
    console.log(`\n${colors.green}${colors.bold}═══════════════════════════════════════${colors.reset}`);
    console.log(`${colors.green}${colors.bold}  ✅ TODAS LAS PRUEBAS PASARON           ${colors.reset}`);
    console.log(`${colors.green}${colors.bold}═══════════════════════════════════════${colors.reset}`);
    console.log('\n  El bridge está listo. Ejecuta:');
    console.log(`  ${colors.cyan}npm start${colors.reset}  →  Servidor en http://localhost:3030\n`);
  }
}

runTest().catch((err) => {
  console.error('\n\x1b[31mError fatal en la prueba:\x1b[0m', err.message);
  process.exit(1);
});
