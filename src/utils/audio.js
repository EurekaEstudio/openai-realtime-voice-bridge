/**
 * Utilidades de Audio para el Bridge de OpenAI Realtime API
 * 
 * El Realtime API usa PCM16 a 24kHz como formato de audio.
 * 
 * Formatos soportados para conversión:
 * - PCM16 raw (nativo de la API)
 * - WAV (contenedor con cabecera)
 * - Base64 de cualquiera de los anteriores
 */

/**
 * Convierte audio PCM16 raw (base64) a WAV (base64)
 * Útil para reproducir el audio de respuesta en navegadores/apps
 * 
 * @param {string} pcm16Base64 - Audio PCM16 en base64 (24kHz, 16-bit, mono)
 * @param {number} sampleRate - Sample rate (default: 24000 para OpenAI Realtime)
 * @returns {string} - WAV en base64
 */
export function pcm16ToWavBase64(pcm16Base64, sampleRate = 24000) {
  const pcmBuffer = Buffer.from(pcm16Base64, 'base64');
  const wavBuffer = addWavHeader(pcmBuffer, sampleRate);
  return wavBuffer.toString('base64');
}

/**
 * Agrega cabecera WAV a datos PCM16 raw
 * @param {Buffer} pcmData - Datos PCM16 sin cabecera
 * @param {number} sampleRate
 * @param {number} numChannels
 * @param {number} bitsPerSample
 * @returns {Buffer}
 */
export function addWavHeader(pcmData, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);
  let offset = 0;

  // RIFF chunk
  header.write('RIFF', offset); offset += 4;
  header.writeUInt32LE(36 + dataSize, offset); offset += 4;
  header.write('WAVE', offset); offset += 4;

  // fmt sub-chunk
  header.write('fmt ', offset); offset += 4;
  header.writeUInt32LE(16, offset); offset += 4;          // Subchunk1Size (PCM = 16)
  header.writeUInt16LE(1, offset); offset += 2;           // AudioFormat (PCM = 1)
  header.writeUInt16LE(numChannels, offset); offset += 2; // NumChannels
  header.writeUInt32LE(sampleRate, offset); offset += 4;  // SampleRate
  header.writeUInt32LE(byteRate, offset); offset += 4;    // ByteRate
  header.writeUInt16LE(blockAlign, offset); offset += 2;  // BlockAlign
  header.writeUInt16LE(bitsPerSample, offset); offset += 2; // BitsPerSample

  // data sub-chunk
  header.write('data', offset); offset += 4;
  header.writeUInt32LE(dataSize, offset);

  return Buffer.concat([header, pcmData]);
}

/**
 * Convierte WAV (base64) a PCM16 raw (base64)
 * Para enviar audio del usuario a OpenAI
 * 
 * @param {string} wavBase64
 * @returns {string} PCM16 base64
 */
export function wavBase64ToPcm16Base64(wavBase64) {
  const wavBuffer = Buffer.from(wavBase64, 'base64');
  // WAV header es de 44 bytes para formato estándar
  const pcmData = wavBuffer.slice(44);
  return pcmData.toString('base64');
}

/**
 * Calcula la duración aproximada de audio PCM16
 * @param {string} pcm16Base64
 * @param {number} sampleRate
 * @returns {number} duración en segundos
 */
export function getPcmDurationSeconds(pcm16Base64, sampleRate = 24000) {
  const bytes = Buffer.from(pcm16Base64, 'base64').length;
  const samples = bytes / 2; // PCM16 = 2 bytes por sample
  return samples / sampleRate;
}

/**
 * Valida si un string es base64 válido
 */
export function isValidBase64(str) {
  if (typeof str !== 'string') return false;
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  return base64Regex.test(str) && str.length % 4 === 0;
}

/**
 * Convierte audio MP3/OGG a PCM16 usando el módulo fluent-ffmpeg
 * NOTA: Requiere ffmpeg instalado en el sistema
 * Solo usar si necesitas soporte de formatos adicionales
 * 
 * Para instalar ffmpeg en macOS: brew install ffmpeg
 * Para instalar en Ubuntu/Debian: apt install ffmpeg
 */
export async function convertToPcm16(inputBase64, inputFormat = 'mp3') {
  // Esta función requiere ffmpeg. Se documenta pero no se ejecuta sin ffmpeg.
  // Si necesitas soporte de otros formatos, instala: npm install fluent-ffmpeg
  throw new Error(
    'Conversión de formatos adicionales no implementada en esta versión. ' +
    'Usa PCM16 (24kHz, 16-bit, mono) o WAV directamente. ' +
    'Para convertir, instala ffmpeg y el módulo fluent-ffmpeg.'
  );
}
