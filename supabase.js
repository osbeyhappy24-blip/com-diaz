
// ═══════════════════════════════════════════════════════
// MÓDULO SUPABASE — Sin dependencias (fetch nativo)
// ═══════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[SUPABASE] Faltan variables de entorno');
}

function headers(extra = {}) {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    ...extra
  };
}

async function request(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase no configurado');
  }
  const url = SUPABASE_URL + '/rest/v1/' + path;
  const r = await fetch(url, {
    ...options,
    headers: headers(options.headers || {})
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error('Supabase ' + r.status + ': ' + err.slice(0, 200));
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

// ═══ SELECT ═══
// dbSelect('sellers', '?telefono=eq.5351234567')
// dbSelect('sellers', '?estado=eq.aprobado&limit=10')
export async function dbSelect(table, query = '') {
  return request(table + query, { method: 'GET' });
}

// ═══ SELECT uno ═══
export async function dbSelectOne(table, query = '') {
  const rows = await dbSelect(table, query + (query.includes('limit') ? '' : '&limit=1'));
  return rows && rows[0] ? rows[0] : null;
}

// ═══ INSERT ═══
export async function dbInsert(table, data) {
  const rows = await request(table, {
    method: 'POST',
    body: JSON.stringify(data)
  });
  return rows && rows[0] ? rows[0] : null;
}

// ═══ UPDATE por columna (por defecto 'id') ═══
export async function dbUpdate(table, id, data, idColumn = 'id') {
  const rows = await request(`${table}?${idColumn}=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data)
  });
  return rows && rows[0] ? rows[0] : null;
}

// ═══ DELETE por columna ═══
export async function dbDelete(table, id, idColumn = 'id') {
  return request(`${table}?${idColumn}=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

// ═══ Contar filas ═══
export async function dbCount(table, query = '') {
  const url = SUPABASE_URL + '/rest/v1/' + table + query;
  const r = await fetch(url, {
    method: 'HEAD',
    headers: {
      ...headers(),
      'Prefer': 'count=exact',
      'Range-Unit': 'items',
      'Range': '0-0'
    }
  });
  const range = r.headers.get('content-range'); // "0-0/123"
  if (range && range.includes('/')) {
    return parseInt(range.split('/')[1], 10) || 0;
  }
  return 0;
}

// ═══ Health check ═══
export async function dbHealth() {
  try {
    await dbSelect('plans', '?limit=1');
    return true;
  } catch(e) {
    return false;
  }
}

export function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}


// ═══════════════════════════════════════════════════════════
// STORAGE HELPERS (para persistencia escalable)
// Bucket: comdiaz-state (privado)
// Uso: storageGet('state-full.json') / storagePut('state-full.json', data)
// ═══════════════════════════════════════════════════════════

const STORAGE_BUCKET = 'comdiaz-state';

export async function storageGet(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + STORAGE_BUCKET + '/' + path, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      }
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error('[STORAGE-GET] HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('[STORAGE-GET] ' + e.message);
    return null;
  }
}

export async function storagePut(path, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { ok: false, error: 'Sin config' };
  try {
    const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + STORAGE_BUCKET + '/' + path, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'x-upsert': 'true'
      },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error('[STORAGE-PUT] HTTP ' + res.status + ': ' + txt.slice(0, 200));
      return { ok: false, error: 'HTTP ' + res.status };
    }
    const size = JSON.stringify(data).length;
    return { ok: true, size };
  } catch (e) {
    console.error('[STORAGE-PUT] ' + e.message);
    return { ok: false, error: e.message };
  }
}

export async function storageDelete(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { ok: false };
  try {
    const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + STORAGE_BUCKET + '/' + path, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      }
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
