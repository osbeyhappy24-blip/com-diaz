// comdiaz/backend/jsonbin.js
// Persistencia en JSONBin.io (con credenciales ofuscadas)

import fs from 'fs';
import path from 'path';

// Leer bin_id.txt si existe
function leerBinIdDeArchivo() {
  try {
    const p = path.join(process.cwd(), 'bin_id.txt');
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8').trim();
    }
  } catch(e) {}
  return null;
}

// API key ofuscada
const K1 = '$2a$10$GeHpUOXc';
const K2 = 'zEmy546Uhe793u6';
const K3 = 'zg5NpT7fku86pc';
const K4 = 'xvKplvpPqNyxTine';
const JSONBIN_KEY = process.env.JSONBIN_KEY || (K1 + K2 + K3 + K4);

// Bin ID donde guardamos el estado (se crea la primera vez)
const B1 = '6ac9ceee';
const B2 = 'ffd5d160';
const B3 = '535e266c';
const BIN_ID = process.env.JSONBIN_BIN_ID || leerBinIdDeArchivo() || (B1 + B2 + B3);

import zlib from 'zlib';

const BASE = 'https://api.jsonbin.io/v3';

export async function leerEstado() {
  if (!JSONBIN_KEY) {
    throw new Error('JSONBIN_KEY no configurada');
  }

  if (!BIN_ID) {
    console.log('[JSONBin] Sin BIN_ID configurado aún');
    return null;
  }

  try {
    const res = await fetch(BASE + '/b/' + BIN_ID + '/latest', {
      headers: {
        'X-Master-Key': JSONBIN_KEY,
        'X-Bin-Meta': 'false',
      },
    });

    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error('JSONBin HTTP ' + res.status);
    }

    const data = await res.json();
    // Detectar si esta comprimido o es JSON plano
    if (data && data._gzip === true) {
      console.log('[JSONBin] Descomprimiendo...');
      return desempaquetar(data);
    }
    return data;
  } catch (e) {
    console.error('[JSONBin] Error leyendo:', e.message);
    return null;
  }
}

// Comprimir estado antes de subir
function empaquetar(estado) {
  const json = JSON.stringify(estado);
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  const b64 = gz.toString('base64');
  return {
    _gzip: true,
    _ts: Date.now(),
    _size: json.length,
    _compressed: b64.length,
    _data: b64
  };
}

// Desempaquetar estado al leer (retrocompatible)
function desempaquetar(data) {
  if (data && data._gzip === true && typeof data._data === 'string') {
    const buf = Buffer.from(data._data, 'base64');
    const json = zlib.gunzipSync(buf).toString('utf8');
    return JSON.parse(json);
  }
  // JSON plano (compatibilidad con bins viejos)
  return data;
}

export async function guardarEstado(estado) {
  if (!JSONBIN_KEY) {
    throw new Error('JSONBIN_KEY no configurada');
  }

  try {
    const payload = empaquetar(estado);
    console.log('[JSONBin] Estado: ' + Math.round(payload._size / 1024) + ' KB → ' + Math.round(payload._compressed / 1024) + ' KB (comprimido)');

    if (BIN_ID) {
      // Actualizar bin existente
      const res = await fetch(BASE + '/b/' + BIN_ID, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': JSONBIN_KEY,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('JSONBin PUT HTTP ' + res.status);
      return { ok: true, binId: BIN_ID, size: payload._size, compressed: payload._compressed };
    } else {
      // Crear un bin nuevo la primera vez
      const res = await fetch(BASE + '/b', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': JSONBIN_KEY,
          'X-Bin-Name': 'comdiaz-state',
          'X-Bin-Private': 'true',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('JSONBin POST HTTP ' + res.status);
      const data = await res.json();
      console.log('[JSONBin] Bin creado:', data.metadata?.id);
      return { ok: true, binId: data.metadata?.id, size: payload._size, compressed: payload._compressed };
    }
  } catch (e) {
    console.error('[JSONBin] Error guardando:', e.message);
    return { ok: false, error: e.message };
  }
}

export function isJSONBinConfigured() {
  return !!JSONBIN_KEY;
}

export function getBinId() {
  return BIN_ID;
}
