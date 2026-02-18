# OpenAI Realtime Voice Bridge 🎙️

> Servidor puente entre **N8N** y la **OpenAI Realtime Voice API** (gpt-4o-realtime-preview)

## ¿Por qué este proyecto?

La OpenAI Realtime API usa **WebSockets persistentes** (no HTTP). N8N solo habla HTTP. Este bridge resuelve eso:

```
N8N ──[HTTP]──▶ Bridge ──[WebSocket]──▶ OpenAI Realtime API
                  │
                  └── Mantiene sesiones, contexto, instrucciones
```

## Características

- ✅ **Conversaciones multi-turno** con memoria (sesiones persistentes)
- ✅ **Instrucciones personalizadas** por sesión (cambia en tiempo real)
- ✅ **Texto y Audio** (PCM16/WAV base64)
- ✅ **Múltiples sesiones** simultáneas
- ✅ **API REST simple** para N8N (HTTP Request nodes)
- ✅ **Listo para producción** (auth token, CORS, cleanup automático)

---

## Inicio Rápido

### 1. Requisitos
- Node.js 18+
- API key de OpenAI con acceso al Realtime API

### 2. Instalación

```bash
cd "Api voz GPT"

# Instalar dependencias
npm install

# Configurar
cp .env.example .env
# → Edita .env y agrega tu OPENAI_API_KEY
```

### 3. Probar la conexión

```bash
npm test
# Verifica que todo funciona antes de iniciar el servidor
```

### 4. Iniciar el servidor

```bash
npm start
# → Servidor en http://localhost:3030
```

---

## Endpoints de la API

### Base URL: `http://localhost:3030/api/v1`

---

### `POST /sessions` — Crear sesión

Crea una nueva conversación con instrucciones personalizadas.

**Body:**
```json
{
  "instructions": "Eres María, experta en ventas de tecnología. Sé amable y persuasiva.",
  "voice": "nova",
  "session_id": "opcional-id-personalizado",
  "metadata": { "user_id": "123", "canal": "whatsapp" }
}
```

**Respuesta:**
```json
{
  "success": true,
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "ready",
  "model": "gpt-4o-realtime-preview",
  "voice": "nova",
  "created_at": "2025-01-15T10:30:00.000Z"
}
```

---

### `POST /sessions/:id/text` — Enviar texto

Envía un mensaje de texto y recibe la respuesta.

**Body:**
```json
{
  "message": "¿Tienen laptops para diseño gráfico?",
  "return_audio": false
}
```

**Respuesta:**
```json
{
  "success": true,
  "response_text": "¡Claro! Tenemos excelentes opciones para diseño gráfico...",
  "duration_ms": 1245,
  "session_id": "550e8400...",
  "request_id": "req-abc123"
}
```

> Con `"return_audio": true`, también recibirás `audio_base64` (PCM16) y `audio_wav_base64` (WAV listo para reproducir).

---

### `POST /sessions/:id/audio` — Enviar audio

Envía audio del usuario y recibe respuesta en texto (y audio opcional).

**Body:**
```json
{
  "audio_base64": "UklGRiQ...",
  "audio_format": "wav",
  "return_audio": true
}
```

**Respuesta:**
```json
{
  "success": true,
  "input_transcript": "¿Tienen laptops para diseño?",
  "response_text": "¡Sí! Te recomiendo...",
  "audio_base64": "UklGR...",
  "audio_wav_base64": "UklGRiQ...",
  "duration_ms": 2100
}
```

---

### `POST /sessions/:id/update` — Cambiar instrucciones

Cambia el comportamiento del asistente en tiempo real, sin perder el historial.

**Body:**
```json
{
  "instructions": "Ahora eres un experto en marketing digital. Sé más técnico."
}
```

---

### `POST /chat` — Chat rápido (sin sesión)

Para preguntas únicas donde no necesitas mantener contexto.

**Body:**
```json
{
  "message": "¿Cuál es la capital de Francia?",
  "instructions": "Responde muy brevemente.",
  "return_audio": false
}
```

---

### `GET /sessions/:id/history` — Historial

```json
{
  "session_id": "550e8400...",
  "messages": [
    { "role": "user", "content": "Hola", "timestamp": "..." },
    { "role": "assistant", "content": "¡Hola! ¿En qué puedo ayudarte?", "timestamp": "..." }
  ],
  "total": 4
}
```

---

## Integración con N8N

### Importar Workflows

1. En N8N: **Settings → Import Workflow**
2. Importa los archivos de `n8n-workflows/`:
   - `01-conversacion-texto.json` — Conversación básica
   - `02-agente-con-instrucciones.json` — Agente tipificado
   - `03-chat-rapido-sin-sesion.json` — Preguntas simples

### Ejemplo: HTTP Request Node en N8N

**Crear sesión:**
```
Method: POST
URL: http://localhost:3030/api/v1/sessions
Headers: Content-Type: application/json
Body (JSON):
{
  "instructions": "{{ $json.instrucciones }}",
  "voice": "alloy"
}
```

**Guardar session_id para reusarlo:**
```javascript
// En un Code node:
const sessionId = $input.first().json.session_id;
// Guardarlo en static data para la próxima ejecución:
$getWorkflowStaticData('global').voiceSessionId = sessionId;
```

---

## Configuración (.env)

| Variable | Default | Descripción |
|----------|---------|-------------|
| `OPENAI_API_KEY` | *requerido* | Tu API key de OpenAI |
| `OPENAI_REALTIME_MODEL` | `gpt-4o-realtime-preview` | Modelo a usar |
| `OPENAI_VOICE` | `alloy` | Voz del asistente |
| `PORT` | `3030` | Puerto del servidor |
| `BRIDGE_API_TOKEN` | vacío | Token de auth (vacío = sin auth) |
| `RESPONSE_TIMEOUT_MS` | `30000` | Timeout en ms para respuestas |
| `SESSION_MAX_IDLE_MS` | `300000` | Sesión expira tras 5min inactiva |
| `DEFAULT_INSTRUCTIONS` | ... | Instrucciones por defecto |
| `LOG_LEVEL` | `info` | debug/info/warn/error |

---

## Despliegue en Internet

El servidor corre local por defecto. Para exponerlo:

### Opción 1: ngrok (testing rápido)
```bash
ngrok http 3030
# → https://abc123.ngrok.io (URL pública temporal)
```

### Opción 2: Cloudflare Tunnel (gratis y estable)
```bash
# Instalar: brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel --url http://localhost:3030
```

### Opción 3: Docker + Railway/Render
```dockerfile
# Dockerfile (incluir en el proyecto)
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3030
CMD ["npm", "start"]
```

---

## Voces Disponibles

| Voz | Descripción |
|-----|-------------|
| `alloy` | Neutro, equilibrado |
| `echo` | Masculino, claro |
| `fable` | Narrativo, expresivo |
| `onyx` | Masculino, profundo |
| `nova` | Femenino, amigable |
| `shimmer` | Femenino, suave |
| `verse` | Expresivo, dinámico |
| `coral` | Cálido, natural |

---

## Solución de Problemas

**Error 401 de OpenAI**
→ API key inválida o sin acceso al Realtime API. Verifica en platform.openai.com

**Timeout (408)**
→ Aumenta `RESPONSE_TIMEOUT_MS` en .env o mejora la conexión a internet

**Sesión expirada (404)**
→ Las sesiones expiran tras 5 min de inactividad. Crea una nueva sesión.

**Audio con ruido/distorsionado**
→ Verifica que el audio sea PCM16, 24kHz, mono. La API no acepta otros formatos directamente.

---

## Recursos

- [OpenAI Realtime API Docs](https://platform.openai.com/docs/guides/realtime)
- [OpenAI Realtime WebSocket Guide](https://platform.openai.com/docs/guides/realtime-websocket)
- [OpenAI Realtime API Reference](https://platform.openai.com/docs/api-reference/realtime)
- [N8N HTTP Request Node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)

---

*Creado con Claude Code - OpenAI Realtime Voice Bridge v1.0.0*
