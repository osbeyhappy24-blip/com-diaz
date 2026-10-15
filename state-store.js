// state-store.js
// Almacenamiento del estado en GitHub (reemplaza JSONBin)
// Guarda el JSON comprimido en el repo privado comdiaz-state

import zlib from 'zlib';

const GITHUB_API = 'https://api.github.com';
const FILE_PATH = 'state.json.gz';

function getConfig() {
  const token = process.env.GITHUB_STATE_TOKEN;
  const repo = process.env.GITHUB_STATE_REPO;
  if (!token || !repo) return null;
  return { token, repo };
}

function headers(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'comdiaz-backend',
  };
}

export function isJSONBinConfigured() {
  return !!getConfig();
}

export function getBinId() {
  const cfg = getConfig();
  return cfg ? cfg.repo : null;
}

// Leer el estado guardado (descarga + descomprime)
export async function leerEstado() {
  const cfg = getConfig();
  if (!cfg) {
    console.log('[GitHub-State] Sin configurar (faltan GITHUB_STATE_TOKEN o GITHUB_STATE_REPO)');
    return null;
  }
  try {
    const url = `${GITHUB_API}/repos/${cfg.repo}/contents/${FILE_PATH}`;
    const res = await fetch(url, { headers: headers(cfg.token) });
    if (res.status === 404) {
      console.log('[GitHub-State] Archivo no existe aun (primer arranque)');
      return null;
    }
    if (!res.ok) {
      console.error('[GitHub-State] Error leyendo:', res.status, await res.text().catch(()=>''));
      return null;
    }
    const data = await res.json();
    // Contenido viene en base64
    const gz = Buffer.from(data.content, 'base64');
    const json = zlib.gunzipSync(gz).toString('utf8');
    const estado = JSON.parse(json);
    console.log('[GitHub-State] Estado leido OK (' + Math.round(gz.length/1024) + ' KB comprimidos)');
    return estado;
  } catch (e) {
    console.error('[GitHub-State] Error:', e.message);
    return null;
  }
}

// Guardar el estado (comprime + sube)
export async function guardarEstado(estado) {
  const cfg = getConfig();
  if (!cfg) {
    throw new Error('GitHub State no configurado (faltan env vars)');
  }
  try {
    const json = JSON.stringify(estado);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    const b64 = gz.toString('base64');

    const url = `${GITHUB_API}/repos/${cfg.repo}/contents/${FILE_PATH}`;

    // 1) Obtener SHA del archivo actual (necesario para actualizar)
    let sha = null;
    const getRes = await fetch(url, { headers: headers(cfg.token) });
    if (getRes.ok) {
      const existing = await getRes.json();
      sha = existing.sha;
    } else if (getRes.status !== 404) {
      throw new Error('Error consultando SHA: ' + getRes.status);
    }

    // 2) PUT con el archivo
    const body = {
      message: `update state ${new Date().toISOString()}`,
      content: b64,
      committer: {
        name: 'Comdiaz Backend',
        email: 'backend@comdiaz.com'
      }
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { ...headers(cfg.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!putRes.ok) {
      const errTxt = await putRes.text().catch(() => '');
      throw new Error('GitHub PUT HTTP ' + putRes.status + ': ' + errTxt.slice(0, 200));
    }

    console.log('[GitHub-State] Guardado OK: ' + Math.round(json.length/1024) + ' KB -> ' + Math.round(gz.length/1024) + ' KB comprimido');
    return { ok: true, binId: cfg.repo, size: json.length, compressed: gz.length };
  } catch (e) {
    console.error('[GitHub-State] Error guardando:', e.message);
    return { ok: false, error: e.message };
  }
}
