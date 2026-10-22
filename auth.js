
// ═══════════════════════════════════════════════════════
// MÓDULO AUTH — Sin dependencias (crypto nativo)
// · Contraseñas con scrypt (más seguro que bcrypt)
// · JWT con HMAC-SHA256 nativo
// ═══════════════════════════════════════════════════════

import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRA_DIAS = 30;

if (!JWT_SECRET) {
  console.warn('[AUTH] Falta JWT_SECRET en env');
}

// ═══ HASH DE CONTRASEÑAS (scrypt) ═══
// Formato: "salt_hex:hash_hex"
export function hashPassword(password) {
  if (!password || password.length < 6) {
    throw new Error('Contraseña debe tener al menos 6 caracteres');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

// ═══ VERIFICAR CONTRASEÑA ═══
export function verifyPassword(password, stored) {
  if (!password || !stored || !stored.includes(':')) return false;
  try {
    const [salt, hash] = stored.split(':');
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(check, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch(e) {
    return false;
  }
}

// ═══ BASE64URL (helper) ═══
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

// ═══ CREAR JWT ═══
export function createJWT(payload) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET no configurado');
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + (JWT_EXPIRA_DIAS * 24 * 60 * 60)
  };
  const h = b64url(JSON.stringify(header));
  const b = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url');
  return h + '.' + b + '.' + sig;
}

// ═══ VERIFICAR JWT ═══
export function verifyJWT(token) {
  if (!token || typeof token !== 'string') return null;
  if (!JWT_SECRET) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, b, sig] = parts;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url');
    const a = Buffer.from(sig);
    const e = Buffer.from(expected);
    if (a.length !== e.length) return null;
    if (!crypto.timingSafeEqual(a, e)) return null;
    const payload = JSON.parse(b64urlDecode(b));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    return payload;
  } catch(e) {
    return null;
  }
}

// ═══ EXTRAER TOKEN DEL HEADER ═══
export function getTokenFromRequest(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// ═══ MIDDLEWARE helper: devuelve payload o null ═══
export function requireSeller(req) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const payload = verifyJWT(token);
  if (!payload || payload.tipo !== 'seller') return null;
  return payload;
}

export function requireAdmin(req) {
  const token = getTokenFromRequest(req);
  if (!token) {
    // Fallback: permitir con X-Comdiaz-Key (PIN de admin)
    return req.headers['x-comdiaz-key'] ? { tipo: 'admin', via: 'pin' } : null;
  }
  const payload = verifyJWT(token);
  if (!payload || payload.tipo !== 'admin') return null;
  return payload;
}

// ═══ VALIDAR TELÉFONO (formato Cuba) ═══
export function validarTelefono(tel) {
  if (!tel) return false;
  const clean = String(tel).replace(/\D/g, '');
  // Debe empezar con 53 (Cuba) + 8 dígitos = 10 dígitos total
  return /^53\d{8}$/.test(clean);
}

// ═══ NORMALIZAR TELÉFONO ═══
export function normalizarTelefono(tel) {
  const clean = String(tel).replace(/\D/g, '');
  if (clean.startsWith('53') && clean.length === 10) return clean;
  if (clean.length === 8) return '53' + clean; // asumir Cuba
  return clean;
}

export function isAuthConfigured() {
  return !!JWT_SECRET;
}

