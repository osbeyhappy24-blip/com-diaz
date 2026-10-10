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
const BIN_ID = process.env.JSONBIN_BIN_ID || leerBinIdDeArchivo();

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
    return data;
  } catch (e) {
    console.error('[JSONBin] Error leyendo:', e.message);
    return null;
  }
}

export async function guardarEstado(estado) {
  if (!JSONBIN_KEY) {
    throw new Error('JSONBIN_KEY no configurada');
  }

  try {
    if (BIN_ID) {
      // Actualizar bin existente
      const res = await fetch(BASE + '/b/' + BIN_ID, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': JSONBIN_KEY,
        },
        body: JSON.stringify(estado),
      });
      if (!res.ok) throw new Error('JSONBin PUT HTTP ' + res.status);
      return { ok: true, binId: BIN_ID };
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
        body: JSON.stringify(estado),
      });
      if (!res.ok) throw new Error('JSONBin POST HTTP ' + res.status);
      const data = await res.json();
      console.log('[JSONBin] Bin creado:', data.metadata?.id);
      return { ok: true, binId: data.metadata?.id };
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
