// Comdiaz Backend - eBay Production with obfuscated credentials
// comdiaz/backend/server.js
// Comdiaz · Backend de automatización de compras y publicación

import Fastify from 'fastify';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SOURCES, DEFAULT_SOURCE_STATE, listSources } from './sources.js';
import { notifyTelegram } from './telegram.js';
import { subirImagen } from './imgbb.js';
import { leerEstado, guardarEstado, isJSONBinConfigured } from './jsonbin.js';
import { preguntarIA } from './ai.js';
import { ApifyClient } from 'apify-client';
import { initApify, isApifyReady, searchSource, buildProductsForShop, SOURCES_CONFIG } from './import.js';
import webpush from 'web-push';

// Cargar claves VAPID desde .vapid-keys.txt
let VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
let VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
// Si no hay env vars, leer del archivo local (desarrollo)
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  try {
    const vapidRaw = fs.readFileSync(new URL('./.vapid-keys.txt', import.meta.url), 'utf8');
    VAPID_PUBLIC = VAPID_PUBLIC || (vapidRaw.match(/PUBLIC_KEY=(.+)/) || [])[1]?.trim() || '';
    VAPID_PRIVATE = VAPID_PRIVATE || (vapidRaw.match(/PRIVATE_KEY=(.+)/) || [])[1]?.trim() || '';
  } catch (e) {
    // Archivo no existe, es normal en produccion
  }
}
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:admin@comdiaz.com', VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('[VAPID] Web Push configurado OK (' + (process.env.VAPID_PUBLIC ? 'env' : 'file') + ')');
} else {
  console.warn('[VAPID] Sin claves - Web Push desactivado');
}

const BRAND = `
 ██████╗ ██████╗ ███╗   ███╗██████╗ ██╗ █████╗ ███████╗
██╔════╝██╔═══██╗████╗ ████║██╔══██╗██║██╔══██╗╚══███╔╝
██║     ██║   ██║██╔████╔██║██║  ██║██║███████║  ███╔╝
██║     ██║   ██║██║╚██╔╝██║██║  ██║██║██╔══██║ ███╔╝
╚██████╗╚██████╔╝██║ ╚═╝ ██║██████╔╝██║██║  ██║███████╗
 ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝╚══════╝
        Automatización de compras · v0.1
`;

const app = Fastify({ logger: true });

// ─── Apify client (Temu scraper) ───
let APIFY_TOKEN = process.env.APIFY_TOKEN || '';
if (!APIFY_TOKEN) {
  try {
    const raw = fs.readFileSync(path.join(process.env.HOME || '.', '.apify-token'), 'utf8');
    APIFY_TOKEN = (raw.match(/APIFY_TOKEN=(.+)/) || [])[1]?.trim() || '';
  } catch(e) {}
}
let apifyClient = null;
if (APIFY_TOKEN) {
  try {
    apifyClient = new ApifyClient({ token: APIFY_TOKEN });
    console.log('[APIFY] Cliente Temu configurado');
  } catch(e) {
    console.warn('[APIFY] Error iniciando:', e.message);
  }
} else {
  console.warn('[APIFY] Token no configurado - Temu desactivado');
}

// Iniciar modulo multi-fuente Import Hub
if (APIFY_TOKEN) {
  initApify(APIFY_TOKEN);
  console.log('[IMPORT] Import Hub listo');
}

// Zona horaria configurable (por defecto Cuba = America/Havana)
const APP_TZ = process.env.COMDIAZ_TZ || 'America/Havana';


// Tolerar body vacío cuando Content-Type es JSON
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (!body || body.length === 0) return done(null, {});
  try { done(null, JSON.parse(body)); }
  catch (e) { done(e); }
});



// ---- Auth por API Key ----
const failMap = new Map();
const MAX_FAILS = 8, FAIL_WINDOW = 15 * 60 * 1000;

app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  if (req.method === 'OPTIONS') return;
  if (req.url.startsWith('/api/auth')) return;
  if (req.url.startsWith('/api/track-visit')) return;
  if (req.url.startsWith('/api/track-order')) return;
  if (req.url.startsWith('/api/public/')) return;
  if (req.url.startsWith('/ebay-notification')) return;
  if (req.url.startsWith('/api/pin/change')) return;
  const expected = state.pin;
  if (!expected) { reply.code(503).send({ ok: false, error: 'Servicio no configurado' }); return; }

  const ip = getClientIP(req);
  const now = Date.now();
  const f = failMap.get(ip);
  if (f && now < f.resetAt && f.count >= MAX_FAILS) {
    reply.code(429).send({ ok: false, error: 'Demasiados intentos. Espera unos minutos.' });
    return;
  }

  const got = String(req.headers['x-comdiaz-key'] || req.query?.k || '');
  const a = Buffer.from(got), b = Buffer.from(String(expected));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const cur = (f && now < f.resetAt) ? f : { count: 0, resetAt: now + FAIL_WINDOW };
    cur.count++;
    failMap.set(ip, cur);
    reply.code(401).send({ ok: false, error: 'No autorizado' });
  }
});

// ---- CORS ----
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin || "";
  const allowed = ["https://com-diaz-web.onrender.com", "https://com-diaz.onrender.com", "http://com-diaz-web.onrender.com", "http://localhost:3000", "http://127.0.0.1:3000"];
  reply.header("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : "https://com-diaz-web.onrender.com");
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Comdiaz-Key');
  reply.header('Access-Control-Max-Age', '86400');

  // ─── Headers de seguridad ───
  // Bloquea XSS, clickjacking, MIME sniffing, etc.
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // Content Security Policy - permite Google Fonts, Analytics, imagenes externas, service worker
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://www.google-analytics.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self' https://com-diaz.onrender.com https://com-diaz-web.onrender.com https://www.google-analytics.com https://region1.google-analytics.com https://wsrv.nl",
    "frame-src 'self' https://www.googletagmanager.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
  reply.header('Content-Security-Policy', csp);
});
app.options('*', async (req, reply) => reply.code(204).send());


const DB_FILE = path.join(process.cwd(), 'data.json');

// 45 categorías por defecto de Comdiaz
// dummyjson: [] significa "sin equivalente en la prueba, listo para Amazon/SheIn"
const DEFAULT_CATEGORIES = [
  // ═══ ALTA DEMANDA CUBA - ELECTRÓNICA ═══
  { label: '📱 Celulares y Accesorios',        dummyjson: ['smartphones', 'iphone', 'samsung-galaxy', 'phone-case', 'screen-protector'] },
  { label: '💻 Computación',                    dummyjson: ['laptops', 'tablets', 'keyboard', 'mouse', 'computer-accessories'] },
  { label: '🎧 Audio y Audífonos',              dummyjson: ['headphones', 'earbuds', 'bluetooth-speaker', 'soundbar'] },
  { label: '⌚ Relojes y Smartwatch',           dummyjson: ['watches', 'smartwatch', 'apple-watch', 'digital-watch'] },
  { label: '🎮 Gaming',                         dummyjson: ['gaming-controller', 'gaming-headset', 'video-games', 'gaming-mouse'] },

  // ═══ ENERGÍA - CRÍTICO EN CUBA ═══
  { label: '☀️ Paneles Solares e Inversores',   dummyjson: ['solar-panel', 'solar-generator', 'power-inverter', 'solar-charger'] },
  { label: '⚡ Ecoflow y Estaciones Portátiles', dummyjson: ['ecoflow', 'portable-power-station', 'solar-generator', 'power-station', 'jackery', 'bluetti'] },
  { label: '🔋 Baterías y Cargadores',          dummyjson: ['power-bank', 'battery-charger', 'car-battery', 'rechargeable-battery'] },
  { label: '💡 Iluminación LED',                dummyjson: ['led-lights', 'solar-lights', 'flashlight', 'led-bulbs'] },
  { label: '⚡ Energía y Electricidad',         dummyjson: ['electrical-tools', 'cables', 'extension-cord', 'voltage-regulator'] },

  // ═══ ROPA Y CALZADO ═══
  { label: '👕 Ropa de Hombre',                 dummyjson: ['mens-shirts', 'mens-shoes', 'mens-jeans', 'mens-polos'] },
  { label: '👗 Ropa de Mujer',                  dummyjson: ['womens-dresses', 'womens-tops', 'womens-jeans', 'leggings'] },
  { label: '🧒 Ropa Infantil',                  dummyjson: ['kids-clothing', 'baby-clothes', 'children-shoes'] },
  { label: '👟 Calzado',                        dummyjson: ['sneakers', 'mens-shoes', 'womens-shoes', 'running-shoes', 'sandals'] },
  { label: '👜 Bolsos y Mochilas',              dummyjson: ['womens-bags', 'backpacks', 'handbags', 'wallets'] },

  // ═══ BELLEZA Y CUIDADO PERSONAL ═══
  { label: '💄 Belleza y Maquillaje',           dummyjson: ['beauty', 'makeup', 'fragrances', 'cosmetics'] },
  { label: '🧴 Cuidado de la Piel',             dummyjson: ['skin-care', 'face-cream', 'sunscreen', 'serum'] },
  { label: '💇 Cabello y Pelucas',              dummyjson: ['wig', 'hair-extensions', 'hair-dryer', 'hair-straightener'] },
  { label: '💈 Barbería',                       dummyjson: ['hair-clipper', 'shaver', 'razor', 'beard-trimmer'] },
  { label: '💍 Bisutería y Joyería',            dummyjson: ['womens-jewellery', 'necklace', 'earrings', 'bracelet'] },
  { label: '🕶️ Accesorios Personales',          dummyjson: ['sunglasses', 'hats', 'belts', 'caps'] },

  // ═══ HOGAR Y COCINA ═══
  { label: '🍳 Cocina',                         dummyjson: ['kitchen-accessories', 'cookware', 'kitchen-tools', 'blender'] },
  { label: '🔌 Electrodomésticos',              dummyjson: ['air-fryer', 'coffee-machine', 'microwave', 'electric-kettle'] },
  { label: '🏠 Hogar y Decoración',             dummyjson: ['home-decoration', 'bedding', 'curtains', 'furniture'] },
  { label: '🧹 Limpieza',                       dummyjson: ['cleaning-supplies', 'vacuum-cleaner', 'mop'] },

  // ═══ HERRAMIENTAS Y TALLER ═══
  { label: '🔧 Herramientas',                   dummyjson: ['tools', 'drill', 'screwdriver', 'wrench', 'tool-set'] },
  { label: '🔩 Ferretería',                     dummyjson: ['hardware', 'nails', 'hinges', 'door-locks'] },
  { label: '🚿 Plomería',                       dummyjson: ['plumbing', 'faucet', 'water-pump', 'pipes'] },

  // ═══ VEHÍCULOS Y TRANSPORTE ═══
  { label: '🚗 Piezas de Autos',                dummyjson: ['car-parts', 'car-accessories', 'motor-oil', 'car-tools'] },
  { label: '🏍️ Motos y Bicicletas',            dummyjson: ['motorcycle', 'motorcycle-parts', 'bicycle', 'bicycle-parts'] },

  // ═══ FAMILIA Y ENTRETENIMIENTO ═══
  { label: '🧸 Niños y Juguetes',               dummyjson: ['toys', 'lego', 'dolls', 'action-figures'] },
  { label: '📚 Escolar y Papelería',            dummyjson: ['stationery', 'notebooks', 'school-supplies', 'pens'] },
  { label: '🏋️ Deportes y Fitness',             dummyjson: ['sports-accessories', 'fitness-equipment', 'yoga-mat', 'gym-gloves'] },
  { label: '🐕 Mascotas',                       dummyjson: ['pet-supplies', 'dog-food', 'pet-toys', 'cat-supplies'] },
  { label: '🎉 Fiestas y Eventos',              dummyjson: ['party-decorations', 'balloons', 'gift-wrap', 'party-supplies'] },
  { label: '💊 Salud y Bienestar',              dummyjson: ['vitamins', 'supplements', 'first-aid', 'medical-supplies'] },
];

const DEFAULTS = {
  automation: {
    running: false,
    delaySeconds: 5,
    publishTimes: ["10:30"],
    lastRun: null,
    nextRuns: [],
  },
  margin: 35,
  pin: '985898',
  published: [],
  featured: [], // IDs destacados
  visits: { total: 0, history: [], byDay: {}, byProduct: {} },
  productosManuales: [], // productos locales agregados manualmente // IDs publicados al catálogo público
  shopConfig: {
    whatsapp: '5351425691',
    titulo: 'Comdiaz Shop',
    subtitulo: 'Productos importados y locales',
    horarioAtencion: 'Lun-Sab 9:00am - 9:00pm',
    publicarAutomatico: true,
    maxProductos: 500,
    mostrarPrecioBase: false,
    bannerActivo: false,
    bannerTexto: '',
    bannerColor: 'gradient',
    promociones: [
      { id: 'p1', texto: 'Envio gratis en pedidos +$50', emoji: 'truck', color: 'green', activo: true }
    ],
    rotacionSeg: 5,
  },
  loginAttempts: {}, // IP -> { count, blockedUntil }
  activityLog: [], // ultimos eventos
  subscriptions: [], // Web Push: suscripciones vinculadas a pedidos
  tesoreria: {
    movimientos: []  // lista de ingresos/egresos
  },
  appVersion: {
    version: 1,
    versionName: '1.0.0',
    url: '',
    notas: '',
    fecha: null
  },
  importConfig: {
    autoImport: {
      enabled: false,
      limitPerCategory: 5,     // productos max por categoria x fuente
      margin: 40,               // margen global (%)
      categories: [],           // labels de categorias a importar (vacio = todas)
      sources: {
        temu:    { enabled: true },
        amazon:  { enabled: true },
        walmart: { enabled: false }
      }
    }
  },
  categories: DEFAULT_CATEGORIES,
  results: [],
  sources: JSON.parse(JSON.stringify(DEFAULT_SOURCE_STATE)),
};

const state = fs.existsSync(DB_FILE)
  ? { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }
  : structuredClone(DEFAULTS);

const save = async () => { await guardarEnNube(); };

const adapters = {
  async searchFrom(sourceId, query, sourceState) {
    const src = SOURCES[sourceId];
    if (!src) throw new Error('Fuente desconocida: ' + sourceId);
    const st = sourceState[sourceId] || {};
    if (!st.enabled) return [];
    return await src.searchByCategory(query, st.config || {});
  }
};


function generarTxId(movimientos) {
  const year = new Date().getFullYear();
  const prefix = 'TX-' + year + '-';
  const existentes = (movimientos || [])
    .map(m => String(m.id || ''))
    .filter(id => id.startsWith(prefix))
    .map(id => parseInt(id.slice(prefix.length), 10) || 0);
  const siguiente = existentes.length ? Math.max(...existentes) + 1 : 1;
  return prefix + String(siguiente).padStart(4, '0');
}

async function sendPushToOrder(orderId, titulo, mensaje) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[PUSH] VAPID no configurado');
    return { ok: false, error: 'VAPID no configurado' };
  }
  // Buscar pedido para obtener whatsapp del cliente
  const order = (state.orders || []).find(o => String(o.id) === String(orderId));
  const whatsapp = order ? String(order.whatsapp || '').replace(/[^0-9]/g, '') : '';
  // Filtrar por whatsapp (todos los pedidos) O por orderId (compatibilidad)
  const subs = (state.subscriptions || []).filter(s =>
    (whatsapp && String(s.whatsapp || '') === whatsapp) ||
    String(s.orderId) === String(orderId)
  );
  if (!subs.length) {
    console.log('[PUSH] Sin suscripciones para pedido', orderId, 'whatsapp:', whatsapp);
    return { ok: true, enviados: 0 };
  }
  console.log('[PUSH] Enviando a', subs.length, 'subs (whatsapp:', whatsapp + ')');
  let enviados = 0;
  let eliminados = 0;
  const payload = JSON.stringify({
    title: titulo || 'Comdiaz Shop',
    body: mensaje || 'Actualizacion de tu pedido',
    icon: '/icon-shop-192.png',
    badge: '/icon-shop-192.png',
    orderId: orderId,
    tag: 'order-' + orderId,
    url: '/shop.html'
  });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, payload);
      enviados++;
    } catch (e) {
      console.warn('[PUSH] Error enviando:', e.statusCode, e.message);
      if (e.statusCode === 410 || e.statusCode === 404) {
        state.subscriptions = state.subscriptions.filter(s => s !== sub);
        eliminados++;
      }
    }
  }
  if (eliminados) await save();
  console.log('[PUSH] Enviados:', enviados, 'Eliminados:', eliminados);
  return { ok: true, enviados, eliminados };
}

function buildShareText(opts = {}) {
  const D = String.fromCharCode(36);
  const mode = String(opts.mode || "custom").toLowerCase();
  const totalProducts = state.results.length;

  // Determinar cuántos y cuáles productos incluir según el modo
  let maxTotal, perCat, fromIdx = 0;

  if (mode === "completo") {
    maxTotal = Number(opts.limit) || 200;
    perCat = 30;
  } else if (mode === "mitad") {
    maxTotal = Math.ceil(totalProducts / 2);
    perCat = Math.max(3, Math.ceil(maxTotal / 8));
  } else if (mode === "tercios") {
    // Cada tercio es la mitad del tamaño de un tercio del total, para que
    // los 3 posts juntos cubran casi todo (con solapamiento leve)
    const tercio = Math.ceil(totalProducts / 3);
    maxTotal = tercio;
    perCat = Math.max(2, Math.ceil(tercio / 8));
    // Índice de inicio según qué parte: parte=1,2,3
    const parte = Number(opts.part) || 1;
    fromIdx = (parte - 1) * tercio;
  } else if (mode === "rotativo") {
    // Rota según la hora actual: 09h -> parte 1, 15h -> parte 2, 21h -> parte 3
    const h = new Date().getHours();
    const parte = h < 12 ? 1 : h < 18 ? 2 : 3;
    const tercio = Math.ceil(totalProducts / 3);
    maxTotal = tercio;
    perCat = Math.max(2, Math.ceil(tercio / 8));
    fromIdx = (parte - 1) * tercio;
    opts.part = parte;
  } else {
    maxTotal = Number(opts.limit) || 30;
    perCat = Number(opts.perCategory) || 5;
  }

  // Filtrar categorías
  const onlyCats = Array.isArray(opts.categories) && opts.categories.length
    ? opts.categories
    : [...new Set(state.results.map(r => r.category))];

  // Rebanar los resultados globalmente
  const slice = state.results.slice(fromIdx, fromIdx + maxTotal);

  // Agrupar por categoría
  const grouped = {};
  for (const r of slice) {
    if (!onlyCats.includes(r.category)) continue;
    grouped[r.category] = grouped[r.category] || [];
    if (grouped[r.category].length < perCat) grouped[r.category].push(r);
  }

  // Encabezado dinámico
  const parteLabel = opts.part ? " (Parte " + opts.part + "/3)" : "";
  const out = [];
  out.push('\uD83D\uDECD *Comdiaz - Ofertas disponibles' + parteLabel + '*');
  out.push('_Precios actualizados - Envios a todo el pais_');
  out.push('');

  let count = 0;
  for (const cat of onlyCats) {
    const items = grouped[cat] || [];
    if (!items.length) continue;
    if (count >= maxTotal) break;
    out.push('--------------------------');
    out.push('*' + cat.toUpperCase() + '*');
    out.push('--------------------------');
    for (const it of items) {
      if (count >= maxTotal) break;
      out.push('- ' + it.title);
      out.push('  Precio: ' + D + it.salePrice);
      if (it.url) out.push('  ' + it.url);
      out.push('');
      count++;
    }
  }

  out.push('--------------------------');
  out.push('🛍️ *Ver catalogo completo:*');
  out.push('https://com-diaz-web.onrender.com/shop.html');
  out.push('');
  out.push('📲 *Pedidos por WhatsApp:*');
  out.push('https://wa.me/5351425691');
  out.push('');
  out.push('Responde este mensaje con el nombre del producto');

  return {
    text: out.join('\n'),
    count,
    mode,
    part: opts.part || null,
    total: totalProducts,
    fromIdx,
  };
}

function guardarResumenAutomatico(trigger) {
  try {
    if (typeof buildShareText !== "function") {
      app.log.warn('buildShareText no disponible');
      return;
    }
    // En cron usamos "rotativo" (cada slot muestra una parte).
    // En manual usamos "custom" con límites chicos para no spamear.
    const mode = (trigger === "cron") ? "rotativo" : "custom";
    const r = buildShareText({ mode, limit: 30, perCategory: 5 });

    state.summaries = state.summaries || [];
    state.summaries.unshift({
      id: Date.now(),
      trigger,
      mode: r.mode,
      part: r.part,
      createdAt: new Date().toISOString(),
      count: r.count,
      products: state.results.length,
      margin: state.margin,
      times: state.automation.publishTimes,
      text: r.text,
    });
    if (state.summaries.length > 20) state.summaries.length = 20;
    app.log.info('Resumen guardado (' + r.count + ' productos, modo ' + r.mode + ')');
    const header = 'Comdiaz · nueva busqueda' + String.fromCharCode(10)
      + 'Trigger: ' + trigger + String.fromCharCode(10)
      + 'Productos: ' + state.results.length + String.fromCharCode(10)
      + 'Margen: ' + state.margin + '%' + String.fromCharCode(10)
      + 'Modo: ' + r.mode + String.fromCharCode(10) + String.fromCharCode(10);
    notifyTelegram(header + r.text.slice(0, 3500)).catch(e => app.log.error('TG: ' + e.message));
  } catch (e) {
    app.log.error('Error guardando resumen: ' + e.message);
  }
}


function logActivity(tipo, detalle) {
  try {
    state.activityLog = state.activityLog || [];
    state.activityLog.unshift({
      id: Date.now() + Math.floor(Math.random() * 1000),
      ts: new Date().toISOString(),
      tipo,
      detalle: detalle || {},
    });
    // Mantener solo los ultimos 200 eventos
    if (state.activityLog.length > 200) state.activityLog.length = 200;
  } catch(e) { app.log.error("Error logActivity: " + e.message); }
}

function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
         req.headers["x-real-ip"] ||
         req.ip ||
         "desconocida";
}

function chequearBloqueo(ip) {
  const reg = state.loginAttempts?.[ip];
  if (!reg) return { bloqueado: false };
  if (reg.blockedUntil && reg.blockedUntil > Date.now()) {
    const min = Math.ceil((reg.blockedUntil - Date.now()) / 60000);
    return { bloqueado: true, minutosRestantes: min };
  }
  if (reg.blockedUntil && reg.blockedUntil <= Date.now()) {
    delete state.loginAttempts[ip];
  }
  return { bloqueado: false };
}

function registrarIntentoFallido(ip) {
  state.loginAttempts = state.loginAttempts || {};
  const reg = state.loginAttempts[ip] || { count: 0 };
  reg.count++;
  reg.lastAttempt = Date.now();
  if (reg.count >= 5) {
    reg.blockedUntil = Date.now() + 15 * 60 * 1000; // 15 min
    app.log.warn("IP bloqueada por 15 min: " + ip);
    logActivity("ip_blocked", { ip, intentos: reg.count });
  }
  state.loginAttempts[ip] = reg;
}

function limpiarIntentos(ip) {
  if (state.loginAttempts?.[ip]) delete state.loginAttempts[ip];
}


const PALABRAS_BLOQUEADAS = [
  'lingerie', 'underwear', 'panties', 'bralette', 'thong',
  'g-string', 'bikini', 'swimsuit', 'adult toy', 'sex toy', 'dildo',
  'vibrator', 'condom', 'erotic', 'porn', 'nsfw', 'escort',
  'camiseta interior', 'lenceria', 'lencería', 'ropa interior',
  'sujetador', 'tanga', 'braga', 'pijama sexy',
  'wine', 'beer', 'vodka', 'whiskey', 'whisky', 'rum', 'tequila',
  'brandy', 'champagne', 'liquor', 'alcohol', 'cerveza', 'vino',
  'ron ', 'licor', 'cognac', 'bourbon', 'gin ', 'sake',
  'cigarette', 'cigar', 'tobacco', 'vape', 'vaping', 'e-cigarette',
  'nicotine', 'hookah', 'shisha', 'bong', 'cigarrillo', 'tabaco',
  'vapeador', 'pipa ',
  'gun ', 'rifle', 'pistol', 'revolver', 'ammo', 'ammunition',
  'firearm', 'knife tactical', 'crossbow', 'silencer',
  'pistola', 'municion', 'munición', 'cuchillo táctico',
  'arma ', 'balas ',
  'cannabis', 'marijuana', 'cbd oil', 'thc', 'weed', 'cocaine',
  'heroin', 'meth', 'lsd', 'mdma', 'ecstasy', 'drogas', 'porro',
  'massage adult', 'massage erotic', 'onlyfans',
];

function esContenidoBloqueado(producto) {
  if (!producto) return true;
  if (producto.extra?.adultOnly === true) return true;
  if (producto.adultOnly === true) return true;
  const titulo = String(producto.title || '').toLowerCase();
  for (const palabra of PALABRAS_BLOQUEADAS) {
    if (titulo.includes(palabra)) return true;
  }
  return false;
}


// Cargar estado desde JSONBin (al arrancar)
async function cargarDesdeNube() {
  if (!isJSONBinConfigured()) return false;
  try {
    const remoto = await leerEstado();
    if (remoto && typeof remoto === 'object' && Object.keys(remoto).length > 0) {
      if (remoto.margin !== undefined) state.margin = remoto.margin;
      if (remoto.pin !== undefined) state.pin = remoto.pin;
      if (remoto.categories) state.categories = remoto.categories;
      if (remoto.shopConfig) state.shopConfig = { ...state.shopConfig, ...remoto.shopConfig };
      if (remoto.automation) state.automation = { ...state.automation, ...remoto.automation };
      if (remoto.sources) state.sources = remoto.sources;
      if (remoto.published) state.published = remoto.published;
      if (remoto.productosManuales) state.productosManuales = remoto.productosManuales;
      if (remoto.orders) state.orders = remoto.orders;
      if (remoto.subscriptions) state.subscriptions = remoto.subscriptions;
      if (remoto.importConfig) state.importConfig = remoto.importConfig;
      if (remoto.appVersion) state.appVersion = remoto.appVersion;
      if (remoto.tesoreria && remoto.tesoreria.movimientos) {
        state.tesoreria = state.tesoreria || { movimientos: [] };
        state.tesoreria.movimientos = remoto.tesoreria.movimientos;
      }
      if (remoto.results && Array.isArray(remoto.results) && remoto.results.length > 0) {
        // Solo recuperar si no tenemos resultados locales (evita perder los frescos)
        if (!state.results || state.results.length === 0) {
          state.results = remoto.results;
          app.log.info('Recuperados ' + remoto.results.length + ' productos eBay de JSONBin');
        }
      }
      if (remoto.visits) state.visits = remoto.visits;
      app.log.info("Config cargada desde JSONBin");
      return true;
    }
  } catch(e) {
    app.log.error("Error cargando JSONBin: " + e.message);
  }
  return false;
}

async function guardarEnNube() {
  // Guardar completo en local
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
  } catch(e) {}

  // En JSONBin guardar SOLO configuracion esencial
  if (isJSONBinConfigured()) {
    const esencia = {
      margin: state.margin,
      pin: state.pin,
      categories: state.categories,
      shopConfig: state.shopConfig,
      automation: {
        running: state.automation.running,
        delaySeconds: state.automation.delaySeconds,
        publishTimes: state.automation.publishTimes,
      },
      sources: state.sources,
      published: (state.published || []).slice(0, 2000),
      // Guardar solo los ultimos 100 productos eBay (publicados) para recuperar tras reinicio
      results: (state.results || [])
        .filter(r => (state.published || []).includes(r.id))
        .slice(0, 800)
        .map(r => ({
          id: r.id,
          title: (r.title || '').slice(0, 120),
          image: r.image,
          salePrice: r.salePrice,
          category: r.category,
          source: r.source,
          url: r.url
        })),
      productosManuales: (state.productosManuales || []).slice(0, 500).map(p => ({
        id: p.id,
        title: (p.title || '').slice(0, 150),
        image: p.image,
        images: p.images ? p.images.slice(0, 1) : [],
        category: p.category,
        priceBase: p.priceBase,
        salePrice: p.salePrice,
        margenPct: p.margenPct,
        cantidad: p.cantidad,
        publicado: p.publicado,
        source: p.source,
        sourceUrl: p.sourceUrl,
        createdAt: p.createdAt
      })),
      orders: (state.orders || []).slice(0, 200),
      subscriptions: (state.subscriptions || []).slice(-500),
      tesoreria: {
        movimientos: (state.tesoreria?.movimientos || []).slice(-500)
      },
      appVersion: state.appVersion,
      importConfig: state.importConfig,
      visits: {
        total: state.visits?.total || 0,
        history: (state.visits?.history || []).slice(-50),
        byDay: state.visits?.byDay || {},
        byProduct: state.visits?.byProduct || {}
      },
    };
    const result = await guardarEstado(esencia);
    if (result && result.binId) {
      try { fs.writeFileSync(path.join(process.cwd(), 'bin_id.txt'), result.binId); } catch(e) {}
    }
  }
}

async function runSearch(trigger = 'manual') {
  const started = Date.now();
  app.log.info('Comdiaz · búsqueda iniciada (' + trigger + ')');
  const found = [];
  let skipped = 0;
  const fuenteActivas = Object.entries(state.sources || {})
    .filter(([_, v]) => v && v.enabled)
    .map(([k]) => k);

  if (fuenteActivas.length === 0) {
    app.log.warn('No hay fuentes activas. Activa al menos una en el Home.');
    return 0;
  }

  for (const cat of state.categories) {
    let queries = cat.dummyjson || [];
    // Si no tiene keywords, usar el label como fallback
    if (!queries.length) {
      queries = [cat.label.toLowerCase()];
    }
    for (const q of queries) {
      for (const sourceId of fuenteActivas) {
        try {
          const items = await adapters.searchFrom(sourceId, q, state.sources);
          for (const it of items) {
            const base = it.price;
            const sale = +(base * (1 + state.margin / 100)).toFixed(2);
            found.push({
              ...it,
              category: cat.label,
              basePrice: base,
              salePrice: sale,
              marginPct: state.margin,
              foundAt: new Date().toISOString(),
            });
          }
        } catch (e) {
          app.log.error('  err [' + cat.label + ' · ' + sourceId + ']: ' + e.message);
        }
      }
    }
    app.log.info('  ok ' + cat.label);
  }

  const seen = new Set();
  const unique = found.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  state.results = unique;
  // Publicación automática (si está activada)
  if (state.shopConfig?.publicarAutomatico) {
    state.published = unique.map(r => r.id);
  }
  state.automation.lastRun = new Date().toISOString();
  guardarResumenAutomatico(trigger);
  await save();

  const ms = Date.now() - started;
  logActivity('search', { trigger, productos: unique.length, categorias: state.categories.length, fuentes: fuenteActivas.length });
  app.log.info('Comdiaz · ' + unique.length + ' productos · ' + skipped + ' categorías sin mapeo · ' + fuenteActivas.length + ' fuentes · ' + ms + 'ms');
  return unique.length;
}

let task = null;

function timesToCron(times) {
  // Convierte horas locales (APP_TZ) a horas UTC para el cron
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ,
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find(p => p.type === type)?.value;
  const horaLocal = parseInt(get('hour'), 10);
  const horaUTC = now.getUTCHours();

  // Calcular offset (puede ser -12 a +14)
  let offset = horaUTC - horaLocal;
  // Normalizar
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;

  const horasUTC = times
    .map(t => {
      const [h, m] = t.split(':').map(Number);
      let utcH = (h + offset + 24) % 24;
      return utcH;
    })
    .filter(h => Number.isInteger(h))
    .sort((a,b) => a-b);

  // Si todos los minutos no son cero, hay que usar cron más complejo.
  // Por simplicidad, solo soportamos minutos = 0.
  const minutos = times.map(t => parseInt(t.split(':')[1], 10));
  const unicoMinuto = minutos.every(m => m === minutos[0]) ? minutos[0] : 0;

  return unicoMinuto + ' ' + horasUTC.join(',') + ' * * *';
}

function computeNextRuns(times) {
  const now = new Date();
  return times
    .map(t => {
      const [h, m] = t.split(':').map(Number);
      // Crear la fecha en la zona horaria configurada
      // Usar formateo manual: "YYYY-MM-DD HH:MM:00" en la zona, luego convertir a ISO
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: APP_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      });
      const parts = fmt.formatToParts(now);
      const get = (type) => parts.find(p => p.type === type)?.value;
      const nowEnTz = new Date(get('year') + '-' + get('month') + '-' + get('day') + 'T' + get('hour') + ':' + get('minute') + ':' + get('second'));

      // Construir la fecha objetivo "hoy a las HH:MM en APP_TZ"
      const objetivo = new Date(nowEnTz);
      objetivo.setHours(h, m, 0, 0);

      // Calcular la diferencia entre la "hora local fingida" y la hora real
      const diffMin = Math.round((now - nowEnTz) / 60000);

      // Convertir objetivo a UTC sumando el offset
      const objetivoUTC = new Date(objetivo.getTime() + diffMin * 60000);

      // Si ya pasó, mover al día siguiente
      if (objetivoUTC <= now) {
        objetivoUTC.setTime(objetivoUTC.getTime() + 24 * 60 * 60 * 1000);
      }
      return objetivoUTC;
    })
    .sort((a, b) => a - b)
    .map(d => d.toISOString());
}

function schedule() {
  if (task) task.stop();
  const expr = timesToCron(state.automation.publishTimes);
  app.log.info(`Comdiaz · cron "${expr}" (${state.automation.publishTimes.join(', ')})`);

  task = cron.schedule(expr, async () => {
    if (!state.automation.running) {
      app.log.warn('Cron disparó pero automatización en pausa.');
      return;
    }
    // Auto-import unificado: usa las mismas categorias que eBay
    try {
      const cfg = state.importConfig?.autoImport;
      if (cfg && cfg.enabled) {
        app.log.info('Ejecutando auto-import multi-fuente desde categorias...');
        const limitPerCat = Number(cfg.limitPerCategory) || 5;
        const marginPct = Number(state.margin) || 35;
        const catsFiltro = Array.isArray(cfg.categories) && cfg.categories.length
          ? cfg.categories
          : state.categories.map(c => c.label);
        const fuentesActivas = Object.entries(cfg.sources || {})
          .filter(([_, v]) => v && v.enabled)
          .map(([k]) => k);

        if (!fuentesActivas.length) {
          app.log.warn('  Auto-import: sin fuentes activas');
        } else {
          for (const cat of state.categories) {
            if (!catsFiltro.includes(cat.label)) continue;
            const queries = (cat.dummyjson && cat.dummyjson.length) ? cat.dummyjson : [];
            if (!queries.length) continue;

            for (const sourceId of fuentesActivas) {
              const imported = [];
              for (const q of queries) {
                try {
                  const productos = await searchSource(sourceId, q, limitPerCat);
                  imported.push(...buildProductsForShop(productos.slice(0, limitPerCat), marginPct));
                } catch(e) {
                  app.log.error('  auto-import err [' + cat.label + ' / ' + sourceId + ' / ' + q + ']: ' + e.message);
                }
              }
              if (imported.length) {
                state.productosManuales = state.productosManuales || [];
                const ids = new Set(state.productosManuales.map(p => p.id));
                const nuevos = imported.filter(p => !ids.has(p.id));
                if (nuevos.length) {
                  state.productosManuales = [...nuevos, ...state.productosManuales].slice(0, 500);
                  app.log.info('  ' + cat.label + ' / ' + sourceId + ': ' + nuevos.length + ' nuevos');
                }
              }
            }
          }
          // Publicar todo lo importado
          for (const p of state.productosManuales) p.publicado = true;
        }
      }
    } catch(e) {
      app.log.error('Auto-import error general: ' + e.message);
    }
    app.log.info('Ejecutando búsqueda programada...');
    runSearch('cron');
  });

  state.automation.nextRuns = computeNextRuns(state.automation.publishTimes);
  save();
}


// Endpoint público para healthcheck (UptimeRobot, Pingdom, etc.)
app.get('/health', async () => ({ ok: true, service: 'comdiaz', ts: Date.now() }));

app.get('/api/state', async () => state);

app.post('/api/automation/play', async () => {
  const delay = state.automation.delaySeconds;
  state.automation.running = true;
  await save();
  app.log.info('Comdiaz · play activado (sin busqueda inmediata)');
  logActivity('play', { delay });
  return { ok: true, delay, running: true };
});

app.post('/api/automation/pause', async () => {
  state.automation.running = false;
  save();
  app.log.info('Comdiaz · automatización pausada');
  logActivity('pause', {});
  return { ok: true };
});

app.post('/api/margin', async (req) => {
  const marginViejo = state.margin;
  const marginNuevo = Number(req.body?.margin);
  if (!marginNuevo || marginNuevo < 0 || marginNuevo > 500) {
    return { ok: false, error: 'Margen debe ser entre 0 y 500' };
  }
  state.margin = marginNuevo;
  if (marginViejo !== state.margin) logActivity('margin', { viejo: marginViejo, nuevo: state.margin });
  state.results = state.results.map(r => ({
    ...r,
    salePrice: +(r.basePrice * (1 + state.margin / 100)).toFixed(2),
    marginPct: state.margin,
  }));
  save();
  return { ok: true, margin: state.margin };
});

app.post('/api/categories/reset', async (req) => {
  const body = req.body || {};
  const confirmar = body.confirm === 'RESET';
  if (!confirmar) {
    return { ok: false, error: 'Envia { confirm: "RESET" } para confirmar' };
  }
  const antes = (state.categories || []).length;
  state.categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
  const despues = state.categories.length;
  await save();
  logActivity('categories_reset', { antes, despues });
  return {
    ok: true,
    mensaje: 'Categorias reseteadas a las nuevas',
    antes,
    despues,
    categorias: state.categories.map(c => c.label)
  };
});

app.post('/api/categories/add', async (req) => {
  const label = String(req.body?.label || req.body?.category || '').trim();
  if (!label) return { ok: false, error: 'label requerido' };

  // Si no se dan keywords explicitos, usar el label como keyword
  let dummyjson = Array.isArray(req.body?.dummyjson) ? req.body.dummyjson : [];
  if (!dummyjson.length) {
    dummyjson = [label.toLowerCase()];
  }

  if (!state.categories.find(c => c.label === label)) {
    state.categories.push({ label, dummyjson });
    logActivity('category_add', { label, dummyjson });
    await save();
  }
  return { ok: true, categories: state.categories };
});

app.post('/api/categories/remove', async (req) => {
  const label = String(req.body?.label || req.body?.category || '').trim();
  state.categories = state.categories.filter(c => c.label !== label);
  save();
  return { ok: true, categories: state.categories };
});

app.post('/api/publish-times', async (req) => {
  const times = Array.isArray(req.body?.times) ? req.body.times : null;
  if (times && times.length) {
    const tiemposViejos = state.automation.publishTimes;
    logActivity('publish_times', { viejo: tiemposViejos, nuevo: times });
    state.automation.publishTimes = times;
    schedule();
  }
  return { ok: true, publishTimes: state.automation.publishTimes };
});

app.post('/api/search/now', async () => {
  const count = await runSearch('manual');
  return { ok: true, count };
});






const D = String.fromCharCode(36); // $

app.post('/api/share', async (req) => {
  return { ok: true, ...buildShareText(req.body || {}) };
});


app.get('/api/sources', async () => ({
  ok: true,
  sources: listSources().map(src => ({
    ...src,
    enabled: !!(state.sources?.[src.id]?.enabled),
    hasConfig: Object.values(state.sources?.[src.id]?.config || {}).some(v => v),
  })),
}));

app.post('/api/sources/toggle', async (req) => {
  const id = String(req.body?.id || "");
  const enabled = !!req.body?.enabled;
  if (!SOURCES[id]) return { ok: false, error: "Fuente desconocida" };
  state.sources = state.sources || {};
  state.sources[id] = state.sources[id] || { enabled: false, config: {} };
  state.sources[id].enabled = enabled;
  await save();
  return { ok: true, id, enabled };
});

app.post('/api/sources/config', async (req) => {
  const id = String(req.body?.id || "");
  const config = req.body?.config || {};
  if (!SOURCES[id]) return { ok: false, error: "Fuente desconocida" };
  state.sources = state.sources || {};
  state.sources[id] = state.sources[id] || { enabled: false, config: {} };
  state.sources[id].config = { ...(state.sources[id].config || {}), ...config };
  await save();
  return { ok: true, id };
});


app.get('/api/summaries', async () => ({
  ok: true,
  total: (state.summaries || []).length,
  summaries: (state.summaries || []).map(s => ({
    id: s.id, trigger: s.trigger, createdAt: s.createdAt,
    count: s.count, products: s.products, margin: s.margin, times: s.times,
  })),
}));

app.get('/api/summaries/latest', async () => ({
  ok: true,
  summary: (state.summaries || [])[0] || null,
}));


app.post('/api/auth', async (req, reply) => {
  const ip = getClientIP(req);
  const got = String(req.body?.key || req.headers['x-comdiaz-key'] || req.query?.k || '');

  // Chequear si la IP esta bloqueada
  const bloqueo = chequearBloqueo(ip);
  if (bloqueo.bloqueado) {
    logActivity('login_blocked', { ip, minutosRestantes: bloqueo.minutosRestantes });
    reply.code(429);
    return { ok: false, error: 'Demasiados intentos. Espera ' + bloqueo.minutosRestantes + ' min.' };
  }

  if (got !== state.pin) {
    registrarIntentoFallido(ip);
    logActivity('login_failed', { ip, intento: (state.loginAttempts[ip]?.count || 1) });
    reply.code(401);
    return { ok: false, error: 'PIN incorrecto' };
  }

  // PIN correcto
  limpiarIntentos(ip);
  logActivity('login_success', { ip });
  await save();
  return { ok: true };
});


app.post('/api/pin/change', async (req, reply) => {
  const actual = String(req.body?.actual || '');
  const nuevo = String(req.body?.nuevo || '').trim();

  if (actual !== state.pin) {
    reply.code(401);
    return { ok: false, error: 'PIN actual incorrecto' };
  }
  if (!/^[0-9]{4,10}$/.test(nuevo)) {
    reply.code(400);
    return { ok: false, error: 'El PIN debe tener de 4 a 10 dígitos' };
  }
  state.pin = nuevo;
  await save();
  app.log.info('PIN actualizado');
  logActivity('pin_change', { ip: getClientIP(req) });
  return { ok: true };
});


app.get('/api/activity', async (req) => {
  const limit = Number(req.query?.limit) || 50;
  const tipo = req.query?.tipo;
  let log = state.activityLog || [];
  if (tipo) log = log.filter(e => e.tipo === tipo);
  return { ok: true, total: log.length, events: log.slice(0, limit) };
});

app.delete('/api/activity', async () => {
  state.activityLog = [];
  logActivity("log_cleared", {});
  await save();
  return { ok: true };
});

app.get('/api/login-attempts', async () => {
  const ahora = Date.now();
  const activos = Object.entries(state.loginAttempts || {})
    .filter(([_, r]) => r.blockedUntil && r.blockedUntil > ahora)
    .map(([ip, r]) => ({ ip, minutos: Math.ceil((r.blockedUntil - ahora) / 60000) }));
  return { ok: true, bloqueados: activos };
});


// ═══════════════════════════════════════════════
// eBay Marketplace Account Deletion Notification
// ═══════════════════════════════════════════════
const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || 'comdiaz_verif_token_2026_x9k2mpQ7vLmN3bR8wZ';
const EBAY_ENDPOINT_URL = process.env.EBAY_ENDPOINT_URL || 'https://com-diaz.onrender.com/ebay-notification';

// GET → eBay envía challenge_code y esperamos responder con hash SHA-256
app.get('/ebay-notification', async (req, reply) => {
  const challengeCode = req.query?.challenge_code;
  if (!challengeCode) {
    return { ok: false, error: 'Falta challenge_code' };
  }
  const hash = crypto.createHash('sha256');
  hash.update(challengeCode);
  hash.update(EBAY_VERIFICATION_TOKEN);
  hash.update(EBAY_ENDPOINT_URL);
  const challengeResponse = hash.digest('hex');
  app.log.info('eBay challenge respondido');
  reply.header('Content-Type', 'application/json');
  return { challengeResponse };
});

// POST → eBay envía notificaciones reales de eliminación de cuenta
app.post('/ebay-notification', async (req, reply) => {
  try {
    const body = req.body || {};
    const userId = body?.notification?.data?.userId || 'desconocido';
    app.log.info('eBay notification recibida: userId=' + userId);
    logActivity('ebay_notification', { userId });
  } catch (e) {
    app.log.error('Error procesando eBay notification: ' + e.message);
  }
  // eBay espera 200 OK para confirmar recepción
  reply.code(200);
  return { ok: true };
});


app.post('/api/telegram-test', async () => {
  const r = await notifyTelegram('🧪 Test manual desde Comdiaz · ' + new Date().toLocaleString('es'));
  return r;
});


// ═══════════════════════════════════════════════
// RATE LIMITING (anti-scraping)
// ═══════════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_LIMITS = {
  '/api/public/catalog': { max: 30, windowMs: 60000 },   // 30 req/min por IP
  '/api/public/config':  { max: 60, windowMs: 60000 },   // 60 req/min por IP
  '/api/public':         { max: 60, windowMs: 60000 },   // default para otros
  '/api/auth':           { max: 10, windowMs: 60000 },   // 10 intentos/min
  '/api/track-order': { max: 5, windowMs: 3600000 },   // 5 pedidos/hora por IP
  '/api/track-visit': { max: 10, windowMs: 60000 },    // 10 visitas/min por IP
  '/api/public/live-search': { max: 20, windowMs: 60000 }, // 20 busquedas/min por IP
};

function checkRateLimit(ip, path) {
  // Buscar la regla más específica
  let rule = null;
  for (const [k, r] of Object.entries(RATE_LIMITS)) {
    if (path === k || path.startsWith(k)) {
      if (!rule || k.length > (rule._key?.length || 0)) {
        rule = { ...r, _key: k };
      }
    }
  }
  if (!rule) return { allowed: true };

  const key = ip + ':' + rule._key;
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + rule.windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + rule.windowMs;
  }

  entry.count++;
  rateLimitMap.set(key, entry);

  if (entry.count > rule.max) {
    return {
      allowed: false,
      resetAt: entry.resetAt,
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    };
  }
  return { allowed: true };
}

// Middleware rate limit (aplicado a endpoints públicos)
app.addHook('onRequest', async (req, reply) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.headers['x-real-ip'] ||
             req.ip ||
             'desconocida';

  const r = checkRateLimit(ip, req.url.split('?')[0]);

  if (!r.allowed) {
    app.log.warn('Rate limit excedido: ' + ip + ' en ' + req.url);
    reply.header('Retry-After', r.retryAfter);
    reply.code(429);
    reply.send({ ok: false, error: 'Demasiadas peticiones. Intenta en ' + r.retryAfter + 's.' });
    return reply;
  }
});

// Limpiar entradas viejas cada 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries()) {
    if (now > v.resetAt + 300000) rateLimitMap.delete(k);
  }
}, 300000);

// ═══════════════════════════════════════════════
// COMDIAZ SHOP — Endpoints públicos
// ═══════════════════════════════════════════════

// GET público: catálogo de productos publicados
app.get('/api/public/catalog', async (req) => {
  const page = Math.max(Number(req.query?.page) || 1, 1);
  const perPage = Math.min(Math.max(Number(req.query?.perPage) || 100, 1), 300);
  const limit = page * perPage; // Traer hasta la pagina actual
  const categoria = req.query?.categoria;

  // Importados (siempre se publican automáticamente)
  let items = (state.results || []).filter(r => (state.published || []).includes(r.id));

  // Manuales (solo los publicados y con stock)
  if (Array.isArray(state.productosManuales)) {
    const manualesPublicos = state.productosManuales.filter(p => p.publicado && (p.cantidad || 0) > 0);
    items = items.concat(manualesPublicos);
  }

  if (categoria && categoria !== 'todas') {
    items = items.filter(p => p.category === categoria);
  }

  // Solo mostrar productos CON imagen
  items = items.filter(p => p.image && typeof p.image === 'string' && p.image.length > 10);

  // Intercalar productos por categoria para que TODAS aparezcan
  // Agrupar por categoria
  const porCategoria = {};
  for (const p of items) {
    const cat = p.category || p.source || 'Otros';
    if (!porCategoria[cat]) porCategoria[cat] = [];
    porCategoria[cat].push(p);
  }

  // Round-robin: intercalar TODOS los items (no cortar por limit)
  const catsIntercalado = Object.keys(porCategoria);
  const intercalados = [];
  let idx = 0;
  let sigueHab = true;

  while (sigueHab) {
    sigueHab = false;
    for (const cat of catsIntercalado) {
      const lista = porCategoria[cat];
      if (idx < lista.length) {
        intercalados.push(lista[idx]);
        sigueHab = true;
      }
    }
    idx++;
  }

  // Paginacion real: devolver desde 0 hasta page*perPage
  const itemsCompletos = intercalados;
  const totalProductos = itemsCompletos.length;
  items = itemsCompletos.slice(0, limit);
  const inicio = (page - 1) * perPage;
  const paginaActual = itemsCompletos.slice(inicio, inicio + perPage);
  const hasMore = (inicio + perPage) < totalProductos;

  // NUNCA exponer el precio base al público
  // Forzar HTTPS en las imágenes
  // Proxy de imágenes (evita bloqueo 403 de eBay)
  function proxearImagen(url) {
    if (!url) return '';
    const clean = String(url).replace(/^http:\/\//, 'https://');
    return 'https://wsrv.nl/?url=' + encodeURIComponent(clean) + '&w=500&output=webp&q=80';
  }

  const publicos = itemsCompletos.map(p => {
    const img = proxearImagen(p.image);
    const imgs = (p.images || [p.image].filter(Boolean))
      .map(u => proxearImagen(u))
      .filter(u => u.length > 10);
    return {
      id: p.id,
      title: p.title,
      image: img,
      images: imgs,
      salePrice: p.salePrice,
      category: p.category || p.source,
      source: p.source,
      url: p.url,
      condition: p.extra?.condition || '',
    };
  });

  // Categorías disponibles
  const categorias = [...new Set([
    ...(state.results || [])
      .filter(r => (state.published || []).includes(r.id))
      .map(r => r.category),
    ...(state.productosManuales || [])
      .filter(p => p.publicado && (p.cantidad || 0) > 0)
      .map(p => p.category || 'Local')
  ])].sort();

  const featuredIds = state.featured || [];
  const destacados = publicos.filter(p => featuredIds.includes(p.id));
  const resto = publicos.filter(p => !featuredIds.includes(p.id));
  const ordenadosCompletos = [...destacados, ...resto];
  // Aplicar paginacion tambien a la respuesta final
  const ordenados = ordenadosCompletos.slice(inicio, inicio + perPage);
  const totalFinal = ordenadosCompletos.length;
  const hasMoreFinal = (inicio + perPage) < totalFinal;

  return {
    ok: true,
    total: totalFinal,
    hasMore: hasMoreFinal,
    page: page,
    perPage: perPage,
    featured: destacados,
    categorias,
    config: {
      titulo: state.shopConfig?.titulo || 'Comdiaz Shop',
      subtitulo: state.shopConfig?.subtitulo || '',
      whatsapp: state.shopConfig?.whatsapp || '',
      horarioAtencion: state.shopConfig?.horarioAtencion || 'Lun-Sab 9:00am - 9:00pm',
      bannerActivo: state.shopConfig?.bannerActivo || false,
      bannerTexto: state.shopConfig?.bannerTexto || '',
      bannerColor: state.shopConfig?.bannerColor || 'gradient',
      promociones: (state.shopConfig?.promociones || []).filter(p => p && p.activo !== false),
      rotacionSeg: Number(state.shopConfig?.rotacionSeg) || 5,
    },
    products: ordenados,
  };
});

// GET público: detalle de un producto
app.get('/api/public/catalog/:id', async (req, reply) => {
  const id = req.params.id;
  const p = (state.results || []).find(r => r.id === id) ||
            (state.productosManuales || []).find(r => r.id === id);
  if (!p || !(state.published || []).includes(p.id)) {
    reply.code(404);
    return { ok: false, error: 'No encontrado' };
  }
  return {
    ok: true,
    product: {
      id: p.id,
      title: p.title,
      image: p.image,
      images: p.images || [p.image].filter(Boolean),
      salePrice: p.salePrice,
      category: p.category || p.source,
      source: p.source,
      url: p.url,
      condition: p.extra?.condition || '',
    }
  };
});

// POST con auth: publicar producto
app.post('/api/publish/:id', async (req) => {
  const id = req.params.id;
  state.published = state.published || [];
  if (!state.published.includes(id)) {
    state.published.push(id);
    logActivity('publish', { id });
    await save();
  }
  return { ok: true, total: state.published.length };
});

// POST con auth: despublicar
app.post('/api/unpublish/:id', async (req) => {
  const id = req.params.id;
  state.published = (state.published || []).filter(x => x !== id);
  logActivity('unpublish', { id });
  await save();
  return { ok: true, total: state.published.length };
});

// GET con auth: ver IDs publicados
// POST con auth: la IA sugiere titulo y descripcion (no guarda nada)
let iaOcupada = false;
app.post('/api/ai/descripcion', async (req, reply) => {
  const id = String((req.body || {}).id || '');
  const p = (state.results || []).find(r => r.id === id) ||
            (state.productosManuales || []).find(r => r.id === id);
  if (!p) { reply.code(404); return { ok: false, error: 'Producto no encontrado' }; }
  if (iaOcupada) { reply.code(429); return { ok: false, error: 'La IA esta ocupada, intenta de nuevo' }; }
  iaOcupada = true;
  try {
    const prompt = 'Eres redactor de una tienda en linea que vende a clientes en Cuba. ' +
      'Mejora este producto. Devuelve SOLO un JSON con dos campos: ' +
      '"titulo" (maximo 70 caracteres, claro, en espanol, sin emojis ni mayusculas excesivas) y ' +
      '"descripcion" (2 o 3 frases, maximo 400 caracteres, sin inventar medidas, marcas ni caracteristicas que no esten en los datos). ' +
      'Datos del producto. Titulo original: ' + String(p.title || '').slice(0, 200) +
      '. Categoria: ' + String(p.category || p.source || '') + '.';
    const txt = await preguntarIA(prompt, { json: true });
    const out = JSON.parse(String(txt).replace(/```json|```/g, '').trim());
    return {
      ok: true, id,
      titulo: String(out.titulo || '').slice(0, 120),
      descripcion: String(out.descripcion || '').slice(0, 600),
    };
  } catch (e) {
    reply.code(502);
    return { ok: false, error: e.message };
  } finally {
    iaOcupada = false;
  }
});

app.get('/api/published', async () => ({
  ok: true,
  total: (state.published || []).length,
  ids: state.published || [],
}));

// POST con auth: publicar todos los resultados actuales
app.post('/api/publish-all', async () => {
  state.published = (state.results || []).map(r => r.id);
  logActivity('publish_all', { total: state.published.length });
  await save();
  return { ok: true, total: state.published.length };
});

// POST con auth: despublicar todo
app.post('/api/unpublish-all', async () => {
  state.published = [];
  logActivity('unpublish_all', {});
  await save();
  return { ok: true, total: 0 };
});

// GET público: configuración del shop
app.get('/api/public/config', async () => ({
  ok: true,
  config: {
    titulo: state.shopConfig?.titulo || 'Comdiaz Shop',
    subtitulo: state.shopConfig?.subtitulo || '',
    whatsapp: state.shopConfig?.whatsapp || '',
    horarioAtencion: state.shopConfig?.horarioAtencion || 'Lun-Sab 9:00am - 9:00pm',
    maxProductos: state.shopConfig?.maxProductos || 200,
    bannerActivo: state.shopConfig?.bannerActivo || false,
    bannerTexto: state.shopConfig?.bannerTexto || '',
    bannerColor: state.shopConfig?.bannerColor || 'gradient',
    promociones: (state.shopConfig?.promociones || []).filter(p => p && p.activo !== false),
    rotacionSeg: Number(state.shopConfig?.rotacionSeg) || 5,
  },
}));

// POST con auth: actualizar config del shop
app.post('/api/shop-config', async (req) => {
  state.shopConfig = { ...(state.shopConfig || {}), ...(req.body || {}) };
  logActivity('shop_config', { campos: Object.keys(req.body || {}) });
  await save();
  return { ok: true, config: state.shopConfig };
});


// ═══════════════════════════════════════════════
// COMDIAZ SHOP — Productos manuales (locales)
// ═══════════════════════════════════════════════

// GET con auth: lista los productos manuales
app.get('/api/manual/products', async () => ({
  ok: true,
  total: (state.productosManuales || []).length,
  products: state.productosManuales || [],
}));

// POST con auth: agregar producto manual
app.post('/api/manual/products', async (req) => {
  const body = req.body || {};
  if (!body.title || !body.image || !body.priceBase) {
    return { ok: false, error: 'Faltan: title, image, priceBase' };
  }
  const margenPct = Number(body.margenPct) || state.margin || 35;
  const priceBase = Number(body.priceBase) || 0;
  const salePrice = +(priceBase * (1 + margenPct / 100)).toFixed(2);

  const producto = {
    id: 'manual-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    title: String(body.title).slice(0, 200),
    image: body.image,
    images: Array.isArray(body.images) ? body.images.slice(0, 5) : [body.image],
    category: String(body.category || 'Local').slice(0, 80),
    description: String(body.description || '').slice(0, 1000),
    priceBase: priceBase,
    salePrice: salePrice,
    margenPct: margenPct,
    cantidad: Number(body.cantidad) || 1,
    publicado: body.publicado !== false,
    source: 'manual',
    createdAt: new Date().toISOString(),
  };
  state.productosManuales = state.productosManuales || [];
  state.productosManuales.unshift(producto);
  logActivity('manual_add', { id: producto.id, title: producto.title });
  await save();
  return { ok: true, product: producto };
});

// PUT con auth: editar producto manual
app.put('/api/manual/products/:id', async (req, reply) => {
  const id = req.params.id;
  const idx = (state.productosManuales || []).findIndex(p => p.id === id);
  if (idx === -1) { reply.code(404); return { ok: false, error: 'No encontrado' }; }
  const body = req.body || {};
  const p = state.productosManuales[idx];

  if (body.title !== undefined) p.title = String(body.title).slice(0, 200);
  if (body.description !== undefined) p.description = String(body.description).slice(0, 1000);
  if (body.category !== undefined) p.category = String(body.category).slice(0, 80);
  if (body.priceBase !== undefined) p.priceBase = Number(body.priceBase);
  if (body.margenPct !== undefined) p.margenPct = Number(body.margenPct);
  if (body.cantidad !== undefined) p.cantidad = Number(body.cantidad);
  if (body.publicado !== undefined) p.publicado = !!body.publicado;
  if (body.image !== undefined) p.image = body.image;

  // Recalcular precio venta
  p.salePrice = +(p.priceBase * (1 + p.margenPct / 100)).toFixed(2);

  logActivity('manual_edit', { id });
  await save();
  return { ok: true, product: p };
});

// DELETE con auth: eliminar producto manual
app.delete('/api/manual/products/:id', async (req) => {
  const id = req.params.id;
  state.productosManuales = (state.productosManuales || []).filter(p => p.id !== id);
  logActivity('manual_delete', { id });
  await save();
  return { ok: true };
});

// POST con auth: reducir cantidad (vendido)
app.post('/api/manual/products/:id/sold', async (req, reply) => {
  const id = req.params.id;
  const p = (state.productosManuales || []).find(x => x.id === id);
  if (!p) { reply.code(404); return { ok: false, error: 'No encontrado' }; }
  const cantidad = Number(req.body?.cantidad) || 1;
  p.cantidad = Math.max(0, (p.cantidad || 0) - cantidad);
  if (p.cantidad === 0) p.publicado = false;
  logActivity('manual_sold', { id, cantidad: p.cantidad });
  await save();
  return { ok: true, cantidad: p.cantidad };
});


// ═══════════════════════════════════════════════
// BÚSQUEDA EN VIVO (en eBay, sin publicar al catálogo)
// ═══════════════════════════════════════════════
app.get('/api/public/live-search', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');

  const query = String(req.query?.q || '').trim();
  if (!query || query.length < 2) {
    reply.code(400);
    return { ok: false, error: 'Escribe al menos 2 caracteres' };
  }

  // Rate limiting: máx 5 búsquedas/min por IP
  const ip = req.headers['cf-connecting-ip'] ||
             req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.ip || 'desconocida';
  const key = ip + ':livesearch';
  const ahora = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, resetAt: ahora + 60000 };
  if (ahora > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = ahora + 60000;
  }
  entry.count++;
  rateLimitMap.set(key, entry);

  if (entry.count > 5) {
    reply.code(429);
    return { ok: false, error: 'Demasiadas búsquedas. Espera 1 minuto.' };
  }

  try {
    const ebaySource = SOURCES.ebay;
    if (!ebaySource) {
      reply.code(500);
      return { ok: false, error: 'eBay no configurado' };
    }

    const cfg = state.sources?.ebay?.config || {};
    if (!cfg.appId || !cfg.certId) {
      reply.code(500);
      return { ok: false, error: 'eBay sin credenciales' };
    }

    const items = await ebaySource.searchByCategory(query, {
      environment: cfg.environment || 'production',
      appId: cfg.appId,
      certId: cfg.certId,
      limit: 20,
      condition: 'NEW',
      buyingOptions: 'FIXED_PRICE',
    });

    const filtrados = items.filter(it => !esContenidoBloqueado(it));
    const margenActual = Number(state.margin) || 35;

    const resultados = filtrados.map(it => {
      const basePrice = Number(it.price) || 0;
      const salePrice = +(basePrice * (1 + margenActual / 100)).toFixed(2);
      // Proxy directo (sin helper)
      const img = 'https://wsrv.nl/?url=' + encodeURIComponent(String(it.image || '').replace(/^http:\/\//, 'https://')) + '&w=500&output=webp&q=80';
      return {
        id: 'live-' + (it.id || Math.random().toString(36).slice(2)),
        title: it.title,
        image: img,
        images: [img],
        salePrice: salePrice,
        category: 'Busqueda: ' + query,
        source: 'ebay',
        url: it.url,
        condition: it.extra?.condition || '',
        isLive: true,
      };
    });

    logActivity('live_search', { query, total: resultados.length });

    return { ok: true, query, total: resultados.length, products: resultados };
  } catch (e) {
    app.log.error('live-search error: ' + e.message);
    reply.code(500);
    return { ok: false, error: 'Error: ' + e.message };
  }
});


// ═══════════════════════════════════════════════
// SUBIDA DE IMÁGENES (ImgBB)
// ═══════════════════════════════════════════════
app.post('/api/upload-image', async (req, reply) => {
  try {
    const { image, nombre } = req.body || {};
    if (!image) {
      reply.code(400);
      return { ok: false, error: 'Falta la imagen' };
    }

    // Límite: 5 subidas/min por IP
    const ip = req.headers['cf-connecting-ip'] ||
               req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.ip || 'desconocida';
    const key = ip + ':upload';
    const ahora = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, resetAt: ahora + 60000 };
    if (ahora > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = ahora + 60000;
    }
    entry.count++;
    rateLimitMap.set(key, entry);

    if (entry.count > 5) {
      reply.code(429);
      return { ok: false, error: 'Demasiadas subidas. Espera 1 minuto.' };
    }

    const resultado = await subirImagen(image, nombre);
    logActivity('upload_image', { url: resultado.url.slice(0, 60) });
    return { ok: true, ...resultado };
  } catch (e) {
    app.log.error('Error subiendo imagen: ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});


// ═══════════════════════════════════════════════
// CONTADOR DE VISITAS PROPIO
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
// DASHBOARD DE ESTADISTICAS
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// GENERADOR DE PUBLICACIONES PARA REDES
// ═══════════════════════════════════════════════

app.post('/api/posts/generate', async (req, reply) => {
  const body = req.body || {};
  const tipo = String(body.tipo || 'oferta').trim();
  const ref = String(body.ref || '').trim() || 'directo';
  const cfg = state.shopConfig || {};
  const wa = cfg.whatsapp || '5351425691';
  const shopUrl = 'https://com-diaz-web.onrender.com/shop.html?ref=' + encodeURIComponent(ref);

  // Obtener productos publicos
  const manuales = (state.productosManuales || []).filter(p => p.publicado !== false);
  const ebay = (state.results || [])
    .filter(r => (state.published || []).includes(r.id))
    .map(r => ({
      id: r.id,
      title: r.title,
      salePrice: r.salePrice,
      category: r.category,
      source: r.source || 'ebay',
      url: r.url
    }));
  const todos = manuales.concat(ebay).filter(p => p.salePrice > 0 && p.title);

  if (!todos.length) {
    reply.code(400);
    return { ok: false, error: 'No hay productos en el catalogo' };
  }

  function pick(arr, n) {
    const copy = [...arr];
    const out = [];
    for (let i = 0; i < n && copy.length; i++) {
      const idx = Math.floor(Math.random() * copy.length);
      out.push(copy.splice(idx, 1)[0]);
    }
    return out;
  }

  function formatoProducto(p, i) {
    const precio = Number(p.salePrice || 0).toFixed(2);
    const titulo = (p.title || '').slice(0, 70).replace(/\n/g, ' ');
    const cat = p.category || '';
    return (i + 1) + '. *' + titulo + '*\n   💰 $' + precio + (cat ? ' · ' + cat : '');
  }

  let texto = '';
  let titulo = '';

  if (tipo === 'oferta') {
    const p = pick(todos, 1)[0];
    titulo = '🔥 OFERTA DEL DÍA';
    texto = titulo + '\n\n' +
      '⭐ ' + p.title.slice(0, 80) + '\n' +
      '💰 Precio: *$' + Number(p.salePrice).toFixed(2) + '*\n' +
      (p.category ? '📦 ' + p.category + '\n' : '') +
      '\n🚚 Envío a toda Cuba\n' +
      '💵 Pago al recibir\n\n' +
      '👉 Ver más: ' + shopUrl + '\n\n' +
      '📲 Pedidos: https://wa.me/' + wa + '\n\n' +
      '⏰ ¡Solo por hoy!';
  }

  else if (tipo === 'novedades') {
    const lista = todos.slice(0, 5);
    titulo = '✨ NOVEDADES EN LA SHOP';
    texto = titulo + '\n\n' +
      'Estos productos recién llegaron:\n\n' +
      lista.map((p, i) => formatoProducto(p, i)).join('\n\n') +
      '\n\n━━━━━━━━━━━━━━━\n' +
      '🚚 Envíos a toda Cuba\n' +
      '💵 Pago contra entrega\n\n' +
      '👉 Catálogo completo: ' + shopUrl + '\n\n' +
      '📲 Pedidos: https://wa.me/' + wa;
  }

  else if (tipo === 'destacados') {
    const lista = pick(todos, 5);
    titulo = '⭐ PRODUCTOS DESTACADOS';
    texto = titulo + '\n\n' +
      'Selección de hoy:\n\n' +
      lista.map((p, i) => formatoProducto(p, i)).join('\n\n') +
      '\n\n━━━━━━━━━━━━━━━\n' +
      '🎁 Más de 2000 productos disponibles\n' +
      '🚚 Envíos a toda Cuba\n\n' +
      '👉 ' + shopUrl + '\n\n' +
      '📲 Pedidos: https://wa.me/' + wa;
  }

  else if (tipo === 'promocion') {
    const promos = (cfg.promociones || []).filter(p => p && p.activo !== false);
    const promoTexto = promos.length
      ? promos.map(p => (p.emoji ? emojiToChar(p.emoji) + ' ' : '') + p.texto).join('\n')
      : '🎁 ' + (cfg.bannerTexto || 'Ofertas especiales esta semana');
    const lista = pick(todos, 3);
    titulo = '🎁 PROMOCIÓN ESPECIAL';
    texto = titulo + '\n\n' +
      promoTexto + '\n\n' +
      '🔥 Aprovecha estos productos:\n\n' +
      lista.map((p, i) => formatoProducto(p, i)).join('\n\n') +
      '\n\n━━━━━━━━━━━━━━━\n' +
      '👉 ' + shopUrl + '\n\n' +
      '📲 Pedidos: https://wa.me/' + wa;
  }

  else if (tipo === 'categoria') {
    const cat = String(body.categoria || '').trim();
    const deCat = cat ? todos.filter(p => p.category === cat) : todos;
    const lista = pick(deCat.length ? deCat : todos, 5);
    titulo = '🛍️ LO QUE BUSCAS';
    texto = titulo + '\n\n' +
      (cat ? 'Productos de *' + cat + '*:\n\n' : 'Selección de productos:\n\n') +
      lista.map((p, i) => formatoProducto(p, i)).join('\n\n') +
      '\n\n━━━━━━━━━━━━━━━\n' +
      '👉 ' + shopUrl + '\n\n' +
      '📲 Pedidos: https://wa.me/' + wa;
  }

  else if (tipo === 'custom') {
    const base = String(body.texto || '').trim();
    texto = base.replace(/{link}/g, shopUrl).replace(/{wa}/g, wa);
    titulo = 'Mensaje personalizado';
  }

  else {
    reply.code(400);
    return { ok: false, error: 'tipo invalido' };
  }

  // Reemplazar emoji codes de promociones
  function emojiToChar(code) {
    const map = {
      truck: '🚚', gift: '🎁', star: '⭐', fire: '🔥', money: '💰',
      cart: '🛒', bell: '🔔', sparkles: '✨', whatsapp: '💬', clock: '⏰', rocket: '🚀'
    };
    return map[code] || '';
  }
  // Aplicar conversion en todo el texto por si quedaron codes
  texto = texto.replace(/\b(truck|gift|star|fire|money|cart|bell|sparkles|whatsapp|clock|rocket)\b/g, (m) => emojiToChar(m));

  logActivity('post_generate', { tipo, ref });
  return {
    ok: true,
    tipo,
    ref,
    titulo,
    texto,
    link: shopUrl,
    whatsapp: wa,
    longitud: texto.length
  };
});

app.get('/api/stats/dashboard', async (req) => {
  const v = state.visits || {};
  const devices = v.devices || {};
  const referidos = v.referidos || {};
  const byDay = v.byDay || {};
  const byProduct = v.byProduct || {};

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const hoy = now.toISOString().slice(0, 10);
  const hace7d = new Date(now.getTime() - 7 * dayMs).toISOString();
  const hace30d = new Date(now.getTime() - 30 * dayMs).toISOString();

  // ─── Dispositivos ───
  const deviceList = Object.entries(devices);
  const totalDevices = deviceList.length;
  const appsInstaladas = deviceList.filter(([_, d]) => d.isApp === true).length;
  const activos7d = deviceList.filter(([_, d]) => (d.ultimaVez || '') >= hace7d).length;
  const activos30d = deviceList.filter(([_, d]) => (d.ultimaVez || '') >= hace30d).length;

  // ─── Visitas ───
  const visitasHoy = byDay[hoy]?.visitas || 0;
  let visitas7d = 0, visitas30d = 0;
  for (const [k, d] of Object.entries(byDay)) {
    if (k >= hace7d.slice(0, 10)) visitas7d += d.visitas || 0;
    if (k >= hace30d.slice(0, 10)) visitas30d += d.visitas || 0;
  }

  // ─── Top productos ───
  const topProductos = Object.entries(byProduct)
    .map(([id, p]) => ({ id, title: p.title || '', count: p.count || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // ─── Referidos ───
  const topReferidos = Object.entries(referidos)
    .map(([ref, r]) => ({ ref, visitas: r.visitas || 0, pedidos: r.pedidos || 0 }))
    .sort((a, b) => b.visitas - a.visitas)
    .slice(0, 15);

  // ─── Conversion ───
  const totalVisitas = v.total || 0;
  const totalPedidos = (state.orders || []).length;
  const tasaConversion = totalVisitas > 0 ? +((totalPedidos / totalVisitas) * 100).toFixed(2) : 0;

  return {
    ok: true,
    dispositivos: {
      total: totalDevices,
      appsInstaladas,
      activos7d,
      activos30d,
      web: totalDevices - appsInstaladas
    },
    visitas: {
      hoy: visitasHoy,
      ultimos7d: visitas7d,
      ultimos30d: visitas30d,
      total: totalVisitas
    },
    pedidos: {
      total: totalPedidos,
      tasaConversion
    },
    topProductos,
    referidos: topReferidos,
    ultimosDispositivos: deviceList
      .sort((a, b) => (b[1].ultimaVez || '').localeCompare(a[1].ultimaVez || ''))
      .slice(0, 10)
      .map(([id, d]) => ({
        id: id.slice(0, 12) + '...',
        primeraVez: d.primeraVez,
        ultimaVez: d.ultimaVez,
        dispositivo: d.dispositivo,
        isApp: d.isApp,
        ref: d.ref,
        visitas: d.visitas
      }))
  };
});

app.post('/api/track-visit', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');

  try {
    const ip = req.headers['cf-connecting-ip'] ||
               req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.ip || 'desconocida';
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    const body = req.body || {};
    const tipo = String(body.tipo || 'page'); // page, product, cart, whatsapp
    const productId = body.productId ? String(body.productId).slice(0, 80) : null;
    const productTitle = body.productTitle ? String(body.productTitle).slice(0, 120) : null;
    const deviceId = body.deviceId ? String(body.deviceId).slice(0, 60) : null;
    const ref = body.ref ? String(body.ref).slice(0, 40) : null;
    const isApp = body.isApp === true;

    // Inicializar
    state.visits = state.visits || { total: 0, history: [], byDay: {}, byProduct: {} };
    if (!state.visits.byDay) state.visits.byDay = {};
    if (!state.visits.byProduct) state.visits.byProduct = {};
    if (!Array.isArray(state.visits.history)) state.visits.history = [];
    if (!state.visits.devices) state.visits.devices = {};
    if (!state.visits.referidos) state.visits.referidos = {};

    const ahora = new Date();
    const dayKey = ahora.toISOString().slice(0, 10); // YYYY-MM-DD
    const hourKey = ahora.getHours();

    // Detectar dispositivo
    let dispositivo = 'Desconocido';
    if (/Android/i.test(ua)) dispositivo = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) dispositivo = 'iOS';
    else if (/Windows/i.test(ua)) dispositivo = 'Windows';
    else if (/Mac/i.test(ua)) dispositivo = 'Mac';
    else if (/Linux/i.test(ua)) dispositivo = 'Linux';

    // Inicializar el día
    if (!state.visits.byDay[dayKey]) {
      state.visits.byDay[dayKey] = { visitas: 0, productos: 0, carrito: 0, whatsapp: 0, horas: {}, dispositivos: {} };
    }
    const dia = state.visits.byDay[dayKey];

    // Contar según tipo
    if (tipo === 'page') dia.visitas++;
    else if (tipo === 'product') dia.productos++;
    else if (tipo === 'cart') dia.carrito++;
    else if (tipo === 'whatsapp') dia.whatsapp++;

    // Horas
    dia.horas[hourKey] = (dia.horas[hourKey] || 0) + 1;

    // Dispositivos
    dia.dispositivos[dispositivo] = (dia.dispositivos[dispositivo] || 0) + 1;

    // Producto más visto
    if (productId) {
      if (!state.visits.byProduct[productId]) {
        state.visits.byProduct[productId] = { title: productTitle || '', count: 0 };
      }
      state.visits.byProduct[productId].count++;
    }

    // Historial reciente (últimos 100)
    state.visits.history.unshift({
      ts: ahora.toISOString(),
      tipo,
      ip: ip.slice(0, 45),
      dispositivo,
      productId: productId || null,
    });
    if (state.visits.history.length > 100) state.visits.history.length = 100;

    // Total
    if (tipo === 'page') state.visits.total++;

    // ─── Registrar dispositivo unico ───
    if (deviceId) {
      const ahoraISO = ahora.toISOString();
      if (!state.visits.devices[deviceId]) {
        state.visits.devices[deviceId] = {
          primeraVez: ahoraISO,
          ultimaVez: ahoraISO,
          dispositivo,
          isApp: isApp,
          ref: ref || null,
          visitas: 1,
          pedidos: 0
        };
      } else {
        state.visits.devices[deviceId].ultimaVez = ahoraISO;
        state.visits.devices[deviceId].visitas = (state.visits.devices[deviceId].visitas || 0) + 1;
        if (isApp) state.visits.devices[deviceId].isApp = true;
      }
    }

    // ─── Registrar referido (fuente de trafico) ───
    if (ref && tipo === 'page') {
      if (!state.visits.referidos[ref]) {
        state.visits.referidos[ref] = { visitas: 0, pedidos: 0, primeraVez: ahora.toISOString() };
      }
      state.visits.referidos[ref].visitas++;
    }

    // Guardar cada 5 visitas para no saturar
    if (state.visits.total % 5 === 0) await save();

    return { ok: true };
  } catch (e) {
    app.log.error('Error track-visit: ' + e.message);
    return { ok: false };
  }
});

// Endpoint para ver las estadísticas (con auth)
app.get('/api/stats', async (req) => {
  const v = state.visits || {};
  if (!v.history) v.history = [];
  if (!v.byDay) v.byDay = {};
  if (!v.byProduct) v.byProduct = {};
  if (typeof v.total !== 'number') v.total = 0;
  const hoy = new Date().toISOString().slice(0, 10);

  // Últimos 7 días
  const ultimos7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    ultimos7.push({
      fecha: key,
      visitas: v.byDay?.[key]?.visitas || 0,
      productos: v.byDay?.[key]?.productos || 0,
      carrito: v.byDay?.[key]?.carrito || 0,
      whatsapp: v.byDay?.[key]?.whatsapp || 0,
    });
  }

  // Top 10 productos
  const topProductos = Object.entries(v.byProduct || {})
    .map(([id, data]) => ({ id, title: data.title, count: data.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Últimas 24 horas
  const hace24h = Date.now() - 24 * 60 * 60 * 1000;
  const recientes = (v.history || []).filter(h => new Date(h.ts).getTime() > hace24h);

  return {
    ok: true,
    total: v.total || 0,
    hoy: v.byDay?.[hoy] || { visitas: 0, productos: 0, carrito: 0, whatsapp: 0 },
    ultimos7,
    topProductos,
    recientes: recientes.length,
    historialReciente: (v.history || []).slice(0, 30),
  };
});


app.get('/api/debug-jsonbin', async () => {
  const configured = isJSONBinConfigured();
  let testRead = null;
  try {
    testRead = await leerEstado();
  } catch(e) {
    testRead = { error: e.message };
  }
  return {
    ok: true,
    configured,
    binId: '6ac9ceeeffd5d160535e266c',
    read: testRead,
  };
});


// NOTIFICACION DE PEDIDOS
function generarOrderId(orders) {
  const year = new Date().getFullYear();
  const prefix = 'CD-' + year + '-';
  const existentes = (orders || [])
    .map(o => String(o.id || ''))
    .filter(id => id.startsWith(prefix))
    .map(id => parseInt(id.slice(prefix.length), 10) || 0);
  const siguiente = existentes.length ? Math.max(...existentes) + 1 : 1;
  return prefix + String(siguiente).padStart(4, '0');
}

app.post('/api/track-order', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  try {
    const body = req.body || {};
    const nombre = String(body.nombre || 'Sin nombre').slice(0, 60);
    const notas = String(body.notas || '').slice(0, 200);
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    const total = Number(body.total) || 0;
    if (!items.length) {
      reply.code(400);
      return { ok: false, error: 'Sin productos' };
    }
    const lineas = [];
    lineas.push('NUEVO PEDIDO - Comdiaz Shop');
    lineas.push('');
    lineas.push('Cliente: ' + nombre);
    lineas.push('');
    lineas.push('Productos:');
    lineas.push('');
    items.forEach((item, i) => {
      const cantidad = Number(item.qty) || 1;
      const precio = Number(item.price) || 0;
      const subtotal = (cantidad * precio).toFixed(2);
      lineas.push((i + 1) + '. ' + String(item.title || 'Producto').slice(0, 80));
      lineas.push('   x' + cantidad + ' x ' + precio.toFixed(2) + ' = ' + subtotal);
    });
    lineas.push('');
    lineas.push('TOTAL: ' + total.toFixed(2));
    if (notas) {
      lineas.push('');
      lineas.push('Notas: ' + notas);
    }
    lineas.push('');
    lineas.push(new Date().toLocaleString('es', { timeZone: 'America/Havana' }));
    const mensaje = lineas.join(String.fromCharCode(10));
    try {
      await notifyTelegram(mensaje);
      app.log.info('Notificacion de pedido enviada');
    } catch(e) {
      app.log.error('Error enviando pedido: ' + e.message);
    }
    logActivity('order', { nombre, items: items.length, total });
    state.orders = state.orders || [];
    const orderId = generarOrderId(state.orders);
    const nuevaOrden = {
      id: orderId,
      nombre,
      whatsapp: String(body.whatsapp || '').slice(0, 20),
      email: String(body.email || '').slice(0, 80),
      direccion: String(body.direccion || '').slice(0, 200),
      notas,
      items,
      total,
      estado: 'pendiente_pago',
      agencia: '',
      tracking: '',
      notasInternas: '',
      historial: [
        { estado: 'pendiente_pago', fecha: new Date().toISOString(), nota: 'Pedido creado' }
      ],
      createdAt: new Date().toISOString(),
      actualizado: new Date().toISOString(),
    };
    state.orders.unshift(nuevaOrden);
    if (state.orders.length > 500) state.orders.length = 500;

    // ─── Registrar pedido en deviceId + referido ───
    const deviceIdOrder = body.deviceId ? String(body.deviceId).slice(0, 60) : null;
    const refOrder = body.ref ? String(body.ref).slice(0, 40) : null;
    if (deviceIdOrder && state.visits?.devices?.[deviceIdOrder]) {
      state.visits.devices[deviceIdOrder].pedidos = (state.visits.devices[deviceIdOrder].pedidos || 0) + 1;
    }
    if (refOrder && state.visits?.referidos?.[refOrder]) {
      state.visits.referidos[refOrder].pedidos = (state.visits.referidos[refOrder].pedidos || 0) + 1;
    }

    await save();
    return { ok: true, orderId };
  } catch (e) {
    app.log.error('Error track-order: ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

// ═══════════════════════════════════════════════
// GESTION DE PEDIDOS (admin + tracking publico)
// ═══════════════════════════════════════════════

app.get('/api/orders', async (req) => {
  const estado = String(req.query?.estado || '').trim();
  let list = state.orders || [];
  if (estado) list = list.filter(o => o.estado === estado);
  return { ok: true, total: list.length, orders: list };
});

app.get('/api/orders/:id', async (req, reply) => {
  const id = String(req.params.id || '').trim();
  const order = (state.orders || []).find(o => String(o.id) === id);
  if (!order) { reply.code(404); return { ok: false, error: 'Pedido no encontrado' }; }
  return { ok: true, order };
});

app.put('/api/orders/:id', async (req, reply) => {
  const id = String(req.params.id || '').trim();
  const idx = (state.orders || []).findIndex(o => String(o.id) === id);
  if (idx === -1) { reply.code(404); return { ok: false, error: 'Pedido no encontrado' }; }
  const body = req.body || {};
  const order = state.orders[idx];
  const estadosValidos = ['pendiente_pago','pagado','en_transito','en_cuba','listo_recoger','entregado','cancelado'];
  if (body.estado && estadosValidos.includes(body.estado) && body.estado !== order.estado) {
    order.historial = order.historial || [];
    order.historial.push({
      estado: body.estado,
      fecha: new Date().toISOString(),
      nota: String(body.notaEstado || '').slice(0, 200),
    });
    order.estado = body.estado;
  }
  if (typeof body.agencia === 'string') order.agencia = body.agencia.slice(0, 60);
  if (typeof body.tracking === 'string') order.tracking = body.tracking.slice(0, 80);
  if (typeof body.notasInternas === 'string') order.notasInternas = body.notasInternas.slice(0, 500);
  order.actualizado = new Date().toISOString();

  // ─── TESORERIA: auto-ingreso cuando el pedido pasa a 'pagado' ───
  if (body.estado === 'pagado' && (!order._txIngreso)) {
    state.tesoreria = state.tesoreria || { movimientos: [] };
    const txId = generarTxId(state.tesoreria.movimientos);
    state.tesoreria.movimientos.unshift({
      id: txId,
      tipo: 'ingreso',
      categoria: 'venta',
      monto: Number(order.total) || 0,
      moneda: 'USD',
      descripcion: 'Venta pedido ' + id + ' (' + (order.nombre || '') + ')',
      orderId: id,
      fecha: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      createdBy: 'auto'
    });
    order._txIngreso = txId;
    logActivity('tesoreria_auto', { txId, orderId: id, monto: order.total });
  }

  // ─── Si se cancela un pedido que ya tenía ingreso → egreso reverso ───
  if (body.estado === 'cancelado' && order._txIngreso && !order._txReverso) {
    state.tesoreria = state.tesoreria || { movimientos: [] };
    const txId = generarTxId(state.tesoreria.movimientos);
    state.tesoreria.movimientos.unshift({
      id: txId,
      tipo: 'egreso',
      categoria: 'cancelacion',
      monto: Number(order.total) || 0,
      moneda: 'USD',
      descripcion: 'Cancelacion pedido ' + id + ' (reverso ' + order._txIngreso + ')',
      orderId: id,
      fecha: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      createdBy: 'auto'
    });
    order._txReverso = txId;
    logActivity('tesoreria_reverso', { txId, orderId: id });
  }

  await save();
  logActivity('order_update', { id, estado: order.estado });

  // Web Push automatico al cambiar estado
  const PUSH_MSGS = {
    pendiente_pago: 'Pedido ' + id + ' recibido. Esperando confirmacion de pago.',
    pagado: 'Pago confirmado del pedido ' + id + '. Ya lo estamos preparando.',
    en_transito: 'Pedido ' + id + ' en camino a Cuba. Tracking: ' + (order.tracking || 'pendiente'),
    en_cuba: 'Pedido ' + id + ' llego a Cuba. Pronto lo recibiras.',
    listo_recoger: 'Pedido ' + id + ' LISTO PARA RECOGER. Escribenos por WhatsApp.',
    entregado: 'Pedido ' + id + ' entregado. Gracias por tu compra.',
    cancelado: 'Pedido ' + id + ' cancelado. Escribenos si tienes dudas.'
  };
  if (body.estado && PUSH_MSGS[body.estado]) {
    sendPushToOrder(id, 'Comdiaz Shop', PUSH_MSGS[body.estado]).catch(e =>
      app.log.warn('Push error: ' + e.message)
    );
  }

  return { ok: true, order };
});

// ═══════════════════════════════════════════════
// WEB PUSH - Suscripciones
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// TEMU - Scraper via Apify
// ═══════════════════════════════════════════════

app.post('/api/temu/search', async (req, reply) => {
  if (!apifyClient) {
    reply.code(503);
    return { ok: false, error: 'Apify no configurado' };
  }
  const body = req.body || {};
  const keyword = String(body.keyword || '').trim();
  const maxResults = Math.min(Math.max(Number(body.maxResults) || 20, 20), 100);
  if (!keyword) {
    reply.code(400);
    return { ok: false, error: 'Falta keyword' };
  }
  try {
    app.log.info('[TEMU] Buscando: ' + keyword);
    const run = await apifyClient.actor('scrapesage/temu-scraper').call({
      searchTerms: [keyword],
      maxResults: maxResults,
      proxyConfig: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
    }, { timeout: 180 });
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    const products = (items || []).map(it => ({
      id: 'temu-' + (it.productId || it.id || Date.now()),
      title: it.title || 'Producto Temu',
      image: it.imageUrl || it.image || '',
      images: it.imageUrl ? [it.imageUrl] : (it.images || []),
      priceBase: Number(it.price || 0),
      url: it.url || '',
      source: 'temu',
      category: 'Importado'
    })).filter(p => p.title && p.priceBase > 0);
    app.log.info('[TEMU] Encontrados: ' + products.length);
    logActivity('temu_search', { keyword, total: products.length });
    return { ok: true, total: products.length, products };
  } catch(e) {
    app.log.error('[TEMU] Error: ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

// ═══════════════════════════════════════════════
// IMPORT HUB - Multi-fuente (Temu, Amazon, Walmart)
// ═══════════════════════════════════════════════

app.get('/api/import/sources', async () => ({
  ok: true,
  sources: Object.entries(SOURCES_CONFIG).map(([key, cfg]) => ({
    id: key,
    label: cfg.label,
    icon: cfg.icon
  }))
}));

app.get('/api/import/config', async () => ({
  ok: true,
  config: state.importConfig || { autoImport: { enabled: false, sources: {} } }
}));

app.post('/api/import/config', async (req) => {
  const body = req.body || {};
  if (body.autoImport) {
    state.importConfig = state.importConfig || {};
    const current = state.importConfig.autoImport || {};
    state.importConfig.autoImport = {
      ...current,
      ...body.autoImport,
      // Asegurar estructura correcta de sources
      sources: body.autoImport.sources
        ? { ...(current.sources || {}), ...body.autoImport.sources }
        : current.sources
    };
  }
  await save();
  logActivity('import_config', { enabled: state.importConfig?.autoImport?.enabled });
  return { ok: true, config: state.importConfig };
});

app.post('/api/import/search', async (req, reply) => {
  if (!isApifyReady()) {
    reply.code(503);
    return { ok: false, error: 'Apify no configurado' };
  }
  const body = req.body || {};
  const source = String(body.source || '').trim();
  const keyword = String(body.keyword || '').trim();
  const maxResults = Math.min(Math.max(Number(body.maxResults) || 20, 1), 100);
  if (!source) { reply.code(400); return { ok: false, error: 'Falta source' }; }
  if (!keyword) { reply.code(400); return { ok: false, error: 'Falta keyword' }; }
  try {
    const products = await searchSource(source, keyword, maxResults);
    logActivity('import_search', { source, keyword, total: products.length });
    return { ok: true, source, keyword, total: products.length, products };
  } catch(e) {
    app.log.error('[IMPORT] Error: ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

app.post('/api/import/run-now', async (req, reply) => {
  const body = req.body || {};
  const source = String(body.source || '').trim();
  const keywords = Array.isArray(body.keywords) ? body.keywords : [];
  const margin = Number(state.margin) || 35; // Unificado con margen global
  const limit = Number(body.limit) || 20;

  if (!source) { reply.code(400); return { ok: false, error: 'Falta source' }; }
  if (!keywords.length) { reply.code(400); return { ok: false, error: 'Faltan keywords' }; }

  const imported = [];
  const errors = [];

  for (const kw of keywords) {
    try {
      const productos = await searchSource(source, kw, limit);
      const nuevos = buildProductsForShop(productos, margin);
      imported.push(...nuevos);
    } catch(e) {
      errors.push({ keyword: kw, error: e.message });
    }
  }

  // Filtrar duplicados (por id)
  state.productosManuales = state.productosManuales || [];
  const idsExistentes = new Set(state.productosManuales.map(p => p.id));
  const nuevosUnicos = imported.filter(p => !idsExistentes.has(p.id));
  state.productosManuales = [...nuevosUnicos, ...state.productosManuales].slice(0, 500);

  await save();
  logActivity('import_run', { source, keywords: keywords.length, imported: nuevosUnicos.length });
  return { ok: true, source, imported: nuevosUnicos.length, errors };
});

// ═══════════════════════════════════════════════
// LIVE SEARCH ALL - Multi-fuente (Temu, Amazon, Walmart)
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// TESORERIA - Movimientos e ingresos/egresos
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// IMPORT MASIVO DE PRODUCTOS (reemplaza la lista completa)
// ═══════════════════════════════════════════════

app.post('/api/products/replace-all', async (req, reply) => {
  const body = req.body || {};
  if (body.confirm !== 'REPLACE') {
    reply.code(400);
    return { ok: false, error: 'Envia { confirm: "REPLACE" } para confirmar' };
  }
  if (!Array.isArray(body.productos)) {
    reply.code(400);
    return { ok: false, error: 'Falta array productos' };
  }
  const antes = (state.productosManuales || []).length;
  state.productosManuales = body.productos.slice(0, 500);
  const despues = state.productosManuales.length;
  await save();
  logActivity('products_replace', { antes, despues });
  return {
    ok: true,
    mensaje: 'Productos reemplazados',
    antes,
    despues
  };
});

// ═══════════════════════════════════════════════
// BACKUP / RESTORE COMPLETO
// ═══════════════════════════════════════════════

app.get('/api/backup/export', async (req, reply) => {
  reply.header('Content-Type', 'application/json');
  reply.header('Content-Disposition', 'attachment; filename="comdiaz-backup-' + new Date().toISOString().slice(0,10) + '.json"');
  // Devolver el state completo
  return state;
});

app.post('/api/backup/import', async (req, reply) => {
  const body = req.body || {};
  if (body.confirm !== 'RESTORE') {
    reply.code(400);
    return { ok: false, error: 'Envia { confirm: "RESTORE" } para confirmar' };
  }
  if (!body.state || typeof body.state !== 'object') {
    reply.code(400);
    return { ok: false, error: 'Falta campo "state" con el backup' };
  }
  const antes = {
    productos: (state.productosManuales || []).length,
    orders: (state.orders || []).length,
    tesoreria: (state.tesoreria?.movimientos || []).length
  };
  // Reemplazar campos clave sin perder otros
  const backup = body.state;
  if (backup.productosManuales) state.productosManuales = backup.productosManuales;
  if (backup.results) state.results = backup.results;
  if (backup.published) state.published = backup.published;
  if (backup.orders) state.orders = backup.orders;
  if (backup.tesoreria) state.tesoreria = backup.tesoreria;
  if (backup.subscriptions) state.subscriptions = backup.subscriptions;
  if (backup.categories) state.categories = backup.categories;
  if (backup.shopConfig) state.shopConfig = backup.shopConfig;
  if (backup.importConfig) state.importConfig = backup.importConfig;
  if (backup.margin !== undefined) state.margin = backup.margin;
  if (backup.featured) state.featured = backup.featured;
  const despues = {
    productos: (state.productosManuales || []).length,
    orders: (state.orders || []).length,
    tesoreria: (state.tesoreria?.movimientos || []).length
  };
  await save();
  logActivity('backup_restore', { antes, despues });
  return { ok: true, mensaje: 'Estado restaurado desde backup', antes, despues };
});

app.get('/api/backup/info', async (req) => {
  return {
    ok: true,
    info: {
      productosManuales: (state.productosManuales || []).length,
      results: (state.results || []).length,
      published: (state.published || []).length,
      orders: (state.orders || []).length,
      tesoreriaMovs: (state.tesoreria?.movimientos || []).length,
      subscriptions: (state.subscriptions || []).length,
      categories: (state.categories || []).length,
      pesoAproxKB: Math.round(JSON.stringify(state).length / 1024)
    }
  };
});

app.get('/api/tesoreria/movimientos', async (req) => {
  const tipo = String(req.query?.tipo || '').trim();
  const categoria = String(req.query?.categoria || '').trim();
  const desde = String(req.query?.desde || '').trim();
  const hasta = String(req.query?.hasta || '').trim();
  let list = (state.tesoreria?.movimientos || []).slice();
  if (tipo) list = list.filter(m => m.tipo === tipo);
  if (categoria) list = list.filter(m => m.categoria === categoria);
  if (desde) list = list.filter(m => (m.fecha || m.createdAt) >= desde);
  if (hasta) list = list.filter(m => (m.fecha || m.createdAt) <= hasta + 'T23:59:59');
  list.sort((a, b) => (b.fecha || b.createdAt || '').localeCompare(a.fecha || a.createdAt || ''));
  return { ok: true, total: list.length, movimientos: list };
});

app.post('/api/tesoreria/movimientos', async (req, reply) => {
  const body = req.body || {};
  const tipo = String(body.tipo || '').trim();
  const categoria = String(body.categoria || 'otro').trim();
  const monto = Number(body.monto);
  const descripcion = String(body.descripcion || '').slice(0, 200);
  const fecha = body.fecha ? String(body.fecha) : new Date().toISOString();

  if (!['ingreso', 'egreso'].includes(tipo)) {
    reply.code(400); return { ok: false, error: 'tipo debe ser ingreso o egreso' };
  }
  if (!monto || monto <= 0) {
    reply.code(400); return { ok: false, error: 'monto debe ser mayor a 0' };
  }

  state.tesoreria = state.tesoreria || { movimientos: [] };
  const id = generarTxId(state.tesoreria.movimientos);
  const mov = {
    id, tipo, categoria, monto,
    moneda: 'USD',
    descripcion,
    orderId: body.orderId || null,
    fecha,
    createdAt: new Date().toISOString(),
    createdBy: 'manual'
  };
  state.tesoreria.movimientos.unshift(mov);
  if (state.tesoreria.movimientos.length > 1000) {
    state.tesoreria.movimientos = state.tesoreria.movimientos.slice(0, 1000);
  }
  await save();
  logActivity('tesoreria_add', { id, tipo, monto });
  return { ok: true, movimiento: mov };
});

app.delete('/api/tesoreria/movimientos/:id', async (req, reply) => {
  const id = String(req.params.id || '').trim();
  const idx = (state.tesoreria?.movimientos || []).findIndex(m => String(m.id) === id);
  if (idx === -1) { reply.code(404); return { ok: false, error: 'Movimiento no encontrado' }; }
  const mov = state.tesoreria.movimientos[idx];
  state.tesoreria.movimientos.splice(idx, 1);
  await save();
  logActivity('tesoreria_delete', { id, monto: mov.monto });
  return { ok: true, deleted: id };
});

app.get('/api/tesoreria/stats', async (req) => {
  const list = state.tesoreria?.movimientos || [];
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  const hoyInicio = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const semanaInicio = new Date(now.getTime() - 7 * dayMs).toISOString();
  const quincenaInicio = new Date(now.getTime() - 15 * dayMs).toISOString();
  const mesInicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const anoInicio = new Date(now.getFullYear(), 0, 1).toISOString();

  function calc(desdeISO) {
    const filtrados = list.filter(m => (m.fecha || m.createdAt) >= desdeISO);
    const ingresos = filtrados.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + Number(m.monto || 0), 0);
    const egresos = filtrados.filter(m => m.tipo === 'egreso').reduce((s, m) => s + Number(m.monto || 0), 0);
    return {
      ingresos: +ingresos.toFixed(2),
      egresos: +egresos.toFixed(2),
      ganancia: +(ingresos - egresos).toFixed(2),
      movimientos: filtrados.length
    };
  }

  const totalIngresos = list.filter(m => m.tipo === 'ingreso').reduce((s, m) => s + Number(m.monto || 0), 0);
  const totalEgresos = list.filter(m => m.tipo === 'egreso').reduce((s, m) => s + Number(m.monto || 0), 0);

  return {
    ok: true,
    balance: +(totalIngresos - totalEgresos).toFixed(2),
    hoy: calc(hoyInicio),
    semana: calc(semanaInicio),
    quincena: calc(quincenaInicio),
    mes: calc(mesInicio),
    ano: calc(anoInicio),
    total: {
      ingresos: +totalIngresos.toFixed(2),
      egresos: +totalEgresos.toFixed(2),
      ganancia: +(totalIngresos - totalEgresos).toFixed(2),
      movimientos: list.length
    }
  };
});

app.get('/api/public/live-search-all', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  const query = String(req.query?.q || '').trim();
  if (!query || query.length < 2) {
    reply.code(400);
    return { ok: false, error: 'Escribe al menos 2 caracteres' };
  }

  // Rate limit: max 3 busquedas multi-fuente por minuto por IP
  const ip = req.headers['cf-connecting-ip'] ||
             req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.ip || 'desconocida';
  const key = ip + ':livesearch-all';
  const ahora = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, resetAt: ahora + 60000 };
  if (ahora > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = ahora + 60000;
  }
  entry.count++;
  rateLimitMap.set(key, entry);

  if (entry.count > 3) {
    reply.code(429);
    return { ok: false, error: 'Demasiadas busquedas. Espera 1 minuto.' };
  }

  if (!isApifyReady()) {
    reply.code(503);
    return { ok: false, error: 'Apify no configurado' };
  }

  const margenActual = Number(state.margin) || 35;
  const fuentes = ['temu', 'amazon', 'walmart'];

  // Buscar en paralelo con timeout individual
  const promesas = fuentes.map(async (src) => {
    try {
      const timeoutPromise = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Timeout')), 25000)
      );
      const searchPromise = searchSource(src, query, 10);
      const productos = await Promise.race([searchPromise, timeoutPromise]);
      return { source: src, productos: productos || [], error: null };
    } catch (e) {
      return { source: src, productos: [], error: e.message };
    }
  });

  const resultados = await Promise.all(promesas);

  // Aplanar todos los productos
  const todos = [];
  const errores = [];
  for (const r of resultados) {
    if (r.error) {
      errores.push({ source: r.source, error: r.error });
    } else {
      todos.push(...r.productos);
    }
  }

  // Formatear con margen y campos para la Shop
  const productos = todos.map(p => ({
    id: 'live-' + p.source + '-' + (p.id || Date.now()) + '-' + Math.random().toString(36).slice(2, 6),
    title: p.title,
    image: p.image,
    images: p.images || [p.image],
    salePrice: +(Number(p.priceBase) * (1 + margenActual / 100)).toFixed(2),
    category: p.category || 'Importado',
    source: p.source,
    url: p.url
  }));

  app.log.info('[LIVE-ALL] ' + query + ' -> ' + productos.length + ' resultados de ' + fuentes.length + ' fuentes');

  return {
    ok: true,
    query,
    total: productos.length,
    products: productos,
    errors: errores.length ? errores : undefined
  };
});

// ═══════════════════════════════════════════════
// FORZAR BUSQUEDA MANUAL
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// AUTO-UPDATE APK
// ═══════════════════════════════════════════════

app.get('/api/app-version', async (req) => {
  // Detectar version instalada desde User-Agent
  const ua = String(req.headers['user-agent'] || '');
  let installedVersion = null;
  let isTWA = false;

  // Formato: com.comdiaz.shop.twa/1
  const m = ua.match(/com\.comdiaz\.shop\.twa\/(\d+)/);
  if (m) {
    installedVersion = Number(m[1]);
    isTWA = true;
  }

  const cfg = state.appVersion || { version: 1, versionName: '1.0.0', url: '', notas: '' };
  const needsUpdate = isTWA && installedVersion !== null && installedVersion < Number(cfg.version);

  return {
    ok: true,
    // Info de la ultima version disponible
    latest: {
      version: Number(cfg.version) || 1,
      versionName: cfg.versionName || '1.0.0',
      url: cfg.url || '',
      notas: cfg.notas || '',
      fecha: cfg.fecha || null
    },
    // Info de la version instalada (si es APK)
    installed: {
      isTWA: isTWA,
      version: installedVersion
    },
    needsUpdate: needsUpdate
  };
});

app.post('/api/app-version', async (req, reply) => {
  const body = req.body || {};
  const version = Number(body.version);
  const versionName = String(body.versionName || '').trim();
  const url = String(body.url || '').trim();
  const notas = String(body.notas || '').slice(0, 500);

  if (!version || version < 1) {
    reply.code(400);
    return { ok: false, error: 'version debe ser un numero >= 1' };
  }
  if (!versionName) {
    reply.code(400);
    return { ok: false, error: 'Falta versionName' };
  }

  state.appVersion = {
    version,
    versionName,
    url,
    notas,
    fecha: new Date().toISOString()
  };
  await save();
  logActivity('app_version_update', { version, versionName });
  return { ok: true, appVersion: state.appVersion };
});

app.post('/api/search/run-now', async (req, reply) => {
  // Responder inmediatamente (Cloudflare corta a los 100s)
  const running = state._searchRunning === true;
  if (running) {
    return { ok: true, mensaje: 'Ya hay una busqueda en curso', enCurso: true };
  }
  state._searchRunning = true;
  state._searchStartedAt = new Date().toISOString();

  // Ejecutar en background sin bloquear la respuesta
  (async () => {
    try {
      app.log.info('[MANUAL] Ejecutando runSearch en background...');
      const count = await runSearch('manual-api');
      app.log.info('[MANUAL] Completado: ' + count + ' productos');
    } catch(e) {
      app.log.error('[MANUAL] Error: ' + e.message);
    } finally {
      state._searchRunning = false;
      state._searchFinishedAt = new Date().toISOString();
    }
  })();

  return {
    ok: true,
    mensaje: 'Busqueda iniciada en background. Consulta /api/search/status en 1-3 min.',
    enCurso: true
  };
});

// Estado de la busqueda en curso
app.get('/api/search/status', async () => ({
  ok: true,
  enCurso: state._searchRunning === true,
  iniciada: state._searchStartedAt || null,
  finalizada: state._searchFinishedAt || null,
  productos: (state.results || []).length,
  publicados: (state.published || []).length
}));

app.get('/api/public/vapid-key', async () => ({
  ok: true,
  publicKey: VAPID_PUBLIC
}));

app.post('/api/public/subscribe', async (req, reply) => {
  const body = req.body || {};
  const orderId = String(body.orderId || '').trim();
  const whatsapp = String(body.whatsapp || '').replace(/[^0-9]/g, '');
  const subscription = body.subscription;
  if (!subscription || !subscription.endpoint) {
    reply.code(400);
    return { ok: false, error: 'Falta subscription' };
  }
  if (!orderId && !whatsapp) {
    reply.code(400);
    return { ok: false, error: 'Falta orderId o whatsapp' };
  }
  state.subscriptions = state.subscriptions || [];
  // Eliminar suscripciones viejas del mismo endpoint
  state.subscriptions = state.subscriptions.filter(s =>
    s.subscription?.endpoint !== subscription.endpoint
  );
  state.subscriptions.push({
    orderId,
    whatsapp,
    subscription,
    createdAt: new Date().toISOString()
  });
  if (state.subscriptions.length > 1000) {
    state.subscriptions = state.subscriptions.slice(-1000);
  }
  await save();
  logActivity('push_subscribe', { orderId, whatsapp: whatsapp ? '***' + whatsapp.slice(-4) : '' });
  return { ok: true, total: state.subscriptions.length };
});

app.post('/api/public/unsubscribe', async (req, reply) => {
  const body = req.body || {};
  const endpoint = String(body.endpoint || '').trim();
  if (!endpoint) { reply.code(400); return { ok: false, error: 'Falta endpoint' }; }
  state.subscriptions = (state.subscriptions || []).filter(s => s.subscription?.endpoint !== endpoint);
  await save();
  return { ok: true };
});

// ═══════════════════════════════════════════════
// DELETE de pedido (solo admin)
// ═══════════════════════════════════════════════

// Alias POST para DELETE (evita bloqueos de proxies/CDN con DELETE)
app.post('/api/orders/:id/delete', async (req, reply) => {
  const id = String(req.params.id || '').trim();
  const idx = (state.orders || []).findIndex(o => String(o.id) === id);
  if (idx === -1) { reply.code(404); return { ok: false, error: 'Pedido no encontrado' }; }
  const eliminado = state.orders[idx];
  state.orders.splice(idx, 1);
  await save();
  logActivity('order_delete', { id, total: eliminado.total });
  return { ok: true, deleted: id };
});

app.delete('/api/orders/:id', async (req, reply) => {
  const id = String(req.params.id || '').trim();
  const idx = (state.orders || []).findIndex(o => String(o.id) === id);
  if (idx === -1) { reply.code(404); return { ok: false, error: 'Pedido no encontrado' }; }
  const eliminado = state.orders[idx];
  state.orders.splice(idx, 1);
  await save();
  logActivity('order_delete', { id, total: eliminado.total });
  return { ok: true, deleted: id };
});

// ═══════════════════════════════════════════════
// Eliminar TODOS los pedidos entregados/cancelados (limpieza)
// ═══════════════════════════════════════════════

app.post('/api/orders/clean-old', async (req) => {
  const antes = (state.orders || []).length;
  state.orders = (state.orders || []).filter(o => o.estado !== 'entregado' && o.estado !== 'cancelado');
  const despues = state.orders.length;
  await save();
  logActivity('order_clean', { eliminados: antes - despues });
  return { ok: true, eliminados: antes - despues, total: despues };
});

// ═══════════════════════════════════════════════
// HISTORIAL DE PEDIDOS (requiere WhatsApp + ID de pedido)
// ═══════════════════════════════════════════════

app.post('/api/public/orders/verify', async (req, reply) => {
  const body = req.body || {};
  const wa = String(body.whatsapp || '').replace(/[^0-9]/g, '');
  const verifyId = String(body.pedidoId || '').trim().toUpperCase();
  const verifyIdAlt = String(body.pedidoId || '').trim(); // sin uppercase por si acaso

  if (!wa || wa.length < 8) {
    reply.code(400);
    return { ok: false, error: 'WhatsApp invalido' };
  }
  if (!verifyId) {
    reply.code(400);
    return { ok: false, error: 'Ingresa el ID de uno de tus pedidos' };
  }

  // Buscar el pedido de referencia (por ID)
  const refOrder = (state.orders || []).find(o =>
    String(o.id).toUpperCase() === verifyId || String(o.id) === verifyIdAlt
  );
  if (!refOrder) {
    reply.code(404);
    return { ok: false, error: 'Pedido ' + verifyId + ' no existe' };
  }

  // Validar que ese pedido pertenece a ese WhatsApp
  const refWa = String(refOrder.whatsapp || '').replace(/[^0-9]/g, '');
  if (refWa !== wa) {
    reply.code(403);
    return { ok: false, error: 'El WhatsApp no coincide con ese pedido' };
  }

  // OK - WhatsApp verificado. Devolver TODOS los pedidos de ese WhatsApp
  const todos = (state.orders || []).filter(o => {
    const ow = String(o.whatsapp || '').replace(/[^0-9]/g, '');
    return ow === wa;
  });
  // Ordenar por fecha (mas reciente primero)
  todos.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  // Devolver solo datos publicos (sin notas internas ni whatsapp completo)
  const pedidos = todos.map(o => ({
    id: o.id,
    nombre: o.nombre,
    estado: o.estado,
    agencia: o.agencia || '',
    tracking: o.tracking || '',
    total: o.total,
    items: (o.items || []).map(it => ({
      title: it.title,
      qty: it.qty || 1,
      price: it.price
    })),
    historial: o.historial || [],
    createdAt: o.createdAt,
    actualizado: o.actualizado
  }));

  return {
    ok: true,
    total: pedidos.length,
    whatsapp: wa.slice(0, 4) + '****' + wa.slice(-2),
    pedidos
  };
});

app.get('/api/public/order/:id', async (req, reply) => {
  const id = String(req.params.id || '').trim();
  const order = (state.orders || []).find(o => String(o.id) === id);
  if (!order) { reply.code(404); return { ok: false, error: 'Pedido no encontrado' }; }
  return {
    ok: true,
    order: {
      id: order.id,
      nombre: order.nombre,
      estado: order.estado,
      agencia: order.agencia,
      tracking: order.tracking,
      historial: order.historial || [],
      total: order.total,
      createdAt: order.createdAt,
      actualizado: order.actualizado,
    }
  };
});



app.post('/api/force-save', async () => {
  const r = {};
  try {
    r.guardarDirecto = await guardarEstado({ test: 'diag', ts: Date.now() });
    const esencia = {
      margin: state.margin,
      pin: state.pin,
      categories: state.categories,
      shopConfig: state.shopConfig,
      automation: {
        running: state.automation.running,
        delaySeconds: state.automation.delaySeconds,
        publishTimes: state.automation.publishTimes,
      },
      sources: state.sources,
      published: (state.published || []).slice(0, 100),
      productosManuales: state.productosManuales || [],
      orders: (state.orders || []).slice(0, 20),
      subscriptions: (state.subscriptions || []).slice(-50),
      visits: state.visits,
    };
    r.tamanoEsencia = JSON.stringify(esencia).length;
    r.guardarEsencia = await guardarEstado(esencia);
    r.leido = await leerEstado();
  } catch(e) {
    r.error = e.message;
  }
  return r;
});

// DESTACADOS
app.post('/api/featured/toggle', async (req) => {
  const id = String(req.body?.id || '').trim();
  if (!id) return { ok: false, error: 'id requerido' };
  state.featured = state.featured || [];
  const idx = state.featured.indexOf(id);
  if (idx === -1) {
    state.featured.push(id);
    logActivity('featured_add', { id });
  } else {
    state.featured.splice(idx, 1);
    logActivity('featured_remove', { id });
  }
  await save();
  return { ok: true, total: state.featured.length };
});

app.get('/api/featured', async () => ({
  ok: true,
  total: (state.featured || []).length,
  ids: state.featured || [],
}));

const PORT = process.env.PORT || 3000;

// Auto-búsqueda al arrancar si no hay productos
async function autoSearchOnStart() {
  try {
    const actual = (state.results || []).length;
    if (actual < 500) {
      app.log.info('Solo ' + actual + ' productos en memoria. Regenerando catalogo...');
      await runSearch('auto-start');
      app.log.info('Auto-busqueda completada: ' + state.results.length + ' productos');
    } else {
      app.log.info('Ya hay ' + actual + ' productos, no se regenera al arrancar');
    }
  } catch (e) {
    app.log.error('Error en auto-busqueda: ' + e.message);
  }
}

cargarDesdeNube().then(() => {
  app.listen({ port: PORT, host: '0.0.0.0' }, () => {
  console.log(BRAND);
  console.log(`Comdiaz backend en http://localhost:${PORT}`);
  console.log(`Categorías activas: ${state.categories.length}`);
  console.log(`Margen: ${state.margin}%`);
  console.log(`Publicaciones: ${state.automation.publishTimes.join(' · ')}`);
  console.log(`Estado: ${state.automation.running ? 'ACTIVO' : 'EN PAUSA'}\n`);
  schedule();
  setTimeout(autoSearchOnStart, 5000);
});
});
