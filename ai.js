import fs from 'fs';

function leerEnv() {
  if (process.env.GEMINI_API_KEY) return;
  try {
    const txt = fs.readFileSync(new URL('./.env', import.meta.url), 'utf8');
    for (const l of txt.split('\n')) {
      const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

// Obtener TODAS las keys disponibles (rotacion automatica)
function obtenerKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  if (process.env.GEMINI_API_KEY_2) keys.push(process.env.GEMINI_API_KEY_2);
  if (process.env.GEMINI_API_KEY_3) keys.push(process.env.GEMINI_API_KEY_3);
  return keys;
}

// Estado del rotador (persiste en memoria del proceso)
let keyIndex = 0;
const keysBloqueadas = new Map(); // key -> timestamp hasta cuando esta bloqueada

function elegirKey(keys) {
  const ahora = Date.now();
  // Buscar la primera key NO bloqueada
  for (let i = 0; i < keys.length; i++) {
    const idx = (keyIndex + i) % keys.length;
    const k = keys[idx];
    const bloqueadaHasta = keysBloqueadas.get(k) || 0;
    if (bloqueadaHasta < ahora) {
      keyIndex = (idx + 1) % keys.length; // proxima vez empezar por la siguiente
      return k;
    }
  }
  // Todas bloqueadas: devolver la que se desbloquea antes
  let mejor = keys[0];
  let menorTiempo = Infinity;
  for (const k of keys) {
    const t = keysBloqueadas.get(k) || 0;
    if (t < menorTiempo) { menorTiempo = t; mejor = k; }
  }
  return mejor;
}

function bloquearKey(k, ms) {
  keysBloqueadas.set(k, Date.now() + ms);
}

export async function preguntarIA(prompt, { json = false, images = [] } = {}) {
  leerEnv();
  const keys = obtenerKeys();
  const model = process.env.GEMINI_MODEL;
  if (!keys.length) throw new Error('Falta GEMINI_API_KEY');
  if (!model) throw new Error('Falta GEMINI_MODEL');

  let ultimoError = 'sin detalles';
  const maxIntentos = 4;

  for (let intento = 1; intento <= maxIntentos; intento++) {
    const key = elegirKey(keys);
    const keyCorta = key.slice(-8);

    try {
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts: (() => {
            const parts = [{ text: prompt }];
            for (const img of images) {
              if (img && img.data) {
                parts.push({
                  inline_data: {
                    mime_type: img.mimeType || 'image/jpeg',
                    data: img.data,
                  },
                });
              }
            }
            return parts;
          })() }],
            generationConfig: json ? { responseMimeType: 'application/json' } : {},
          }),
        }
      );

      if (r.status === 429) {
        // Rate limit: bloquear esta key por 60 seg
        bloquearKey(key, 60000);
        ultimoError = '429 (key ' + keyCorta + ')';
        console.log('[IA] Key ' + keyCorta + ' bloqueada 60s por rate limit');
        await new Promise(s => setTimeout(s, 2000));
        continue;
      }

      if (r.status >= 500) {
        // Error servidor: bloquear 30 seg
        bloquearKey(key, 30000);
        ultimoError = r.status + ' (key ' + keyCorta + ')';
        console.log('[IA] Key ' + keyCorta + ' bloqueada 30s por error ' + r.status);
        await new Promise(s => setTimeout(s, 4000));
        continue;
      }

      const d = await r.json();
      if (!r.ok) {
        ultimoError = (d && d.error && d.error.message) || ('HTTP ' + r.status);
        throw new Error(ultimoError);
      }

      const partes = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
      return partes.map(p => p.text || '').join('');
    } catch (e) {
      if (e.message && e.message.includes('HTTP')) throw e;
      ultimoError = e.message;
      console.log('[IA] Error en intento ' + intento + ': ' + e.message);
      await new Promise(s => setTimeout(s, 3000));
    }
  }

  throw new Error('IA ocupada (' + ultimoError + '). Intenta en unos minutos.');
}

export function infoKeys() {
  const keys = obtenerKeys();
  const ahora = Date.now();
  return keys.map(k => ({
    sufijo: '...' + k.slice(-8),
    bloqueadaHasta: keysBloqueadas.get(k) > ahora
      ? new Date(keysBloqueadas.get(k)).toISOString()
      : null
  }));
}
