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
// Migrado de jsonbin.js -> state-store.js (GitHub Storage)
import { leerEstado, guardarEstado, isJSONBinConfigured } from './state-store.js';
import { preguntarIA } from './ai.js';
import { ApifyClient } from 'apify-client';
import { initApify, isApifyReady, searchSource, buildProductsForShop, SOURCES_CONFIG } from './import.js';
import webpush from 'web-push';

import { dbSelect, dbSelectOne, dbInsert, dbUpdate, dbCount, dbHealth } from './supabase.js';
import { hashPassword, verifyPassword, createJWT, verifyJWT, getTokenFromRequest, requireSeller, requireAdmin, validarTelefono, normalizarTelefono } from './auth.js';

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
  if (req.url.startsWith('/api/seller/')) return;  // vendedores usan JWT propio
  // /api/upload-image: aceptar admin (X-Comdiaz-Key) O seller (Bearer JWT válido)
  if (req.url.startsWith('/api/upload-image')) {
    try { const sp = requireSeller(req); if (sp && sp.sellerId) return; } catch(_) {}
    // Si no es seller, cae al gate normal (X-Comdiaz-Key admin)
  }
  if (req.url.startsWith('/api/product/whatsapp/')) return;  // público: compradores
  if (req.url.startsWith('/api/track-visit')) return;
  if (req.url.startsWith('/api/track-order')) return;
  if (req.url.startsWith('/api/public/')) return;
  if (req.url.startsWith('/ebay-notification')) return;
  if (req.url.startsWith('/api/pin/change')) return;
  if (req.url.startsWith('/api/app-version') && req.method === 'GET') return;
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
  const allowed = [
    "https://com-diaz-web.onrender.com",
    "https://com-diaz.onrender.com",
    "http://com-diaz-web.onrender.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    // Orígenes de WebView (APK privada)
    "capacitor://localhost",
    "ionic://localhost",
    "file://",
    "null",
    "https://localhost",
    "http://localhost",
  ];
  // Si el origin está en la lista → reflejar. Si no → reflejar también (para APK privada)
  const allowOrigin = origin && origin !== '' ? origin : "https://com-diaz-web.onrender.com";
  reply.header("Access-Control-Allow-Origin", allowOrigin);
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Comdiaz-Key');
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

const CUBA_UBICACIONES = {
  "Pinar del Río": ["Consolación del Sur","Guane","La Palma","Los Palacios","Mantua","Minas de Matahambre","Pinar del Río","San Juan y Martínez","San Luis","Sandino","Viñales"],
  "Artemisa": ["Alquízar","Artemisa","Bauta","Caimito","Candelaria","Guanajay","Güira de Melena","Mariel","San Antonio de los Baños","San Cristóbal","Bahía Honda"],
  "La Habana": ["Arroyo Naranjo","Boyeros","Centro Habana","Cerro","Cotorro","Diez de Octubre","Guanabacoa","Habana del Este","Habana Vieja","La Lisa","Marianao","Playa","Plaza de la Revolución","Regla","San Miguel del Padrón"],
  "Mayabeque": ["Batabanó","Bejucal","Güines","Jaruco","Madruga","Melena del Sur","Nueva Paz","Quivicán","San José de las Lajas","San Nicolás","Santa Cruz del Norte"],
  "Matanzas": ["Calimete","Cárdenas","Ciénaga de Zapata","Colón","Jagüey Grande","Jovellanos","Limonar","Los Arabos","Martí","Matanzas","Pedro Betancourt","Perico","Unión de Reyes"],
  "Villa Clara": ["Caibarién","Camajuaní","Cifuentes","Corralillo","Encrucijada","Manicaragua","Placetas","Quemado de Güines","Ranchuelo","Remedios","Sagua la Grande","Santa Clara","Santo Domingo"],
  "Cienfuegos": ["Abreus","Aguada de Pasajeros","Cienfuegos","Cruces","Cumanayagua","Lajas","Palmira","Rodas"],
  "Sancti Spíritus": ["Cabaiguán","Fomento","Jatibonico","La Sierpe","Sancti Spíritus","Taguasco","Trinidad","Yaguajay"],
  "Ciego de Ávila": ["Baraguá","Bolivia","Chambas","Ciego de Ávila","Ciro Redondo","Florencia","Majagua","Morón","Primero de Enero","Venezuela"],
  "Camagüey": ["Camagüey","Carlos Manuel de Céspedes","Esmeralda","Florida","Guáimaro","Jimaguayú","Minas","Najasa","Nuevitas","Santa Cruz del Sur","Sibanicú","Sierra de Cubitas","Vertientes"],
  "Las Tunas": ["Amancio","Colombia","Jesús Menéndez","Jobabo","Las Tunas","Majibacoa","Manatí","Puerto Padre"],
  "Holguín": ["Antilla","Báguanos","Banes","Cacocum","Calixto García","Cueto","Frank País","Gibara","Holguín","Mayarí","Moa","Rafael Freyre","Sagua de Tánamo","Urbano Noris"],
  "Granma": ["Bartolomé Masó","Bayamo","Buey Arriba","Campechuela","Cauto Cristo","Guisa","Jiguaní","Manzanillo","Media Luna","Niquero","Pilón","Río Cauto","Yara"],
  "Santiago de Cuba": ["Contramaestre","Guamá","Mella","Palma Soriano","San Luis","Santiago de Cuba","Segundo Frente","Songo-La Maya","Tercer Frente"],
  "Guantánamo": ["Baracoa","Caimanera","El Salvador","Guantánamo","Imías","Maisí","Manuel Tames","Niceto Pérez","San Antonio del Sur","Yateras"],
  "Isla de la Juventud": ["Isla de la Juventud"]
};

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
    // Frases generadas por IA (se rotan junto a las promociones)
    aiBanners: [],
    aiBannersUpdated: null,
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
  sre: {
    snapshots: [],       // últimos 20 snapshots (10 horas)
    alerts: [],          // últimas 50 alertas
    lastCheck: null,
    lastSnapshot: null,
    pausedCrons: {},     // { cleanup: true, purga: false, ... }
    telegramChatId: null,
    telegramEnabled: false,
  },
  shopStats: {
    totalActivos: 0,
    totalInactivos: 0,
    totalEliminados: 0,
    porCategoria: {},
    crecimiento: [],
    ultimaPurga: null,
  },
  deletedHistory: [],
  dailySuffixes: {
    '1': ' deals',
    '2': ' ofertas',
    '3': ' new arrival',
    '4': ' sale',
    '5': ' trending',
    '6': ' clearance',
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
        state.results = mergeProducts(state.results || [], remoto.results);
        app.log.info('Merge ' + remoto.results.length + ' desde JSONBin -> total ' + state.results.length);
      }
      if (remoto.visits) state.visits = remoto.visits;
      app.log.info("Config cargada desde JSONBin");
      
      // ═══ FUSIÓN AUTOMÁTICA DE LOCALES DESDE BACKUP ═══
      try {
        const backupLocales = await leerBackupLocales();
        if (backupLocales && backupLocales.productos && backupLocales.productos.length > 0) {
          const existentes = new Set((state.productosManuales || []).map(p => p.id));
          let fusionados = 0;
          for (const p of backupLocales.productos) {
            if (!existentes.has(p.id)) {
              state.productosManuales = state.productosManuales || [];
              state.productosManuales.push(p);
              fusionados++;
            }
          }
          if (fusionados > 0) {
            app.log.info('[FUSION-LOCALES] ' + fusionados + ' locales recuperados del backup');
            await save();
          }
        }
      } catch(e) {
        app.log.warn('[FUSION-LOCALES] Error: ' + e.message);
      }
      
      return true;
    }
  } catch(e) {
    app.log.error("Error cargando JSONBin: " + e.message);
  }
  return false;
}

// Leer el backup de locales desde GitHub
async function leerBackupLocales() {
  try {
    const GITHUB_API = 'https://api.github.com';
    const FILE_PATH = 'locals-backup.json';
    const token = process.env.GITHUB_STATE_TOKEN;
    const repo = process.env.GITHUB_STATE_REPO;
    if (!token || !repo) return null;
    const url = GITHUB_API + '/repos/' + repo + '/contents/' + FILE_PATH;
    const res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'comdiaz-backend',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const zlib = await import('zlib');
    const gz = Buffer.from(data.content, 'base64');
    const json = zlib.gunzipSync(gz).toString('utf8');
    return JSON.parse(json);
  } catch(e) {
    return null;
  }
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
      published: (state.published || []).slice(0, 10000),
      // Guardar solo los ultimos 100 productos eBay (publicados) para recuperar tras reinicio
      results: (state.results || []).slice(0, 10000).map(r => ({
        id: r.id,
        title: (r.title || '').slice(0, 120),
        aiTitulo: r.aiTitulo || null,
        aiDescripcion: r.aiDescripcion || null,
        aiUpdatedAt: r.aiUpdatedAt || null,
        image: r.image,
        salePrice: r.salePrice,
        basePrice: r.basePrice,
        category: r.category,
        source: r.source,
        url: r.url,
        primeraVez: r.primeraVez || null,
        ultimaVez: r.ultimaVez || null,
        vecesVisto: r.vecesVisto || 1,
        activo: r.activo !== false,
        prioridad: r.prioridad || 'normal',
      })),
      productosManuales: (state.productosManuales || []).slice(0, 5000).map(p => ({
        id: p.id,
        title: (p.title || '').slice(0, 150),
        image: p.image,
        imagePrincipal: p.imagePrincipal || p.image,
        images: Array.isArray(p.images) ? p.images.slice(0, 8) : (p.image ? [p.image] : []),
        category: p.category,
        description: (p.description || '').slice(0, 2000),
        // Precios
        priceBase: p.priceBase,
        salePrice: p.salePrice,
        margenPct: p.margenPct,
        precioUSD: p.precioUSD || null,
        precioCUP: p.precioCUP || null,
        precioDirecto: p.precioDirecto || false,
        // Stock y ubicación
        cantidad: p.cantidad,
        tipo: p.tipo || null,
        provincia: p.provincia || null,
        municipio: p.municipio || null,
        estado: p.estado || null,
        // Notas y flags
        notas: p.notas || null,
        publicado: p.publicado,
        destacado: p.destacado || false,
        // Origen y meta
        source: p.source,
        sourceUrl: p.sourceUrl,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt || null
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
    // ═══ BACKUP REDUNDANTE: solo locales, archivo separado ═══
    try {
      const locales = (state.productosManuales || []).filter(p => p.tipo === 'local');
      if (locales.length > 0) {
        const backupLocales = {
          _ts: new Date().toISOString(),
          total: locales.length,
          productos: locales,
        };
        await guardarEstadoBackup(backupLocales);
      }
    } catch(e) {
      app.log.warn('[BACKUP-LOCALES] Fallo backup redundante: ' + e.message);
    }
  }
}

// Guardar backup de locales en archivo separado (máxima seguridad)
async function guardarEstadoBackup(backup) {
  try {
    const GITHUB_API = 'https://api.github.com';
    const FILE_PATH = 'locals-backup.json';
    const token = process.env.GITHUB_STATE_TOKEN;
    const repo = process.env.GITHUB_STATE_REPO;
    if (!token || !repo) return;
    const zlib = await import('zlib');
    const json = JSON.stringify(backup);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    const b64 = gz.toString('base64');
    const url = GITHUB_API + '/repos/' + repo + '/contents/' + FILE_PATH;
    const headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'comdiaz-backend',
    };
    let sha = null;
    const getRes = await fetch(url, { headers });
    if (getRes.ok) { const ex = await getRes.json(); sha = ex.sha; }
    const body = {
      message: 'backup locals ' + new Date().toISOString(),
      content: b64,
      committer: { name: 'Comdiaz Backend', email: 'backend@comdiaz.com' },
    };
    if (sha) body.sha = sha;
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (putRes.ok) {
      app.log.info('[BACKUP-LOCALES] ' + backup.total + ' locales guardados (' + Math.round(gz.length/1024) + ' KB)');
    }
  } catch(e) {
    app.log.warn('[BACKUP-LOCALES] ' + e.message);
  }
}

// ═══ SCORE de producto (para purga inteligente) ═══
function calculateScore(p) {
  if (!p) return 0;
  const hoy = Date.now();
  const ultimo = p.ultimaVez ? new Date(p.ultimaVez).getTime() : 0;
  const diasSinVerVal = ultimo ? Math.floor((hoy - ultimo) / 86400000) : 999;
  const prioridadBonus = { 'rebaja': 15, 'oferta': 10, 'nuevo': 5, 'normal': 0 };
  const ventas = Number(p.ventasCount || 0);
  const vistas = Number(p.vistasProducto || 0);
  const vv = Number(p.vecesVisto || 1);
  const recenciaBonus = diasSinVerVal <= 7 ? 10 : 0;
  let score = 0;
  score += vv * 5;
  score += p.aiTitulo ? 20 : 0;
  score += prioridadBonus[p.prioridad] || 0;
  score += ventas * 50;
  score += vistas * 2;
  score += recenciaBonus;
  score -= Math.min(diasSinVerVal, 365);
  return Math.round(score);
}

function diasSinVer(p) {
  if (!p) return 0;
  // Si no tiene ultimaVez, NUNCA inactivar (evita borrar productos no verificados)
  if (!p.ultimaVez) return 0;
  const ms = Date.now() - new Date(p.ultimaVez).getTime();
  return Math.floor(ms / 86400000);
}

// ═══ MERGE de productos preservando IA ═══
function mergeProducts(existentes, nuevos) {
  const hoy = new Date().toISOString().slice(0, 10);
  const map = new Map((existentes || []).map(p => [p.id, p]));
  let nuevosCount = 0, actCount = 0, iaPreservada = 0;
  for (const n of nuevos) {
    if (!n || !n.id) continue;
    const prev = map.get(n.id);
    if (prev) {
      const esRebaja = n.salePrice && prev.salePrice && n.salePrice < prev.salePrice;
      map.set(n.id, {
        ...prev, ...n,
        aiTitulo: prev.aiTitulo || null,
        aiDescripcion: prev.aiDescripcion || null,
        aiUpdatedAt: prev.aiUpdatedAt || null,
        primeraVez: prev.primeraVez || hoy,
        ultimaVez: hoy,
        vecesVisto: (prev.vecesVisto || 1) + 1,
        activo: true,
        prioridad: esRebaja ? 'rebaja' : (prev.prioridad || 'normal'),
      });
      actCount++;
      if (prev.aiTitulo) iaPreservada++;
    } else {
      map.set(n.id, {
        ...n,
        primeraVez: n.primeraVez || hoy,
        ultimaVez: hoy,
        vecesVisto: (n.vecesVisto || 1),
        activo: n.activo !== false,
        prioridad: n.prioridad || 'nuevo',
        // PRESERVAR IA del objeto entrante (al cargar de GitHub)
        aiTitulo: n.aiTitulo || null,
        aiDescripcion: n.aiDescripcion || null,
        aiUpdatedAt: n.aiUpdatedAt || null,
      });
      nuevosCount++;
    }
  }
  console.log('[MERGE] +' + nuevosCount + ' nuevos, ' + actCount + ' actualizados, ' + iaPreservada + ' IA preservada');
  return [...map.values()];
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
  // SOLO sobrescribir si hay resultados nuevos (evita borrar catalogo por error)
  if (unique && unique.length > 0) {
    {
      const antes = (state.results || []).length;
      state.results = mergeProducts(state.results || [], unique);
      const pubSet = new Set(state.published || []);
      for (const r of state.results) if (r.activo !== false) pubSet.add(r.id);
      state.published = [...pubSet];
      app.log.info('Merge: ' + antes + ' -> ' + state.results.length + ' productos');
    }
    app.log.info('Resultados guardados: ' + unique.length + ' | Publicados: ' + state.published.length);
  } else {
    app.log.warn('runSearch devolvio 0 productos - NO se sobrescribe state.results (proteccion)');
  }
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
  if (task) { task.stop(); task = null; }
  const times = state.automation.publishTimes || [];
  if (!times.length) {
    app.log.info('[CRON-PUB] Sin horarios configurados (desactivado)');
    state.automation.nextRuns = [];
    return;
  }
  const expr = timesToCron(times);
  app.log.info(`Comdiaz · cron "${expr}" (${times.join(', ')})`);

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

// ═══════════════════════════════════════════════
// PROCESAMIENTO AUTOMATICO DE IA (cron cada 6h)
// ═══════════════════════════════════════════════

let iaTask = null;
let iaProcesando = false;

// ═══ DESCRIPCIONES DE PRODUCTOS LOCALES (pool BULK) ═══
async function procesarDescripcionesLocales(max = 100) {
  if (typeof iaLocalProcesando !== 'undefined' && iaLocalProcesando) {
    app.log.info('[IA-LOCAL] Ya hay un proceso en curso, saltando');
    return { procesados: 0, saltado: true };
  }
  global.iaLocalProcesando = true;
  const inicio = Date.now();
  let procesados = 0;
  let errores = 0;

  try {
    // Solo productos locales activos SIN aiDescripcion
    const pendientes = (state.productosManuales || [])
      .filter(p => 
        p.tipo === 'local' && 
        p.publicado !== false && 
        p.title && 
        !p.aiDescripcion
      )
      .slice(0, max);
    
    app.log.info('[IA-LOCAL] Pendientes sin descripción: ' + pendientes.length + ' (max ' + max + ')');

    for (let i = 0; i < pendientes.length; i++) {
      const prod = pendientes[i];
      try {
        const prompt = 'Eres redactor de una tienda en línea que vende a clientes en Cuba. ' +
          'Genera una descripción atractiva y breve (2 o 3 frases, máximo 400 caracteres) para este producto. ' +
          'Sin inventar medidas, marcas ni características que no estén en los datos. ' +
          'En español, claro, sin emojis excesivos. ' +
          'Producto: ' + String(prod.title || '').slice(0, 200) + '. ' +
          'Categoría: ' + String(prod.category || 'General') + '. ' +
          'Precio: $' + (prod.salePrice || 0) + ' USD. ' +
          'Estado: ' + (prod.estado || 'nuevo') + '. ' +
          'Provincia: ' + (prod.provincia || 'Cuba') + '.';

        const desc = await preguntarIA(prompt, { 
          json: false, 
          pool: 'bulk'  // ← usa las 3 keys BULK
        });

        if (desc && String(desc).trim().length > 20) {
          const ref = (state.productosManuales || []).find(p => p.id === prod.id);
          if (ref) {
            ref.aiDescripcion = String(desc).trim().slice(0, 500);
            ref.aiDescripcionUpdated = new Date().toISOString();
            aiResetIfNewDay();
            aiUsageCounters.descripcion++;
            procesados++;
          }
        }

        // Guardar cada 5 productos
        if (procesados > 0 && procesados % 5 === 0) {
          await save();
        }

        // Rate limit: ~3s entre peticiones
        await new Promise(s => setTimeout(s, 3000));
      } catch (e) {
        errores++;
        app.log.error('[IA-LOCAL] Error en ' + prod.id + ': ' + e.message);
        if (errores >= 5 && errores % 5 === 0) {
          app.log.warn('[IA-LOCAL] 5 errores, esperando 60s...');
          await new Promise(s => setTimeout(s, 60000));
        }
      }
    }

    if (procesados > 0) await save();

    const dur = Math.round((Date.now() - inicio) / 1000);
    app.log.info('[IA-LOCAL] Completado: ' + procesados + ' procesados, ' + errores + ' errores, ' + dur + 's');
    logActivity('ia_local_desc', { procesados, errores, dur });
    
    if (procesados > 0) {
      notifyTelegram('📝 <b>DESCRIPCIONES LOCALES</b>\n\n' +
        '✅ Procesadas: ' + procesados + '\n' +
        '❌ Errores: ' + errores + '\n' +
        '⏱ Duración: ' + dur + 's').catch(() => {});
    }

    return { procesados, errores, dur };
  } finally {
    global.iaLocalProcesando = false;
  }
}

async function procesarProductosSinIA(max = 100) {
  if (iaProcesando) {
    app.log.info('[IA-AUTO] Ya hay un proceso en curso, saltando');
    return { procesados: 0, saltado: true };
  }
  iaProcesando = true;
  const inicio = Date.now();
  let procesados = 0;
  let errores = 0;

  try {
    const todos = [...(state.results || []), ...(state.productosManuales || [])];
    const sinIA = todos
      .filter(p => p.activo !== false && p.title && (!p.aiTitulo || String(p.aiTitulo).trim() === ''))
      .sort((a, b) => {
        const orden = { 'rebaja': 0, 'oferta': 1, 'nuevo': 2, 'normal': 3 };
        return (orden[a.prioridad] ?? 3) - (orden[b.prioridad] ?? 3);
      })
      .slice(0, max);
    app.log.info('[IA-AUTO] Pendientes sin IA: ' + sinIA.length + ' (max ' + max + ')');

    for (let i = 0; i < sinIA.length; i++) {
      const p = sinIA[i];
      try {
        const prompt = 'Eres redactor de una tienda en linea que vende a clientes en Cuba. ' +
          'Mejora este producto. Devuelve SOLO un JSON con dos campos: ' +
          '"titulo" (maximo 70 caracteres, claro, en espanol, sin emojis ni mayusculas excesivas) y ' +
          '"descripcion" (2 o 3 frases, maximo 400 caracteres, sin inventar medidas, marcas ni caracteristicas que no esten en los datos). ' +
          'Datos del producto. Titulo original: ' + String(p.title || '').slice(0, 200) +
          '. Categoria: ' + String(p.category || p.source || '') + '.';

        const txt = await preguntarIA(prompt, { json: true });
        const out = JSON.parse(String(txt).replace(/```json|```/g, '').trim());

        // Buscar el producto por ID en ambas listas y actualizar
        const enResults = (state.results || []).find(r => r.id === p.id);
        const enManuales = (state.productosManuales || []).find(r => r.id === p.id);
        const ref = enResults || enManuales;
        if (ref) {
          aiResetIfNewDay();
          aiUsageCounters.productos++;
          ref.aiTitulo = String(out.titulo || '').slice(0, 120);
          ref.aiDescripcion = String(out.descripcion || '').slice(0, 600);
          ref.aiUpdatedAt = new Date().toISOString();
          procesados++;
        }

        // Guardar cada 10 productos (para no saturar GitHub)
        if (procesados > 0 && procesados % 10 === 0) {
          await save();
        }

        // Rate limit: ~13 req/min (2 keys rotando)
        await new Promise(s => setTimeout(s, 4000));
      } catch (e) {
        errores++;
        app.log.error('[IA-AUTO] Error en ' + p.id + ': ' + e.message);

        // Lógica de reintento con retroceso exponencial para errores 503
        if (e.message.includes('503') || e.message.includes('UNAVAILABLE')) {
          let espera = 2000; // 2 segundos iniciales
          for (let intento = 1; intento <= 3; intento++) {
            app.log.warn(`[IA-AUTO] Reintento ${intento}/3 para ${p.id} en ${espera/1000}s...`);
            await new Promise(s => setTimeout(s, espera));
            try {
              // Reintentar la misma petición a la IA
              const txt = await preguntarIA(prompt, { json: true });
              const out = JSON.parse(String(txt).replace(/```json|```/g, '').trim());
              // ... (código para actualizar el producto con el resultado exitoso)
              app.log.info(`[IA-AUTO] Reintento ${intento} exitoso para ${p.id}`);
              break; // Salir del bucle de reintentos si tiene éxito
            } catch (retryError) {
              if (intento === 3) {
                app.log.error(`[IA-AUTO] Fallaron los 3 reintentos para ${p.id}.`);
              }
              espera *= 2; // Duplicar el tiempo de espera
            }
          }
        }
        // ... (el resto de la lógica de espera por errores consecutivos)
      }
    }

    // Guardar cambios finales
    if (procesados > 0) await save();

    const dur = Math.round((Date.now() - inicio) / 1000);
    app.log.info('[IA-AUTO] Completado: ' + procesados + ' procesados, ' + errores + ' errores, ' + dur + 's');
    logActivity('ia_auto', { procesados, errores, dur });

    state.iaLastRun = new Date().toISOString();
    state.iaLastProcessed = procesados;
    return { procesados, errores, dur };
  } finally {
    iaProcesando = false;
  }
}

async function generarFrasesBanner() {
  try {
    const cfg = state.shopConfig || {};
    const promos = (cfg.promociones || []).filter(p => p && p.activo !== false);
    const promosTexto = promos.length
      ? promos.map(p => '- ' + (p.texto || '')).join('\n')
      : '- Envio gratis en pedidos +$50\n- Nuevos productos cada dia';

    // Top 3 categorias con mas productos
    const todasCats = [...(state.results || []), ...(state.productosManuales || [])]
      .map(p => p.category)
      .filter(Boolean);
    const conteo = {};
    todasCats.forEach(c => conteo[c] = (conteo[c] || 0) + 1);
    const topCats = Object.entries(conteo)
      .sort((a,b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c]) => c)
      .join(', ');

    const prompt = `Eres creativo de marketing de "Comdiaz Shop", tienda cubana online de productos importados con envio a toda Cuba.

Genera EXACTAMENTE 5 frases cortas y llamativas para el banner rotativo de la tienda.

PROMOCIONES ACTIVAS (deben aparecer):
${promosTexto}

CATEGORIAS DESTACADAS: ${topCats || 'productos varios'}

REGLAS ESTRICTAS:
- Devuelve SOLO un JSON valido con este formato exacto:
  {"frases": [{"texto": "...", "emoji": "...", "color": "..."}]}
- El "texto" debe ser maximo 60 caracteres, en espanol cubano natural
- El "emoji" debe ser 1 solo emoji (sin texto)
- El "color" debe ser uno de: gradient, green, orange, red, blue, dark
- VARIEDAD: no repitas estructura entre frases
- Algunas con URGENCIA, otras con BENEFICIO, otras con CURIOSIDAD
- NO uses hashtags, NO uses MAYUSCULAS excesivas
- Ejemplos del estilo: "Envio gratis desde $50", "Nuevo stock cada semana", "Lo mejor para tu hogar", "Precios que sorprenden"

Devuelve SOLO el JSON, sin explicaciones.`;

    const txt = await preguntarIA(prompt, { json: true });
    const out = JSON.parse(String(txt).replace(/```json|```/g, '').trim());
    const frases = (out.frases || []).filter(f => f.texto && f.texto.length <= 80).slice(0, 8);

    if (frases.length > 0) {
      state.shopConfig = state.shopConfig || {};
      state.shopConfig.aiBanners = frases.map((f, i) => ({
        id: 'ai-' + Date.now() + '-' + i,
        texto: String(f.texto).slice(0, 80),
        emoji: String(f.emoji || '✨').slice(0, 4),
        color: ['gradient','green','orange','red','blue','dark'].includes(f.color) ? f.color : 'gradient',
        activo: true,
        generatedByAI: true
      }));
      state.shopConfig.aiBannersUpdated = new Date().toISOString();
      await save();
      app.log.info('[IA-BANNERS] ' + frases.length + ' frases generadas');
      return { ok: true, total: frases.length };
    }
    return { ok: false, error: 'Sin frases validas' };
  } catch(e) {
    app.log.error('[IA-BANNERS] Error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

function scheduleIA() {
  if (iaTask) iaTask.stop();
  // Cada 6 horas: 00:00, 06:00, 12:00, 18:00
  iaTask = cron.schedule('0 */6 * * *', async () => {
    app.log.info('[IA-AUTO] Cron cada 6h disparado');
    try {
      await procesarProductosSinIA(800);
    } catch (e) {
      app.log.error('[IA-AUTO] Error en productos: ' + e.message);
    }
    // Tambien regenera frases del banner
    try {
      await generarFrasesBanner();
    } catch (e) {
      app.log.error('[IA-AUTO] Error en frases banner: ' + e.message);
    }
  }, { timezone: APP_TZ });
  app.log.info('[IA-AUTO] Cron configurado cada 6h (timezone ' + APP_TZ + ')');
  state.iaNextRun = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
}


// ═══════════════════════════════════════════════════════
// CRON V2: Semanal + Diario + Cleanup + Purga
// ═══════════════════════════════════════════════════════

// ═══ TOPE DE CATÁLOGO (evita crecimiento infinito) ═══
const CATALOG_CAP = 5000;
// ═══ ACTUALIZACIÓN DE PRECIOS SIN AÑADIR PRODUCTOS ═══
async function soloActualizarPrecios(sufijo, etiqueta) {
  const marginPct = Number(state.margin) || 35;
  const fuentesActivas = Object.entries(state.sources || {})
    .filter(function(e) { return e[1] && e[1].enabled; })
    .map(function(e) { return e[0]; });
  if (!fuentesActivas.length) return 0;
  
  const results = state.results || [];
  const porId = new Map(results.map(r => [r.id, r]));
  let actualizados = 0;
  let sinCambios = 0;
  let inactivados = 0;
  const vistosIds = new Set();
  
  // Buscar solo términos base (sin sufijo, para no traer nuevos)
  for (const cat of state.categories) {
    const baseTerms = (cat.dummyjson && cat.dummyjson.length) ? cat.dummyjson : [cat.label.toLowerCase()];
    for (const baseTerm of baseTerms) {
      const q = sufijo ? (baseTerm + sufijo) : baseTerm;
      for (const sourceId of fuentesActivas) {
        try {
          const items = await adapters.searchFrom(sourceId, q, state.sources);
          for (const it of items) {
            if (!it.id) continue;
            vistosIds.add(it.id);
            const existente = porId.get(it.id);
            if (!existente) continue;  // NO añadir nuevos
            // Solo actualizar precio si cambió
            const pbase = it.price;
            const nuevoSalePrice = +(pbase * (1 + marginPct / 100)).toFixed(2);
            if (existente.basePrice !== pbase || existente.salePrice !== nuevoSalePrice) {
              existente.basePrice = pbase;
              existente.salePrice = nuevoSalePrice;
              existente.precioActualizado = new Date().toISOString();
              existente.vecesVisto = (existente.vecesVisto || 1) + 1;
              actualizados++;
            } else {
              existente.vecesVisto = (existente.vecesVisto || 1) + 1;
              sinCambios++;
            }
            existente.ultimaVez = new Date().toISOString().slice(0, 10);
            existente.activo = true;
          }
        } catch (e) {
          app.log.error('[PRECIO-ACT] err: ' + e.message);
        }
      }
    }
  }
  
  // Inactivar productos no vistos (solo si tienen ultimaVez viejo)
  // NO toca productos con IA reciente
  for (const r of results) {
    if (r.activo !== false && !vistosIds.has(r.id) && r.aiTitulo) {
      // Preservar productos con IA (nunca inactivar sin motivo)
      continue;
    }
  }
  
  if (actualizados > 0 || inactivados > 0) {
    await save();
    app.log.info('[' + etiqueta + '] Precios actualizados: ' + actualizados + ' | Sin cambios: ' + sinCambios);
    logActivity('precio_update', { actualizados, sinCambios, etiqueta });
    notifyTelegram('💰 <b>PRECIOS ACTUALIZADOS</b>\n\n' +
      '🔄 Con cambios: ' + actualizados + '\n' +
      '✅ Sin cambios: ' + sinCambios + '\n' +
      '📦 Total: ' + results.length + '/' + CATALOG_CAP
    ).catch(() => {});
  } else {
    app.log.info('[' + etiqueta + '] Sin cambios de precio');
  }
  
  return actualizados;
}

   // Tope duro de productos activos
const CATALOG_WARN = 4500;   // Alerta al 95%

async function _cronSearch(limitePorCat, sufijo, etiqueta, prioridadDefault) {
  // ═══ VERIFICAR TOPE DE CATÁLOGO ═══
  const activosActuales = (state.results || []).filter(r => r.activo !== false).length;
  if (activosActuales >= CATALOG_CAP) {
    app.log.info('[' + etiqueta + '] 🛑 TOPE ALCANZADO: ' + activosActuales + '/' + CATALOG_CAP + '. Solo actualizando precios.');
    return await soloActualizarPrecios(sufijo, etiqueta);
  }
  if (activosActuales >= CATALOG_WARN) {
    app.log.warn('[' + etiqueta + '] ⚠️ Cerca del tope: ' + activosActuales + '/' + CATALOG_CAP);
    notifyTelegram('⚠️ <b>CATÁLOGO CERCA DEL TOPE</b>\n\n' +
      'Activos: ' + activosActuales + '/' + CATALOG_CAP + '\n' +
      'Solo quedan ' + (CATALOG_CAP - activosActuales) + ' espacios').catch(() => {});
  }
  
  const marginPct = Number(state.margin) || 35;
  const fuentesActivas = Object.entries(state.sources || {})
    .filter(function(e) { return e[1] && e[1].enabled; })
    .map(function(e) { return e[0]; });
  if (!fuentesActivas.length) {
    app.log.warn('[' + etiqueta + '] Sin fuentes activas');
    return 0;
  }
  const found = [];
  for (const cat of state.categories) {
    const baseTerms = (cat.dummyjson && cat.dummyjson.length) ? cat.dummyjson : [cat.label.toLowerCase()];
    for (const baseTerm of baseTerms) {
      const q = sufijo ? (baseTerm + sufijo) : baseTerm;
      for (const sourceId of fuentesActivas) {
        try {
          const items = await adapters.searchFrom(sourceId, q, state.sources);
          const top = items.slice(0, limitePorCat);
          for (const it of top) {
            const pbase = it.price;
            const sale = +(pbase * (1 + marginPct / 100)).toFixed(2);
            found.push(Object.assign({}, it, {
              category: cat.label,
              basePrice: pbase,
              salePrice: sale,
              marginPct: marginPct,
              foundAt: new Date().toISOString(),
              prioridad: prioridadDefault || 'normal',
            }));
          }
        } catch (e) {
          app.log.error('[' + etiqueta + '] err [' + cat.label + ' / ' + sourceId + ' / ' + q + ']: ' + e.message);
        }
      }
    }
  }
  const seen = new Set();
  const unique = found.filter(function(pr) {
    if (seen.has(pr.id)) return false;
    seen.add(pr.id);
    return true;
  });
  if (unique.length > 0) {
    const antes = (state.results || []).length;
    state.results = mergeProducts(state.results || [], unique);
    const pubSet = new Set(state.published || []);
    for (const r of state.results) if (r.activo !== false) pubSet.add(r.id);
    state.published = Array.from(pubSet);
    app.log.info('[' + etiqueta + '] ' + antes + ' -> ' + state.results.length + ' productos (traidos: ' + unique.length + ')');
    logActivity('cron_' + etiqueta.toLowerCase(), { encontrados: unique.length, total: state.results.length });
    state.automation.lastRun = new Date().toISOString();
    state.automation.lastCronType = etiqueta;
    state.automation.lastCronFound = unique.length;
    await save();
    // Notificar por Telegram
    const icono = etiqueta === 'CRON-SEM' ? '📅' : '📆';
    const titulo = etiqueta === 'CRON-SEM' ? 'BÚSQUEDA SEMANAL' : 'BÚSQUEDA DIARIA';
    notifyTelegram(icono + ' <b>' + titulo + '</b>\n\n' +
      '➕ Nuevos: <b>' + unique.length + '</b>\n' +
      '📦 Total: ' + state.results.length + '\n' +
      '✅ Publicados: ' + state.published.length
    ).catch(() => {});
  } else {
    app.log.warn('[' + etiqueta + '] 0 productos - NO se sobrescribe');
  }
  return unique.length;
}

async function runSearchMonthly() {
  app.log.info('[CRON-MES] Búsqueda mensual: ofertas + huecos');
  const activos = (state.results || []).filter(r => r.activo !== false).length;
  const disponibles = CATALOG_CAP - activos;
  
  // 1) Primero: actualizar precios de todos los existentes (no añade)
  app.log.info('[CRON-MES] Fase 1: actualizar precios existentes');
  await soloActualizarPrecios('', 'CRON-MES-PRECIOS');
  
  // 2) Buscar ofertas SOLO si hay huecos disponibles
  if (disponibles > 0) {
    app.log.info('[CRON-MES] Fase 2: buscar ofertas (huecos disponibles: ' + disponibles + ')');
    await _cronSearch(20, ' deals', 'CRON-MES-DEALS', 'oferta');
    await _cronSearch(20, ' sale', 'CRON-MES-SALE', 'rebaja');
    await _cronSearch(20, ' clearance', 'CRON-MES-CLEARANCE', 'rebaja');
  } else {
    app.log.info('[CRON-MES] Sin huecos. Solo se actualizaron precios.');
  }
  
  notifyTelegram('🗓️ <b>BÚSQUEDA MENSUAL</b>\n\n' +
    '📊 Activos: ' + activos + '/' + CATALOG_CAP + '\n' +
    '📦 Huecos: ' + disponibles + '\n' +
    '✅ Ciclo completado').catch(() => {});
}

async function runSearchWeekly() {
  app.log.info('[CRON-SEM] Búsqueda semanal completa');
  return _cronSearch(50, '', 'CRON-SEM', 'normal');
}

async function runSearchDaily() {
  const dow = new Date().getDay();
  if (dow === 0) {
    app.log.info('[CRON-DIA] Domingo - saltando (corre semanal)');
    return 0;
  }
  const sufijo = (state.dailySuffixes || {})[String(dow)] || ' deals';
  app.log.info('[CRON-DIA] Búsqueda diaria con sufijo "' + sufijo + '"');
  return _cronSearch(10, sufijo, 'CRON-DIA', 'oferta');
}

// ═══════════════════════════════════════════════════════
// SRE — Vigilancia proactiva del sistema
// ═══════════════════════════════════════════════════════

async function sreTakeSnapshot() {
  const results = state.results || [];
  const manuales = state.productosManuales || [];
  const locales = manuales.filter(p => p.tipo === 'local');
  const conIA = results.filter(p => p.aiTitulo).length;
  const activos = results.filter(p => p.activo !== false).length;

  return {
    ts: Date.now(),
    fecha: new Date().toISOString(),
    totalProductos: results.length,
    publicados: (state.published || []).length,
    conIA,
    sinIA: results.length - conIA,
    activos,
    inactivos: results.length - activos,
    locales: locales.length,
    localesPublicados: locales.filter(p => p.publicado).length,
    pedidosHoy: (state.orders || []).filter(o => (o.createdAt || '').startsWith(new Date().toISOString().slice(0, 10))).length,
  };
}

async function sreNotificarTelegram(mensaje) {
  const cfg = state.sre || {};
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = cfg.telegramChatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !cfg.telegramEnabled) return false;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: mensaje, parse_mode: 'HTML' }),
    });
    return true;
  } catch(e) {
    app.log.warn('[SRE] Telegram falló: ' + e.message);
    return false;
  }
}

async function sreCheck() {
  state.sre = state.sre || { snapshots: [], alerts: [], pausedCrons: {} };
  const now = await sreTakeSnapshot();
  const snapshots = state.sre.snapshots || [];
  const prev = snapshots[snapshots.length - 1];

  const alertasNuevas = [];

  if (prev) {
    // REGLA 1 (ROJA): Caída del catálogo > 5%
    const caidaCatalogo = prev.totalProductos > 0
      ? ((prev.totalProductos - now.totalProductos) / prev.totalProductos) * 100
      : 0;
    if (caidaCatalogo > 5) {
      alertasNuevas.push({
        tipo: 'ROJA',
        regla: 'caida_catalogo',
        detalle: 'Catálogo cayó ' + caidaCatalogo.toFixed(1) + '% en 30 min (' + prev.totalProductos + ' → ' + now.totalProductos + ')',
        ts: Date.now(),
        accion: 'Pausar cleanup automáticamente',
      });
      // Pausar cleanup automáticamente
      state.sre.pausedCrons = state.sre.pausedCrons || {};
      state.sre.pausedCrons.cleanup = true;
    }

    // REGLA 2 (NARANJA): Caída de productos con IA > 5%
    const caidaIA = prev.conIA > 0
      ? ((prev.conIA - now.conIA) / prev.conIA) * 100
      : 0;
    if (caidaIA > 5) {
      alertasNuevas.push({
        tipo: 'NARANJA',
        regla: 'caida_ia',
        detalle: 'Productos con IA cayeron ' + caidaIA.toFixed(1) + '% (' + prev.conIA + ' → ' + now.conIA + ')',
        ts: Date.now(),
        accion: 'Revisar purga o borrado accidental',
      });
    }

    // REGLA 3 (AMARILLA): Locales desaparecen
    if (prev.locales > 0 && now.locales < prev.locales) {
      alertasNuevas.push({
        tipo: 'AMARILLA',
        regla: 'caida_locales',
        detalle: 'Locales: ' + prev.locales + ' → ' + now.locales,
        ts: Date.now(),
        accion: 'Verificar guardado de productos locales',
      });
    }
  }

  // Guardar snapshot (máx 20)
  snapshots.push(now);
  if (snapshots.length > 20) snapshots.shift();
  state.sre.snapshots = snapshots;
  state.sre.lastCheck = now.fecha;
  state.sre.lastSnapshot = now;

  // Guardar alertas (máx 50)
  for (const a of alertasNuevas) {
    state.sre.alerts.push(a);
    app.log.warn('[SRE] 🚨 ' + a.tipo + ': ' + a.detalle);
    // Notificar por Telegram
    const emoji = a.tipo === 'ROJA' ? '🚨' : a.tipo === 'NARANJA' ? '⚠️' : '💡';
    await sreNotificarTelegram(emoji + ' <b>' + a.tipo + '</b>\n' + a.detalle + '\n\n' + a.accion);
  }
  if (state.sre.alerts.length > 50) state.sre.alerts = state.sre.alerts.slice(-50);

  await save();

  return { alertas: alertasNuevas.length, snapshot: now };
}

async function cleanupProductos() {
  // Verificar si SRE pausó el cleanup
  if (state.sre && state.sre.pausedCrons && state.sre.pausedCrons.cleanup) {
    app.log.warn('[CLEANUP] ⏸ PAUSADO por SRE (alerta activa)');
    return 0;
  }
  let marcadosInactivos = 0;
  let reactivados = 0;
  for (const p of (state.results || [])) {
    const dias = diasSinVer(p);
    if (dias >= 7 && p.activo !== false) {
      p.activo = false;
      marcadosInactivos++;
    } else if (dias < 7 && p.activo === false) {
      p.activo = true;
      reactivados++;
    }
  }
  if (marcadosInactivos > 0 || reactivados > 0) {
    app.log.info('[CLEANUP] Inactivados: ' + marcadosInactivos + ' | Reactivados: ' + reactivados);
    await save();
  } else {
    app.log.info('[CLEANUP] Sin cambios');
  }
  return marcadosInactivos;
}

async function purgaProductos() {
  const CAP_MAX = 10000;
  const DIAS_PURGA = 90;
  let eliminados = 0;
  const sobrevivientes = [];
  for (const p of (state.results || [])) {
    const dias = diasSinVer(p);
    const score = calculateScore(p);
    const ventas = Number(p.ventasCount || 0);
    const vistas = Number(p.vistasProducto || 0);
    const esJoya = ventas > 0 || vistas > 5;
    if (dias >= DIAS_PURGA && !esJoya) {
      eliminados++;
      state.deletedHistory = state.deletedHistory || [];
      state.deletedHistory.push({
        id: p.id,
        titulo: (p.title || '').slice(0, 100),
        category: p.category,
        motivo: 'sin-ver-' + dias + 'd',
        score: score,
        fecha: new Date().toISOString(),
      });
      continue;
    }
    p.score = score;
    sobrevivientes.push(p);
  }
  if (sobrevivientes.length > CAP_MAX) {
    sobrevivientes.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
    const aEliminar = sobrevivientes.splice(CAP_MAX);
    for (const p of aEliminar) {
      eliminados++;
      state.deletedHistory.push({
        id: p.id,
        titulo: (p.title || '').slice(0, 100),
        category: p.category,
        motivo: 'cap-' + CAP_MAX,
        score: p.score || 0,
        fecha: new Date().toISOString(),
      });
    }
  }
  if ((state.deletedHistory || []).length > 500) {
    state.deletedHistory = state.deletedHistory.slice(-500);
  }
  state.results = sobrevivientes;
  const activos = sobrevivientes.filter(function(pr) { return pr.activo !== false; }).length;
  state.shopStats = state.shopStats || {};
  state.shopStats.totalActivos = activos;
  state.shopStats.totalInactivos = sobrevivientes.length - activos;
  state.shopStats.totalEliminados = (state.shopStats.totalEliminados || 0) + eliminados;
  state.shopStats.ultimaPurga = new Date().toISOString();
  app.log.info('[PURGA] Eliminados: ' + eliminados + ' | Activos: ' + activos + ' | Total: ' + sobrevivientes.length);
  await save();
  return eliminados;
}

let cronWeekly = null, cronDaily = null, cronCleanup = null, cronPurga = null, cronSRE = null, cronMensual = null, cronLocalDesc = null;
function scheduleDaily() {
  if (cronWeekly) cronWeekly.stop();
  if (cronDaily) cronDaily.stop();
  if (cronCleanup) cronCleanup.stop();
  if (cronPurga) cronPurga.stop();
  const tz = APP_TZ;
  cronWeekly = cron.schedule('0 5 * * 0', async function() {
    app.log.info('[CRON-SEM] Disparado');
    try { await runSearchWeekly(); } catch (e) { app.log.error('[CRON-SEM] ' + e.message); }
  }, { timezone: tz });
  cronDaily = cron.schedule('0 5 * * 1-6', async function() {
    app.log.info('[CRON-DIA] Disparado');
    try { await runSearchDaily(); } catch (e) { app.log.error('[CRON-DIA] ' + e.message); }
  }, { timezone: tz });
  cronCleanup = cron.schedule('0 3 * * *', async function() {
    try { await cleanupProductos(); } catch (e) { app.log.error('[CLEANUP] ' + e.message); }
  }, { timezone: tz });
  cronPurga = cron.schedule('0 4 * * 0', async function() {
    try { await purgaProductos(); } catch (e) { app.log.error('[PURGA] ' + e.message); }
  }, { timezone: tz });
  // SRE: cada 30 min
  if (cronSRE) cronSRE.stop();
  cronSRE = cron.schedule('*/30 * * * *', async function() {
    try { await sreCheck(); } catch (e) { app.log.error('[SRE] ' + e.message); }
  }, { timezone: tz });
  
  // ═══ CRON MENSUAL: Ofertas + productos nuevos (1er domingo del mes a las 06:00) ═══
  if (cronMensual) cronMensual.stop();
  cronMensual = cron.schedule('0 6 1-7 * 0', async function() {
    app.log.info('[CRON-MES] Ejecutando búsqueda mensual de ofertas');
    try {
      await runSearchMonthly();
    } catch (e) {
      app.log.error('[CRON-MES] ' + e.message);
    }
  }, { timezone: tz });

  // ═══ CRON-LOCAL-DESC: cada 2h genera descripciones de locales (pool BULK) ═══
  if (cronLocalDesc) cronLocalDesc.stop();
  cronLocalDesc = cron.schedule('0 */2 * * *', async function() {
    try { await procesarDescripcionesLocales(100); } catch (e) { app.log.error('[CRON-LOCAL-DESC] ' + e.message); }
  }, { timezone: tz });

  app.log.info('[CRON-V2] Semanal Dom 05:00 | Diario L-S 05:00 | Cleanup 03:00 | Purga Dom 04:00 | SRE cada 30min | Mensual 1er Dom 06:00 | LocalDesc cada 2h');
}

// Endpoint público para healthcheck (UptimeRobot, Pingdom, etc.)
// ═══ SRE endpoints ═══
// Emergencia: reactivar TODOS los productos inactivos sin ultimaVez
app.post('/api/sre/reactivate-all', async () => {
  let reactivados = 0;
  for (const p of (state.results || [])) {
    if (p.activo === false && !p.ultimaVez) {
      p.activo = true;
      reactivados++;
    }
  }
  if (reactivados > 0) await save();
  logActivity('reactivate_all', { reactivados });
  return { ok: true, reactivados };
});

app.post('/api/sre/pause-cron', async (req) => {
  const cron = req.body?.cron;
  const paused = req.body?.paused !== false;
  if (!cron) return { ok: false, error: 'Falta nombre de cron' };
  state.sre = state.sre || {};
  state.sre.pausedCrons = state.sre.pausedCrons || {};
  state.sre.pausedCrons[cron] = paused;
  await save();
  logActivity('sre_pause_cron', { cron, paused });
  return { ok: true, cron, paused, pausedCrons: state.sre.pausedCrons };
});

app.get('/api/catalog/status', async () => {
  const results = state.results || [];
  const activos = results.filter(r => r.activo !== false).length;
  const inactivos = results.length - activos;
  const conIA = results.filter(r => r.aiTitulo && r.activo !== false).length;
  const disponibles = Math.max(0, CATALOG_CAP - activos);
  const porcentaje = Math.round((activos / CATALOG_CAP) * 1000) / 10;
  
  let estado = 'verde';
  let mensaje = 'Puedes seguir buscando ' + disponibles + ' productos más';
  if (activos >= CATALOG_CAP) {
    estado = 'rojo';
    mensaje = 'Tope alcanzado. Solo se actualizarán precios';
  } else if (activos >= CATALOG_WARN) {
    estado = 'amarillo';
    mensaje = 'Cerca del tope. Quedan ' + disponibles + ' espacios';
  }
  
  return {
    ok: true,
    activos,
    inactivos,
    conIA,
    sinIA: activos - conIA,
    capMax: CATALOG_CAP,
    capWarn: CATALOG_WARN,
    disponibles,
    porcentaje,
    estado,
    mensaje,
    puedeBuscarNuevos: activos < CATALOG_CAP,
  };
});

app.get('/api/sre/status', async () => ({
  ok: true,
  lastCheck: state.sre?.lastCheck || null,
  lastSnapshot: state.sre?.lastSnapshot || null,
  pausedCrons: state.sre?.pausedCrons || {},
  alertasRecientes: (state.sre?.alerts || []).slice(-10),
  totalSnapshots: (state.sre?.snapshots || []).length,
}));

app.get('/api/sre/alerts', async () => ({
  ok: true,
  total: (state.sre?.alerts || []).length,
  alertas: (state.sre?.alerts || []).slice(-50),
}));

app.post('/api/sre/check', async () => {
  const r = await sreCheck();
  return { ok: true, ...r };
});

app.post('/api/sre/resume-cron', async (req) => {
  const cron = req.body?.cron;
  if (!cron) return { ok: false, error: 'Falta nombre de cron' };
  if (state.sre?.pausedCrons) state.sre.pausedCrons[cron] = false;
  await save();
  return { ok: true, pausedCrons: state.sre.pausedCrons };
});

app.post('/api/sre/config-telegram', async (req) => {
  const { chatId, enabled } = req.body || {};
  state.sre = state.sre || {};
  if (chatId !== undefined) state.sre.telegramChatId = chatId;
  if (enabled !== undefined) state.sre.telegramEnabled = !!enabled;
  await save();
  return { ok: true, telegramChatId: state.sre.telegramChatId, telegramEnabled: state.sre.telegramEnabled };
});

// ═══════════════════════════════════════════════════════
// VENDEDORES — Registro, login, perfil
// ═══════════════════════════════════════════════════════

// POST: registro de vendedor
app.post('/api/seller/register', async (req, reply) => {
  try {
    const { nombre, telefono, password, provincia, municipio, email } = req.body || {};
    
    if (!nombre || String(nombre).trim().length < 2) {
      reply.code(400); return { ok: false, error: 'Nombre inválido' };
    }
    if (!telefono || !validarTelefono(telefono)) {
      reply.code(400); return { ok: false, error: 'Teléfono inválido (formato: 5351234567)' };
    }
    if (!password || String(password).length < 6) {
      reply.code(400); return { ok: false, error: 'Contraseña mínimo 6 caracteres' };
    }
    
    const tel = normalizarTelefono(telefono);
    
    // Verificar si ya existe
    const existente = await dbSelectOne('sellers', '?telefono=eq.' + encodeURIComponent(tel));
    if (existente) {
      reply.code(409); return { ok: false, error: 'Ya existe una cuenta con ese teléfono' };
    }
    
    const password_hash = hashPassword(String(password));
    
    const nuevo = await dbInsert('sellers', {
      nombre: String(nombre).trim().slice(0, 80),
      telefono: tel,
      password_hash,
      email: email ? String(email).slice(0, 100) : null,
      provincia: provincia ? String(provincia).slice(0, 60) : null,
      municipio: municipio ? String(municipio).slice(0, 60) : null,
      plan_id: 'basico',
      estado: 'pendiente',
      activo: true,
      cuota_usada: 0,
    });
    
    notifyTelegram(
      '🏪 <b>NUEVO VENDEDOR</b>\n\n' +
      '👤 ' + nombre + '\n' +
      '📱 ' + tel + '\n' +
      '📍 ' + (provincia || '?') + (municipio ? ' / ' + municipio : '') + '\n\n' +
      '⏳ Pendiente de aprobación'
    ).catch(() => {});
    
    return { ok: true, seller: { id: nuevo.id, nombre: nuevo.nombre, telefono: nuevo.telefono, estado: nuevo.estado } };
  } catch(e) {
    app.log.error('[SELLER-REGISTER] ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

// POST: login de vendedor
app.post('/api/seller/login', async (req, reply) => {
  try {
    const { telefono, password } = req.body || {};
    if (!telefono || !password) {
      reply.code(400); return { ok: false, error: 'Falta teléfono o contraseña' };
    }
    const tel = normalizarTelefono(telefono);
    const seller = await dbSelectOne('sellers', '?telefono=eq.' + encodeURIComponent(tel));
    if (!seller) {
      reply.code(401); return { ok: false, error: 'Credenciales inválidas' };
    }
    if (!verifyPassword(String(password), seller.password_hash)) {
      reply.code(401); return { ok: false, error: 'Credenciales inválidas' };
    }
    if (seller.estado === 'suspendido' || seller.activo === false) {
      reply.code(403); return { ok: false, error: 'Cuenta suspendida' };
    }
    
    const token = createJWT({ sellerId: seller.id, tipo: 'seller', telefono: seller.telefono });
    
    return {
      ok: true,
      token,
      seller: {
        id: seller.id,
        nombre: seller.nombre,
        telefono: seller.telefono,
        estado: seller.estado,
        plan_id: seller.plan_id,
        provincia: seller.provincia,
        municipio: seller.municipio,
      }
    };
  } catch(e) {
    app.log.error('[SELLER-LOGIN] ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

// GET: perfil del vendedor (con plan y cuota)
app.get('/api/seller/me', async (req, reply) => {
  try {
    const payload = requireSeller(req);
    if (!payload) { reply.code(401); return { ok: false, error: 'No autorizado' }; }
    
    const seller = await dbSelectOne('sellers', '?id=eq.' + encodeURIComponent(payload.sellerId));
    if (!seller) { reply.code(404); return { ok: false, error: 'Cuenta no existe' }; }
    
    const plan = await dbSelectOne('plans', '?id=eq.' + encodeURIComponent(seller.plan_id));
    const productosCount = await dbCount('seller_products', '?seller_id=eq.' + encodeURIComponent(seller.id) + '&activo=eq.true');
    
    return {
      ok: true,
      seller: {
        id: seller.id,
        nombre: seller.nombre,
        telefono: seller.telefono,
        email: seller.email,
        provincia: seller.provincia,
        municipio: seller.municipio,
        estado: seller.estado,
        activo: seller.activo,
        plan_id: seller.plan_id,
        plan: plan || null,
        plan_expira_at: seller.plan_expira_at,
        cuota_usada: productosCount,
        cuota_max: plan ? plan.max_productos : 50,
        cuota_disponible: plan ? Math.max(0, plan.max_productos - productosCount) : 0,
        created_at: seller.created_at,
      }
    };
  } catch(e) {
    app.log.error('[SELLER-ME] ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

app.get('/health', async () => ({ ok: true, service: 'comdiaz', ts: Date.now() }));

app.get('/api/state', async () => state);

app.get('/api/home', async () => {
  const results = state.results || [];
  const manuales = state.productosManuales || [];
  const activos = results.filter(r => r.activo !== false);
  const conIA = activos.filter(r => r.aiTitulo).length;
  const locales = manuales.filter(p => p.tipo === 'local');
  
  return {
    ok: true,
    running: state.automation?.running === true,
    publishTimes: state.automation?.publishTimes || [],
    lastRun: state.automation?.lastRun || null,
    delaySeconds: state.automation?.delaySeconds || 5,
    productos: activos.length,
    conIA,
    sinIA: activos.length - conIA,
    categorias: (state.categories || []).length,
    published: (state.published || []).length,
    locales: locales.length,
    localesPublicados: locales.filter(p => p.publicado).length,
    margin: state.margin || 35,
    capMax: CATALOG_CAP,
    ts: Date.now(),
  };
});

// ═══════════════════════════════════════════════════════
// PRODUCTOS DE VENDEDORES (CRUD + cuota)
// ═══════════════════════════════════════════════════════

// POST: crear producto
app.post('/api/seller/products', async (req, reply) => {
  try {
    const payload = requireSeller(req);
    if (!payload) { reply.code(401); return { ok: false, error: 'No autorizado' }; }
    
    const seller = await dbSelectOne('sellers', '?id=eq.' + encodeURIComponent(payload.sellerId));
    if (!seller) { reply.code(404); return { ok: false, error: 'Cuenta no existe' }; }
    if (seller.estado !== 'aprobado') {
      reply.code(403); return { ok: false, error: 'Cuenta pendiente de aprobación' };
    }
    
    const plan = await dbSelectOne('plans', '?id=eq.' + encodeURIComponent(seller.plan_id));
    const cuotaMax = plan ? plan.max_productos : 50;
    
    if (cuotaMax !== -1) {
      const actuales = await dbCount('seller_products', '?seller_id=eq.' + encodeURIComponent(seller.id) + '&activo=eq.true');
      if (actuales >= cuotaMax) {
        reply.code(429); return { ok: false, error: 'Cuota alcanzada (' + cuotaMax + ' productos). Actualiza tu plan.' };
      }
    }
    
    const body = req.body || {};
    if (!body.titulo || String(body.titulo).trim().length < 3) {
      reply.code(400); return { ok: false, error: 'Título mínimo 3 caracteres' };
    }
    if (!body.precio_usd || Number(body.precio_usd) <= 0) {
      reply.code(400); return { ok: false, error: 'Precio USD requerido' };
    }
    
    const nuevo = await dbInsert('seller_products', {
      seller_id: seller.id,
      titulo: String(body.titulo).trim().slice(0, 200),
      descripcion: body.descripcion ? String(body.descripcion).slice(0, 2000) : null,
      precio_usd: Number(body.precio_usd),
      precio_cup: body.precio_cup ? Number(body.precio_cup) : null,
      categoria: body.categoria ? String(body.categoria).slice(0, 80) : null,
      provincia: body.provincia || seller.provincia,
      municipio: body.municipio || seller.municipio,
      imagenes: Array.isArray(body.imagenes) ? body.imagenes.slice(0, 8) : [],
      estado_producto: body.estado_producto || 'nuevo',
      stock: Number(body.stock) || 1,
      activo: true,
      publicado: true,
    });
    
    return { ok: true, product: nuevo };
  } catch(e) {
    app.log.error('[SELLER-PRODUCT-CREATE] ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

// GET: listar mis productos
app.get('/api/seller/products', async (req, reply) => {
  try {
    const payload = requireSeller(req);
    if (!payload) { reply.code(401); return { ok: false, error: 'No autorizado' }; }
    
    const productos = await dbSelect('seller_products', '?seller_id=eq.' + encodeURIComponent(payload.sellerId) + '&order=created_at.desc');
    
    return { ok: true, total: productos.length, products: productos || [] };
  } catch(e) {
    app.log.error('[SELLER-PRODUCT-LIST] ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

// PUT: editar mi producto
app.put('/api/seller/products/:id', async (req, reply) => {
  try {
    const payload = requireSeller(req);
    if (!payload) { reply.code(401); return { ok: false, error: 'No autorizado' }; }
    
    const prod = await dbSelectOne('seller_products', '?id=eq.' + encodeURIComponent(req.params.id));
    if (!prod) { reply.code(404); return { ok: false, error: 'Producto no encontrado' }; }
    if (prod.seller_id !== payload.sellerId) {
      reply.code(403); return { ok: false, error: 'No es tu producto' };
    }
    
    const body = req.body || {};
    const updates = {};
    if (body.titulo) updates.titulo = String(body.titulo).trim().slice(0, 200);
    if (body.descripcion !== undefined) updates.descripcion = body.descripcion ? String(body.descripcion).slice(0, 2000) : null;
    if (body.precio_usd !== undefined) updates.precio_usd = Number(body.precio_usd);
    if (body.precio_cup !== undefined) updates.precio_cup = body.precio_cup ? Number(body.precio_cup) : null;
    if (body.categoria !== undefined) updates.categoria = body.categoria;
    if (body.provincia !== undefined) updates.provincia = body.provincia;
    if (body.municipio !== undefined) updates.municipio = body.municipio;
    if (body.imagenes !== undefined && Array.isArray(body.imagenes)) updates.imagenes = body.imagenes.slice(0, 8);
    if (body.estado_producto !== undefined) updates.estado_producto = body.estado_producto;
    if (body.stock !== undefined) updates.stock = Number(body.stock) || 1;
    if (body.activo !== undefined) updates.activo = !!body.activo;
    if (body.publicado !== undefined) updates.publicado = !!body.publicado;
    updates.updated_at = new Date().toISOString();
    
    const actualizado = await dbUpdate('seller_products', req.params.id, updates);
    return { ok: true, product: actualizado };
  } catch(e) {
    app.log.error('[SELLER-PRODUCT-UPDATE] ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

// DELETE: eliminar mi producto (soft delete)
app.delete('/api/seller/products/:id', async (req, reply) => {
  try {
    const payload = requireSeller(req);
    if (!payload) { reply.code(401); return { ok: false, error: 'No autorizado' }; }
    
    const prod = await dbSelectOne('seller_products', '?id=eq.' + encodeURIComponent(req.params.id));
    if (!prod) { reply.code(404); return { ok: false, error: 'Producto no encontrado' }; }
    if (prod.seller_id !== payload.sellerId) {
      reply.code(403); return { ok: false, error: 'No es tu producto' };
    }
    
    await dbUpdate('seller_products', req.params.id, { activo: false, publicado: false });
    return { ok: true };
  } catch(e) {
    app.log.error('[SELLER-PRODUCT-DELETE] ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

// ═══ PÚBLICO: catálogo de vendedores para la Shop ═══
app.get('/api/public/sellers/catalog', async (req) => {
  try {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query?.offset) || 0, 0);
    const productos = await dbSelect('public_products', '?limit=' + limit + '&offset=' + offset + '&order=created_at.desc');
    
    return {
      ok: true,
      total: (productos || []).length,
      products: (productos || []).map(p => ({
        id: p.id,
        titulo: p.titulo,
        descripcion: p.descripcion,
        precio_usd: p.precio_usd,
        precio_cup: p.precio_cup,
        categoria: p.categoria,
        provincia: p.provincia,
        municipio: p.municipio,
        imagenes: p.imagenes || [],
        estado_producto: p.estado_producto,
        stock: p.stock,
        seller_nombre: p.seller_nombre,
        seller_id: p.seller_id,
        // NO incluimos seller_telefono — se obtiene solo al comprar
        tipo: 'seller',
      })),
    };
  } catch(e) {
    app.log.error('[PUBLIC-SELLERS-CATALOG] ' + e.message);
    return { ok: false, error: e.message, products: [] };
  }
});

// ═══ CRÍTICO: número de WhatsApp correcto por producto ═══
// ═══════════════════════════════════════════════════════
// ADMIN — Aprobar vendedores, pagos, ver estadísticas
// ═══════════════════════════════════════════════════════

// GET: listar vendedores (filtrable por estado)
app.get('/api/admin/sellers', async (req, reply) => {
  const auth = requireAdmin(req);
  if (!auth) { reply.code(401); return { ok: false, error: 'No autorizado' }; }
  
  try {
    const estado = req.query?.estado;
    const q = estado ? '?estado=eq.' + encodeURIComponent(estado) + '&order=created_at.desc' : '?order=created_at.desc';
    const sellers = await dbSelect('sellers', q);
    // No devolver password_hash
    const limpios = (sellers || []).map(s => {
      const { password_hash, ...rest } = s;
      return rest;
    });
    return { ok: true, total: limpios.length, sellers: limpios };
  } catch(e) {
    reply.code(500); return { ok: false, error: e.message };
  }
});

// POST: aprobar vendedor
app.post('/api/admin/sellers/:id/approve', async (req, reply) => {
  const auth = requireAdmin(req);
  if (!auth) { reply.code(401); return { ok: false, error: 'No autorizado' }; }
  
  try {
    const seller = await dbUpdate('sellers', req.params.id, {
      estado: 'aprobado',
      activo: true,
      updated_at: new Date().toISOString(),
    });
    if (!seller) { reply.code(404); return { ok: false, error: 'No encontrado' }; }
    
    notifyTelegram('✅ <b>VENDEDOR APROBADO</b>\n\n👤 ' + seller.nombre + '\n📱 ' + seller.telefono).catch(() => {});
    
    return { ok: true, seller: { id: seller.id, nombre: seller.nombre, estado: seller.estado } };
  } catch(e) {
    reply.code(500); return { ok: false, error: e.message };
  }
});

// POST: rechazar/suspender vendedor
app.post('/api/admin/sellers/:id/suspend', async (req, reply) => {
  const auth = requireAdmin(req);
  if (!auth) { reply.code(401); return { ok: false, error: 'No autorizado' }; }
  
  try {
    const motivo = req.body?.motivo || 'Suspendido por admin';
    const seller = await dbUpdate('sellers', req.params.id, {
      estado: 'suspendido',
      activo: false,
      notas_internas: motivo,
      updated_at: new Date().toISOString(),
    });
    if (!seller) { reply.code(404); return { ok: false, error: 'No encontrado' }; }
    
    notifyTelegram('🚫 <b>VENDEDOR SUSPENDIDO</b>\n\n👤 ' + seller.nombre + '\n📱 ' + seller.telefono + '\n📝 ' + motivo).catch(() => {});
    
    return { ok: true, seller: { id: seller.id, estado: seller.estado } };
  } catch(e) {
    reply.code(500); return { ok: false, error: e.message };
  }
});

// GET: estadísticas generales para admin
app.get('/api/admin/stats', async (req, reply) => {
  const auth = requireAdmin(req);
  if (!auth) { reply.code(401); return { ok: false, error: 'No autorizado' }; }
  
  try {
    const pendientes = await dbCount('sellers', '?estado=eq.pendiente');
    const aprobados = await dbCount('sellers', '?estado=eq.aprobado');
    const suspendidos = await dbCount('sellers', '?estado=eq.suspendido');
    const totalProductos = await dbCount('seller_products', '?activo=eq.true');
    const pagosPendientes = await dbCount('payments', '?estado=eq.pendiente');
    
    return {
      ok: true,
      sellers: {
        pendientes,
        aprobados,
        suspendidos,
        total: pendientes + aprobados + suspendidos,
      },
      productos: { totalActivos: totalProductos },
      pagos: { pendientes: pagosPendientes },
    };
  } catch(e) {
    reply.code(500); return { ok: false, error: e.message };
  }
});

app.get('/api/product/whatsapp/:id', async (req, reply) => {
  try {
    const id = req.params.id;
    
    // 1) ¿Es producto de vendedor?
    const sellerProd = await dbSelectOne('seller_products', '?id=eq.' + encodeURIComponent(id) + '&select=*,sellers!inner(telefono,estado,activo,plan_expira_at)');
    if (sellerProd) {
      const seller = sellerProd.sellers;
      const puedeVender = seller && seller.estado === 'aprobado' && seller.activo === true
        && (!seller.plan_expira_at || new Date(seller.plan_expira_at) > new Date());
      
      if (puedeVender) {
        return {
          ok: true,
          telefono: seller.telefono,
          nombre: seller.nombre || 'Vendedor',
          esVendedor: true,
        };
      } else {
        // Fallback al admin si el vendedor está suspendido
        return {
          ok: true,
          telefono: state.shopConfig?.whatsapp || '5351425691',
          nombre: 'Comdiaz Shop',
          esVendedor: false,
          fallback: true,
        };
      }
    }
    
    // 2) ¿Es producto local de Comdiaz?
    const local = (state.productosManuales || []).find(p => p.id === id);
    if (local) {
      return {
        ok: true,
        telefono: state.shopConfig?.whatsapp || '5351425691',
        nombre: 'Comdiaz Shop',
        esVendedor: false,
      };
    }
    
    // 3) ¿Es producto eBay/Temu?
    const ebay = (state.results || []).find(p => p.id === id);
    if (ebay) {
      return {
        ok: true,
        telefono: state.shopConfig?.whatsapp || '5351425691',
        nombre: 'Comdiaz Shop',
        esVendedor: false,
      };
    }
    
    // 4) No encontrado — usar admin por defecto
    return {
      ok: true,
      telefono: state.shopConfig?.whatsapp || '5351425691',
      nombre: 'Comdiaz Shop',
      esVendedor: false,
      fallback: true,
    };
  } catch(e) {
    app.log.error('[PRODUCT-WHATSAPP] ' + e.message);
    return {
      ok: true,
      telefono: state.shopConfig?.whatsapp || '5351425691',
      nombre: 'Comdiaz Shop',
      esVendedor: false,
      fallback: true,
    };
  }
});

app.get('/api/automation/status', async () => ({
  ok: true,
  running: state.automation?.running === true,
  publishTimes: state.automation?.publishTimes || [],
  lastRun: state.automation?.lastRun || null,
  delaySeconds: state.automation?.delaySeconds || 5,
}));

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
  await save();
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
  if (times !== null) {
    const tiemposViejos = state.automation.publishTimes;
    logActivity('publish_times', { viejo: tiemposViejos, nuevo: times });
    state.automation.publishTimes = times;
    schedule();  // schedule() maneja array vacío correctamente
    await save();  // ← CRÍTICO: persistir cambio
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
// POST: sincronizar published con results activos (limpieza + publicación masiva)
// Temporal: reactivar productos sin ultimaVez (bug de cleanup)
app.post('/api/manual/reactivate-old', async (req) => {
  let reactivados = 0;
  for (const p of (state.results || [])) {
    if (p.activo === false && !p.ultimaVez && !p.primeraVez) {
      p.activo = true;
      p.ultimaVez = new Date().toISOString().slice(0, 10);
      reactivados++;
    }
  }
  if (reactivados > 0) await save();
  return { ok: true, reactivados };
});

app.post('/api/manual/sync-published', async (req) => {
  const results = state.results || [];
  const resultsIds = new Set(results.map(r => r.id).filter(Boolean));
  const oldPublished = new Set(state.published || []);

  // Solo mantener published que existan en results + añadir TODOS los activos con imagen
  const newPublished = new Set();
  let eliminados = 0, añadidos = 0;

  for (const id of oldPublished) {
    if (resultsIds.has(id)) {
      newPublished.add(id);
    } else {
      eliminados++;
    }
  }

  for (const r of results) {
    if (r.id && r.activo !== false && r.image && String(r.image).length > 10) {
      if (!newPublished.has(r.id)) {
        newPublished.add(r.id);
        añadidos++;
      }
    }
  }

  state.published = Array.from(newPublished);
  await save();
  logActivity('sync_published', { eliminados, añadidos, total: state.published.length });

  return {
    ok: true,
    totalAntes: oldPublished.size,
    totalDespues: state.published.length,
    eliminados,
    añadidos,
  };
});

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
      aiTitulo: p.aiTitulo || null,
      aiDescripcion: p.aiDescripcion || null,
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
      aiBanners: (state.shopConfig?.aiBanners || []).filter(p => p && p.activo !== false),
      aiBannersUpdated: state.shopConfig?.aiBannersUpdated || null,
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

app.post('/api/ai/save', async (req, reply) => {
  const body = req.body || {};
  const id = String(body.id || '');
  const aiTitulo = String(body.titulo || '').slice(0, 120);
  const aiDescripcion = String(body.descripcion || '').slice(0, 600);
  if (!id || (!aiTitulo && !aiDescripcion)) {
    reply.code(400);
    return { ok: false, error: 'Faltan id, titulo o descripcion' };
  }
  // Buscar en results o en productosManuales
  const enResults = (state.results || []).find(r => r.id === id);
  const enManuales = (state.productosManuales || []).find(r => r.id === id);
  const p = enResults || enManuales;
  if (!p) {
    reply.code(404);
    return { ok: false, error: 'Producto no encontrado' };
  }
  p.aiTitulo = aiTitulo;
  p.aiDescripcion = aiDescripcion;
  p.aiUpdatedAt = new Date().toISOString();
  await save();
  return { ok: true, id };
});

// ═══════════════════════════════════════════════
// ESTADO DE LA IA - Monitoreo
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// COPILOTO IA — Asistente contextual del negocio
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// COPILOTO con STREAMING (SSE) + Groq primero
// ═══════════════════════════════════════════════════════
async function buildCopilotContext(historial) {
  const results = state.results || [];
  const manuales = state.productosManuales || [];
  const locales = manuales.filter(p => p.tipo === 'local');
  const pedidos = state.orders || [];
  const pendientes = pedidos.filter(o => o.estado !== 'entregado' && o.estado !== 'cancelado');
  const hoy = new Date().toISOString().slice(0, 10);
  const ventasHoy = pedidos.filter(o => (o.createdAt || '').startsWith(hoy));
  const totalVentasHoy = ventasHoy.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  const conIA = results.filter(p => p.aiTitulo).length;
  const porCat = {};
  for (const p of results) { const cat = p.category || 'Otros'; porCat[cat] = (porCat[cat] || 0) + 1; }
  const topCats = Object.entries(porCat).sort((a,b) => b[1]-a[1]).slice(0, 3);

  const contexto = {
    catalogo: {
      total: results.length, conIA, sinIA: results.length - conIA,
      publicados: (state.published || []).length,
      locales: locales.length, localesPublicados: locales.filter(p => p.publicado).length,
      topCategorias: topCats,
    },
    ventas: {
      pedidosTotal: pedidos.length, pedidosPendientes: pendientes.length,
      ventasHoy: ventasHoy.length, ingresosHoy: +totalVentasHoy.toFixed(2),
    },
    sistema: {
      cronesActivos: { semanal: 'Dom 05:00', diario: 'L-S 05:00', cleanup: '03:00', purga: 'Dom 04:00', ia: 'cada 6h' },
      ultimaPurga: state.shopStats?.ultimaPurga || null,
      iaEnProgreso: conIA < results.length,
    },
    config: {
      whatsapp: state.shopConfig?.whatsapp, titulo: state.shopConfig?.titulo,
      bannerActivo: state.shopConfig?.bannerActivo,
    },
  };

  const historialTexto = Array.isArray(historial) && historial.length
    ? '\n\nCONVERSACION RECIENTE:\n' + historial.slice(-6).map(h =>
        (h.rol === 'user' ? 'USUARIO: ' : 'COPILOTO: ') + String(h.texto || '').slice(0, 300)
      ).join('\n')
    : '';

  return { contexto, historialTexto };
}

function buildCopilotPrompt(contexto, historialTexto, mensaje) {
  return `Eres el COPILOTO de Comdiaz Shop, un asistente experto que ayuda al dueno del negocio a gestionar su tienda online (eBay, Temu, productos locales) y su APK privada.

CONTEXTO ACTUAL DEL NEGOCIO (JSON):
${JSON.stringify(contexto, null, 2)}
${historialTexto}

INSTRUCCIONES:
- Responde en espanol, claro, breve (maximo 3 parrafos).
- Si detectas problemas, mencionalos proactivamente.
- Si sugieres una accion concreta, termina con: ACCION_SUGERIDA: {"tipo":"...","detalles":"..."}
- Si solo es consulta, NO incluyas ACCION_SUGERIDA.
- NUNCA ejecutes acciones por tu cuenta, solo SUGIERE.
- Si no sabes algo, dilo honestamente.

MENSAJE DEL USUARIO:
${String(mensaje).slice(0, 1000)}

RESPUESTA:`;
}

app.post('/api/ai/copilot-stream', async (req, reply) => {
  const { mensaje, historial } = req.body || {};
  if (!mensaje || typeof mensaje !== 'string') {
    reply.code(400);
    return { ok: false, error: 'Falta mensaje' };
  }

  aiResetIfNewDay();
  aiUsageCounters.copiloto++;

  const { contexto, historialTexto } = await buildCopilotContext(historial);
  const prompt = buildCopilotPrompt(contexto, historialTexto, mensaje);

  // Configurar SSE
  const reqOrigin = req.headers.origin || '';
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': reqOrigin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Comdiaz-Key',
    'Access-Control-Max-Age': '86400',
  });

  const sendSSE = (data) => {
    try { reply.raw.write('data: ' + JSON.stringify(data) + '\n\n'); } catch(_) {}
  };

  const groqKey = process.env.GROQ_API_KEY;
  let respuestaCompleta = '';
  let proveedor = 'ninguno';

  try {
    if (groqKey) {
      // ─── INTENTO 1: Groq (rápido) ───
      proveedor = 'groq';
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + groqKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt }],
            stream: true,
            temperature: 0.7,
            max_tokens: 800,
          }),
        });

        if (!groqRes.ok) {
          const errTxt = await groqRes.text();
          throw new Error('Groq HTTP ' + groqRes.status + ': ' + errTxt.slice(0, 200));
        }

        const reader = groqRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              const chunk = parsed.choices?.[0]?.delta?.content || '';
              if (chunk) {
                respuestaCompleta += chunk;
                sendSSE({ chunk });
              }
            } catch(_) {}
          }
        }
      } catch (groqErr) {
        app.log.warn('[COPILOT] Groq falló: ' + groqErr.message + ' → fallback Gemini');
        proveedor = 'gemini-fallback';
        sendSSE({ info: 'Groq no disponible, usando Gemini' });
        respuestaCompleta = '';
      }
    }

    // ─── FALLBACK: Gemini (sin streaming real, simulamos) ───
    if (!respuestaCompleta) {
      proveedor = 'gemini';
      const respuesta = await preguntarIA(prompt, { json: false, pool: 'copilot' });
      respuestaCompleta = String(respuesta || '').trim();
      // Simular streaming: enviar en trozos de 8 caracteres
      const chunkSize = 8;
      for (let i = 0; i < respuestaCompleta.length; i += chunkSize) {
        sendSSE({ chunk: respuestaCompleta.slice(i, i + chunkSize) });
        await new Promise(r => setTimeout(r, 30));
      }
    }

    // ─── Parsear acción sugerida al final ───
    let texto = respuestaCompleta;
    let accionSugerida = null;
    const matchAccion = texto.match(/ACCION_SUGERIDA:\s*(\{[^}]+\})/);
    if (matchAccion) {
      try {
        accionSugerida = JSON.parse(matchAccion[1]);
        texto = texto.replace(/ACCION_SUGERIDA:.*$/s, '').trim();
      } catch(_) {}
    }

    // Enviar done con la acción y el texto final limpio
    sendSSE({ done: true, accionSugerida, textoFinal: texto, proveedor, contexto });
    logActivity('copilot_stream', { proveedor, longitud: texto.length });
    reply.raw.end();
  } catch (e) {
    app.log.error('[COPILOT-STREAM] ' + e.message);
    sendSSE({ error: e.message });
    reply.raw.end();
  }
});

app.post('/api/ai/copilot', async (req) => {
  try {
    const { mensaje, historial } = req.body || {};
    if (!mensaje || typeof mensaje !== 'string') {
      return { ok: false, error: 'Falta mensaje' };
    }

    // ─── Construir contexto COMPLETO del negocio ───
    const results = state.results || [];
    const manuales = state.productosManuales || [];
    const locales = manuales.filter(p => p.tipo === 'local');
    const pedidos = state.orders || [];
    const pendientes = pedidos.filter(o => o.estado !== 'entregado' && o.estado !== 'cancelado');
    const hoy = new Date().toISOString().slice(0, 10);
    const ventasHoy = pedidos.filter(o => (o.createdAt || '').startsWith(hoy));
    const totalVentasHoy = ventasHoy.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    const conIA = results.filter(p => p.aiTitulo).length;

    // Top 3 categorías
    const porCat = {};
    for (const p of results) {
      const cat = p.category || 'Otros';
      porCat[cat] = (porCat[cat] || 0) + 1;
    }
    const topCats = Object.entries(porCat).sort((a,b) => b[1]-a[1]).slice(0, 3);

    const contexto = {
      catalogo: {
        total: results.length,
        conIA,
        sinIA: results.length - conIA,
        publicados: (state.published || []).length,
        locales: locales.length,
        localesPublicados: locales.filter(p => p.publicado).length,
        topCategorias: topCats,
      },
      ventas: {
        pedidosTotal: pedidos.length,
        pedidosPendientes: pendientes.length,
        ventasHoy: ventasHoy.length,
        ingresosHoy: +totalVentasHoy.toFixed(2),
      },
      sistema: {
        cronesActivos: {
          semanal: 'Dom 05:00',
          diario: 'L-S 05:00',
          cleanup: '03:00',
          purga: 'Dom 04:00',
          ia: 'cada 6h',
        },
        ultimaPurga: state.shopStats?.ultimaPurga || null,
        iaEnProgreso: conIA < results.length,
      },
      config: {
        whatsapp: state.shopConfig?.whatsapp,
        titulo: state.shopConfig?.titulo,
        bannerActivo: state.shopConfig?.bannerActivo,
      },
    };

    // ─── Construir prompt para Gemini ───
    const historialTexto = Array.isArray(historial) && historial.length
      ? '\n\nCONVERSACION RECIENTE:\n' + historial.slice(-6).map(h =>
          (h.rol === 'user' ? 'USUARIO: ' : 'COPILOTO: ') + String(h.texto || '').slice(0, 300)
        ).join('\n')
      : '';

    const prompt = `Eres el COPILOTO de Comdiaz Shop, un asistente experto que ayuda al dueno del negocio a gestionar su tienda online (eBay, Temu, productos locales) y su APK privada.

CONTEXTO ACTUAL DEL NEGOCIO (JSON):
${JSON.stringify(contexto, null, 2)}
${historialTexto}

INSTRUCCIONES:
- Responde en espanol, claro, breve (maximo 3 parrafos).
- Si detectas problemas, mencionalos proactivamente.
- Si sugieres una accion concreta, termina con: ACCION_SUGERIDA: {"tipo":"...","detalles":"..."}
- Si solo es consulta, NO incluyas ACCION_SUGERIDA.
- NUNCA ejecutes acciones por tu cuenta, solo SUGIERE.
- Si no sabes algo, dilo honestamente.

MENSAJE DEL USUARIO:
${String(mensaje).slice(0, 1000)}

RESPUESTA:`;

    aiResetIfNewDay();
    aiUsageCounters.copiloto++;
    const respuesta = await preguntarIA(prompt, { json: false });

    // ─── Parsear acciones sugeridas (si hay) ───
    let texto = String(respuesta || '').trim();
    let accionSugerida = null;
    const matchAccion = texto.match(/ACCION_SUGERIDA:\s*(\{[^}]+\})/);
    if (matchAccion) {
      try {
        accionSugerida = JSON.parse(matchAccion[1]);
        texto = texto.replace(/ACCION_SUGERIDA:.*$/s, '').trim();
      } catch(e) {}
    }

    logActivity('copilot_query', { mensaje: String(mensaje).slice(0, 100) });

    return {
      ok: true,
      respuesta: texto,
      accionSugerida,
      contexto,
      ts: new Date().toISOString(),
    };
  } catch (e) {
    app.log.error('[COPILOT] ' + e.message);
    return { ok: false, error: e.message };
  }
});

// ═══════════════════════════════════════════════════════
// IA VISION — Analizar foto de producto local
// ═══════════════════════════════════════════════════════
// ═══ CONTADOR DE USO IA ═══
const aiUsageCounters = {
  fecha: new Date().toISOString().slice(0, 10),
  productos: 0, fotos: 0, copiloto: 0, banners: 0, descripcion: 0, otros: 0,
};

function aiResetIfNewDay() {
  const hoy = new Date().toISOString().slice(0, 10);
  if (aiUsageCounters.fecha !== hoy) {
    aiUsageCounters.fecha = hoy;
    aiUsageCounters.productos = 0;
    aiUsageCounters.fotos = 0;
    aiUsageCounters.copiloto = 0;
    aiUsageCounters.banners = 0;
    aiUsageCounters.descripcion = 0;
    aiUsageCounters.otros = 0;
  }
}

app.get('/api/ai/usage', async () => {
  aiResetIfNewDay();
  const total = aiUsageCounters.productos + aiUsageCounters.fotos +
                aiUsageCounters.copiloto + aiUsageCounters.banners +
                aiUsageCounters.descripcion + aiUsageCounters.otros;
  // Calcular límite dinámico según número de keys configuradas
  // Contar keys por pool
  const keysCore = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
  ].filter(Boolean).length;
  const keysBulk = [
    process.env.GEMINI_BULK_KEY_1,
    process.env.GEMINI_BULK_KEY_2,
    process.env.GEMINI_BULK_KEY_3
  ].filter(Boolean).length;
  const keysCopilot = [
    process.env.GEMINI_COPILOT_KEY_1,
    process.env.GEMINI_COPILOT_KEY_2
  ].filter(Boolean).length;
  
  const numKeys = keysCore + keysBulk + keysCopilot;
  const LIMITE_POR_KEY = 1500;
  const LIMITE = numKeys * LIMITE_POR_KEY;
  
  return {
    ok: true,
    fecha: aiUsageCounters.fecha,
    detalle: { ...aiUsageCounters, fecha: undefined },
    total, limite: LIMITE,
    keys: numKeys,
    pools: {
      core:    { keys: keysCore,    limite: keysCore * LIMITE_POR_KEY,    uso: aiUsageCounters.productos },
      bulk:    { keys: keysBulk,    limite: keysBulk * LIMITE_POR_KEY,    uso: aiUsageCounters.fotos },
      copilot: { keys: keysCopilot, limite: keysCopilot * LIMITE_POR_KEY, uso: aiUsageCounters.copiloto },
    },
    limitePorKey: LIMITE_POR_KEY,
    restante: Math.max(0, LIMITE - total),
    porcentaje: LIMITE > 0 ? Math.round((total / LIMITE) * 1000) / 10 : 0,
  };
});

app.post('/api/ai/analyze-photo', async (req, reply) => {
  const startMs = Date.now();
  try {
    const { imageBase64, imageUrl } = req.body || {};
    let base64Data = '';
    let mimeType = 'image/jpeg';

    if (imageBase64) {
      const raw = String(imageBase64);
      base64Data = raw.replace(/^data:image\/[^;]+;base64,/, '');
      const m = raw.match(/^data:(image\/[^;]+);base64,/);
      if (m) mimeType = m[1];
    } else if (imageUrl) {
      const r = await fetch(String(imageUrl));
      if (!r.ok) { reply.code(400); return { ok: false, error: 'No se pudo descargar la imagen (HTTP ' + r.status + ')' }; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 5 * 1024 * 1024) { reply.code(400); return { ok: false, error: 'Imagen muy grande (>5MB)' }; }
      base64Data = buf.toString('base64');
      mimeType = r.headers.get('content-type') || 'image/jpeg';
    } else {
      reply.code(400);
      return { ok: false, error: 'Falta imageBase64 o imageUrl' };
    }

    if (!base64Data || base64Data.length < 100) {
      reply.code(400);
      return { ok: false, error: 'Imagen vacía o inválida' };
    }

    // Categorías existentes para que la IA elija una
    const cats = (state.categories || []).map(c => c.label).filter(Boolean);
    const catList = cats.length ? cats.join(' | ') : 'Otros';
    const estadosValidos = 'nuevo | usado | reacondicionado';

    const prompt = `Eres experto en e-commerce para el mercado cubano. Analiza la imagen de este producto y devuelve SOLO un JSON válido con esta forma exacta (sin markdown, sin explicaciones):

{
  "titulo": "Título corto y claro en español, máximo 70 caracteres, sin emojis",
  "categoria": "Elige UNA de esta lista: ${catList}",
  "descripcion": "2 o 3 frases en español, máximo 400 caracteres, sin inventar marcas ni medidas",
  "estado": "uno de: ${estadosValidos}",
  "precioSugeridoUSD": número entre 5 y 5000,
  "tienePrecioIncrustado": true si la imagen tiene texto de precio sobreimpreso, false si no,
  "confianza": número entre 0.0 y 1.0
}

IMPORTANTE:
- Si NO puedes identificar el producto, pon confianza < 0.3 y título "Producto sin identificar".
- El precio sugerido debe ser razonable para reventa en Cuba (no precio de tienda nueva).
- Si detectas que el estado es usado (desgaste visible), reflejarlo.`;

    const txt = await preguntarIA(prompt, {
      json: true,
      images: [{ mimeType, data: base64Data }],
      pool: 'bulk',  // Carga masiva usa su propio pool
    });

    let sugerencia;
    try {
      sugerencia = JSON.parse(String(txt).replace(/```json|```/g, '').trim());
    } catch (e) {
      return { ok: false, error: 'IA devolvió JSON inválido: ' + String(txt).slice(0, 200) };
    }

    // Validar campos mínimos
    if (!sugerencia.titulo) sugerencia.titulo = 'Producto sin título';
    if (!sugerencia.categoria || !cats.includes(sugerencia.categoria)) {
      sugerencia.categoria = cats[0] || 'Local';
    }
    if (!['nuevo','usado','reacondicionado'].includes(sugerencia.estado)) {
      sugerencia.estado = 'nuevo';
    }
    sugerencia.precioSugeridoUSD = Number(sugerencia.precioSugeridoUSD) || 0;
    sugerencia.confianza = Number(sugerencia.confianza) || 0.5;

    aiResetIfNewDay();
    aiUsageCounters.fotos++;
    const durMs = Date.now() - startMs;
    logActivity('ai_analyze_photo', {
      titulo: String(sugerencia.titulo).slice(0, 60),
      confianza: sugerencia.confianza,
      durMs,
    });

    return {
      ok: true,
      sugerencia,
      meta: { durMs, mimeType, sizeKB: Math.round(base64Data.length * 0.75 / 1024) }
    };
  } catch (e) {
    app.log.error('[AI-PHOTO] ' + e.message);
    reply.code(500);
    return { ok: false, error: e.message, durMs: Date.now() - startMs };
  }
});

app.get('/api/ai/status', async (req) => {
  const results = state.results || [];
  const manuales = state.productosManuales || [];
  const todos = [...results, ...manuales];

  const conIA = todos.filter(p => p.aiTitulo && p.aiDescripcion).length;
  const sinIA = todos.length - conIA;
  const progreso = todos.length > 0 ? +(conIA / todos.length * 100).toFixed(2) : 0;

  // Ultimos 10 productos con IA
  const ultimos = todos
    .filter(p => p.aiUpdatedAt)
    .sort((a, b) => (b.aiUpdatedAt || '').localeCompare(a.aiUpdatedAt || ''))
    .slice(0, 10)
    .map(p => ({
      id: p.id,
      tituloOriginal: (p.title || '').slice(0, 50),
      tituloIA: (p.aiTitulo || '').slice(0, 60),
      generadoEn: p.aiUpdatedAt
    }));

  // Contar generadas en la ultima hora
  const hace1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const ultimaHora = todos.filter(p => (p.aiUpdatedAt || '') >= hace1h).length;

  // Estado de las keys
  let keys = [];
  try {
    const aiModule = await import('./ai.js');
    if (typeof aiModule.infoKeys === 'function') {
      keys = aiModule.infoKeys();
    }
  } catch(e) {}

  return {
    ok: true,
    total: todos.length,
    conIA,
    sinIA,
    progreso,
    ultimaHora,
    modelo: process.env.GEMINI_MODEL || 'no configurado',
    keys,
    ultimos
  };
});

// Endpoint manual para procesar productos sin IA ahora mismo
app.post('/api/ai/process-pending', async (req, reply) => {
  const max = Math.min(Math.max(Number(req.body?.max) || 50, 1), 200);
  try {
    const r = await procesarProductosSinIA(max);
    return { ok: true, ...r };
  } catch(e) {
    reply.code(500);
    return { ok: false, error: e.message };
  }
});

app.post('/api/ai/generate-banners', async (req, reply) => {
  try {
    const r = await generarFrasesBanner();
    return r;
  } catch(e) {
    reply.code(500);
    return { ok: false, error: e.message };
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
    aiBanners: (state.shopConfig?.aiBanners || []).filter(p => p && p.activo !== false),
    aiBannersUpdated: state.shopConfig?.aiBannersUpdated || null,
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
// POST: recuperar locales desde backup redundante
app.post('/api/manual/restore-backup', async (req) => {
  try {
    const GITHUB_API = 'https://api.github.com';
    const FILE_PATH = 'locals-backup.json';
    const token = process.env.GITHUB_STATE_TOKEN;
    const repo = process.env.GITHUB_STATE_REPO;
    if (!token || !repo) return { ok: false, error: 'GitHub no configurado' };
    const url = GITHUB_API + '/repos/' + repo + '/contents/' + FILE_PATH;
    const res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'comdiaz-backend',
      },
    });
    if (!res.ok) return { ok: false, error: 'No hay backup: HTTP ' + res.status };
    const data = await res.json();
    const zlib = await import('zlib');
    const gz = Buffer.from(data.content, 'base64');
    const json = zlib.gunzipSync(gz).toString('utf8');
    const backup = JSON.parse(json);
    const productos = backup.productos || [];
    // Merge por id: no duplicar, no perder nada
    const existentes = new Set((state.productosManuales || []).map(p => p.id));
    let nuevos = 0;
    for (const p of productos) {
      if (!existentes.has(p.id)) {
        state.productosManuales = state.productosManuales || [];
        state.productosManuales.push(p);
        nuevos++;
      }
    }
    await save();
    return { ok: true, recuperados: nuevos, total: productos.length, ts: backup._ts };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// POST temporal: migrar source=local sin tipo → tipo=local
app.post('/api/manual/migrate-tipo', async (req) => {
  let migrados = 0;
  for (const p of (state.productosManuales || [])) {
    if (p.source === 'local' && !p.tipo) {
      p.tipo = 'local';
      migrados++;
    }
  }
  if (migrados > 0) {
    await save();
    logActivity('migrate_tipo_local', { migrados });
  }
  return { ok: true, migrados };
});

app.get('/api/manual/products', async (req) => {
  let lista = state.productosManuales || [];
  const q = req.query || {};
  if (q.tipo) lista = lista.filter(p => (p.tipo || p.source || 'manual') === q.tipo);
  if (q.provincia) lista = lista.filter(p => p.provincia === q.provincia);
  if (q.municipio) lista = lista.filter(p => p.municipio === q.municipio);
  if (q.source) lista = lista.filter(p => p.source === q.source);
  return {
    ok: true,
    total: lista.length,
    totalGlobal: (state.productosManuales || []).length,
    products: lista,
  };
});

// GET público: lista de provincias y municipios de Cuba
app.get('/api/public/provincias', async () => ({
  ok: true,
  provincias: CUBA_UBICACIONES,
}));

// POST con auth: agregar producto manual
app.post('/api/manual/products', async (req) => {
  const body = req.body || {};
  // Validaciones mínimas
  if (!body.title) return { ok: false, error: 'Falta: title' };
  const imagenes = Array.isArray(body.images) && body.images.length
    ? body.images.slice(0, 8).map(u => String(u).slice(0, 500))
    : (body.image ? [String(body.image).slice(0, 500)] : []);
  if (!imagenes.length) return { ok: false, error: 'Falta: al menos 1 imagen' };

  const esLocal = (body.tipo === 'local') || (body.source === 'local');
  const priceBase = Number(body.priceBase) || 0;
  const margenPct = Number(body.margenPct) || state.margin || 35;
  const precioDirecto = !!body.precioDirecto;

  if (priceBase <= 0 && !body.precioUSD) {
    return { ok: false, error: 'Falta: priceBase o precioUSD' };
  }

  // Precio de venta: si precioDirecto, usar el valor dado; si no, aplicar margen
  let salePrice;
  if (precioDirecto && body.precioUSD) {
    salePrice = +Number(body.precioUSD).toFixed(2);
  } else if (esLocal && body.precioUSD) {
    salePrice = +Number(body.precioUSD).toFixed(2);
  } else {
    salePrice = +(priceBase * (1 + margenPct / 100)).toFixed(2);
  }

  // Validar ubicación si es local
  let provincia = null, municipio = null;
  if (esLocal) {
    provincia = body.provincia ? String(body.provincia).slice(0, 60) : null;
    municipio = body.municipio ? String(body.municipio).slice(0, 60) : null;
    if (provincia && !CUBA_UBICACIONES[provincia]) {
      return { ok: false, error: 'Provincia inválida: ' + provincia };
    }
    if (provincia && municipio && CUBA_UBICACIONES[provincia] && !CUBA_UBICACIONES[provincia].includes(municipio)) {
      return { ok: false, error: 'Municipio inválido para ' + provincia + ': ' + municipio };
    }
  }

  const estado = esLocal
    ? (['nuevo','usado','reacondicionado'].includes(body.estado) ? body.estado : 'nuevo')
    : null;

  const producto = {
    id: (esLocal ? 'local-' : 'manual-') + Date.now() + '-' + Math.floor(Math.random() * 1000),
    // Campos universales
    title: String(body.title).slice(0, 200),
    image: imagenes[0],
    imagePrincipal: imagenes[0],
    images: imagenes,
    category: String(body.category || (esLocal ? 'Local' : 'Manual')).slice(0, 80),
    description: String(body.description || '').slice(0, 2000),
    // Precios
    priceBase: priceBase || null,
    salePrice: salePrice,
    margenPct: margenPct,
    precioUSD: body.precioUSD ? +Number(body.precioUSD).toFixed(2) : null,
    precioCUP: body.precioCUP ? +Number(body.precioCUP).toFixed(2) : null,
    precioDirecto: precioDirecto,
    // Stock
    cantidad: Number(body.cantidad) || 1,
    // Ubicación (solo locales)
    tipo: esLocal ? 'local' : (body.tipo || 'manual'),
    provincia: provincia,
    municipio: municipio,
    estado: estado,
    // Notas internas (no se exponen al público)
    notas: body.notas ? String(body.notas).slice(0, 500) : null,
    // Flags
    publicado: body.publicado !== false,
    destacado: !!body.destacado,
    // Meta
    source: esLocal ? 'local' : 'manual',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  state.productosManuales = state.productosManuales || [];
  state.productosManuales.unshift(producto);
  logActivity('manual_add', { id: producto.id, title: producto.title, tipo: producto.tipo });
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

  // ── Campos básicos ──
  if (body.title !== undefined) p.title = String(body.title).slice(0, 200);
  if (body.description !== undefined) p.description = String(body.description).slice(0, 2000);
  if (body.category !== undefined) p.category = String(body.category).slice(0, 80);
  if (body.priceBase !== undefined) p.priceBase = Number(body.priceBase) || null;
  if (body.margenPct !== undefined) p.margenPct = Number(body.margenPct);
  if (body.cantidad !== undefined) p.cantidad = Number(body.cantidad);
  if (body.publicado !== undefined) p.publicado = !!body.publicado;
  if (body.destacado !== undefined) p.destacado = !!body.destacado;
  if (body.image !== undefined) { p.image = body.image; p.imagePrincipal = body.image; }
  if (body.images !== undefined && Array.isArray(body.images)) {
    p.images = body.images.slice(0, 8).map(u => String(u).slice(0, 500));
    if (p.images.length) { p.image = p.images[0]; p.imagePrincipal = p.images[0]; }
  }

  // ── Campos locales ──
  if (body.tipo !== undefined) p.tipo = body.tipo || null;
  if (body.precioUSD !== undefined) p.precioUSD = body.precioUSD ? +Number(body.precioUSD).toFixed(2) : null;
  if (body.precioCUP !== undefined) p.precioCUP = body.precioCUP ? +Number(body.precioCUP).toFixed(2) : null;
  if (body.precioDirecto !== undefined) p.precioDirecto = !!body.precioDirecto;
  if (body.notas !== undefined) p.notas = body.notas ? String(body.notas).slice(0, 500) : null;

  if (body.estado !== undefined && ['nuevo','usado','reacondicionado'].includes(body.estado)) {
    p.estado = body.estado;
  }

  if (body.provincia !== undefined) {
    if (body.provincia && typeof CUBA_UBICACIONES !== 'undefined' && !CUBA_UBICACIONES[body.provincia]) {
      reply.code(400); return { ok: false, error: 'Provincia inválida: ' + body.provincia };
    }
    p.provincia = body.provincia || null;
  }

  if (body.municipio !== undefined) {
    if (body.municipio && p.provincia && typeof CUBA_UBICACIONES !== 'undefined' && CUBA_UBICACIONES[p.provincia] && !CUBA_UBICACIONES[p.provincia].includes(body.municipio)) {
      reply.code(400); return { ok: false, error: 'Municipio inválido para ' + p.provincia };
    }
    p.municipio = body.municipio || null;
  }

  // ── Recalcular salePrice (prioridad: precioDirecto > precioUSD local > priceBase + margen) ──
  if (p.precioDirecto && p.precioUSD) {
    p.salePrice = +Number(p.precioUSD).toFixed(2);
  } else if (p.tipo === 'local' && p.precioUSD) {
    p.salePrice = +Number(p.precioUSD).toFixed(2);
  } else if (p.priceBase) {
    p.salePrice = +(p.priceBase * (1 + (p.margenPct || 0) / 100)).toFixed(2);
  }

  p.updatedAt = new Date().toISOString();
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

    let limit = 5;
    try { const sp = requireSeller(req); if (sp && sp.sellerId) limit = 30; } catch(_) {}
    try { const ap = requireAdmin(req); if (ap) limit = 60; } catch(_) {}

    if (entry.count > limit) {
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

// ═══════════════════════════════════════════════
// PUBLICACIONES CON IA (nuevo endpoint - usa Gemini)
// ═══════════════════════════════════════════════

app.post('/api/posts/generate-ai', async (req, reply) => {
  const body = req.body || {};
  const tipo = String(body.tipo || 'oferta').trim();
  const ref = String(body.ref || '').trim() || 'directo';
  const cfg = state.shopConfig || {};
  const wa = cfg.whatsapp || '5351425691';
  const shopUrl = 'https://com-diaz-web.onrender.com/shop.html?ref=' + encodeURIComponent(ref);

  // Productos publicos
  const manuales = (state.productosManuales || []).filter(p => p.publicado !== false);
  const ebay = (state.results || [])
    .filter(r => (state.published || []).includes(r.id))
    .map(r => ({
      id: r.id,
      title: r.aiTitulo || r.title,
      titleOriginal: r.title,
      salePrice: r.salePrice,
      category: r.category,
      source: r.source || 'ebay',
      url: r.url,
      aiDescripcion: r.aiDescripcion
    }));
  const todos = manuales.concat(ebay).filter(p => p.salePrice > 0 && p.title);
  if (!todos.length) { reply.code(400); return { ok: false, error: 'No hay productos' }; }

  function pick(arr, n) {
    const copy = [...arr];
    const out = [];
    for (let i = 0; i < n && copy.length; i++) {
      out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
  }

  // Elegir productos segun tipo
  let lista = [];
  let contexto = '';
  if (tipo === 'oferta') {
    lista = pick(todos, 1);
    contexto = 'Publicacion de OFERTA DEL DIA. Destaca 1 solo producto. Titulo llamativo con emojis 🔥⚡. Crea urgencia ("solo por hoy", "ultimas unidades").';
  } else if (tipo === 'novedades') {
    lista = todos.slice(0, 5);
    contexto = 'Publicacion de NOVEDADES recien llegadas. Anuncia los 5 productos como nuevos en la tienda. Tono entusiasta con ✨🆕.';
  } else if (tipo === 'destacados') {
    lista = pick(todos, 5);
    contexto = 'Publicacion de PRODUCTOS DESTACADOS de la semana. Los 5 mejores con ⭐🔥. Tono premium.';
  } else if (tipo === 'promocion') {
    const promos = (cfg.promociones || []).filter(p => p && p.activo !== false);
    const promoTexto = promos.length
      ? promos.map(p => p.texto).join(' | ')
      : (cfg.bannerTexto || 'Ofertas especiales');
    lista = pick(todos, 3);
    contexto = 'Publicacion de PROMOCION. Menciona la promo: "' + promoTexto + '". Incluye 3 productos de ejemplo. Tono 🎁🎉.';
  } else {
    reply.code(400);
    return { ok: false, error: 'tipo invalido (oferta|novedades|destacados|promocion)' };
  }

  // Prompt para Gemini
  const listaTexto = lista.map((p, i) =>
    (i+1) + '. ' + p.title.slice(0, 100) + ' - $' + Number(p.salePrice).toFixed(2) +
    (p.category ? ' (' + p.category + ')' : '')
  ).join('\n');

  const prompt = `Eres community manager de "Comdiaz Shop", una tienda en linea cubana que vende productos importados y locales con envio a toda Cuba.

Genera una publicacion para grupos de WhatsApp y Facebook siguiendo estas reglas ESTRICTAS:

TIPO: ${contexto}

PRODUCTOS A INCLUIR:
${listaTexto}

REGLAS DEL TEXTO:
- Idioma: espanol cubano, tono cercano pero profesional
- Longitud: maximo 300 palabras (WhatsApp tiene limite)
- NO uses hashtags (no funcionan en grupos cubanos)
- SI usa emojis con moderacion (max 8-10 en total)
- Formato optimizado para movil: lineas cortas, espacios entre bloques
- Titulo llamativo en la primera linea (MAYUSCULAS + emoji)
- Cada producto: nombre, precio en USD ($X.XX), categoria
- Cierra con llamada a la accion clara y los enlaces:

📲 Pedidos por WhatsApp: https://wa.me/${wa}
🌐 Catalogo completo: ${shopUrl}
🚚 Envio a toda Cuba · Pago al recibir

IMPORTANTE:
- NO inventes productos ni precios (usa SOLO los que te di)
- NO prometas envios gratis si no lo dice el contexto
- El texto debe estar listo para COPIAR Y PEGAR tal cual`;

  try {
    const inicio = Date.now();
    const txt = await preguntarIA(prompt);
    const dur = Date.now() - inicio;

    const texto = String(txt || '').trim();
    if (!texto || texto.length < 50) {
      throw new Error('Respuesta IA muy corta');
    }

    // Extraer titulo (primera linea no vacia)
    const lineas = texto.split('\n').filter(l => l.trim());
    const titulo = lineas[0] ? lineas[0].slice(0, 80) : 'Publicacion';

    logActivity('post_ia', { tipo, ref, dur, longitud: texto.length });

    return {
      ok: true,
      tipo,
      ref,
      titulo,
      texto,
      productos: lista.map(p => ({ id: p.id, title: p.title, salePrice: p.salePrice })),
      link: shopUrl,
      whatsapp: wa,
      longitud: texto.length,
      generadoPor: 'ia',
      durMs: dur
    };
  } catch(e) {
    app.log.error('Error IA posts: ' + e.message);
    reply.code(502);
    return { ok: false, error: 'IA no disponible: ' + e.message + '. Usa el generador normal.' };
  }
});

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

  // ═══ Métricas de productos (cron-v2) ═══
  const todos = state.results || [];
  const activos = todos.filter(function(pr) { return pr.activo !== false; });
  const conIA = todos.filter(function(pr) { return !!pr.aiTitulo; });
  const porCat = {};
  for (const pr of todos) {
    const cat = pr.category || 'sin-categoria';
    if (!porCat[cat]) porCat[cat] = { activos: 0, inactivos: 0, conIA: 0 };
    if (pr.activo !== false) porCat[cat].activos++;
    else porCat[cat].inactivos++;
    if (pr.aiTitulo) porCat[cat].conIA++;
  }

  return {
    ok: true,
    // Visitas (existente)
    total: v.total || 0,
    hoy: v.byDay?.[hoy] || { visitas: 0, productos: 0, carrito: 0, whatsapp: 0 },
    ultimos7,
    topProductos,
    recientes: recientes.length,
    historialReciente: (v.history || []).slice(0, 30),
    // Productos (cron-v2 nuevo)
    productos: {
      total: todos.length,
      activos: activos.length,
      inactivos: todos.length - activos.length,
      conIA: conIA.length,
      sinIA: todos.length - conIA.length,
      porCategoria: porCat,
    },
    eliminadosTotal: (state.shopStats && state.shopStats.totalEliminados) || 0,
    ultimaPurga: (state.shopStats && state.shopStats.ultimaPurga) || null,
    historialEliminados: (state.deletedHistory || []).slice(-10),
    dailySuffixes: state.dailySuffixes || {},
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

// ═══ PÚBLICO: catálogo de productos locales ═══
app.get('/api/public/local', async (req) => {
  const q = req.query || {};
  let lista = (state.productosManuales || []).filter(p =>
    p.publicado !== false && p.tipo === 'local' && p.activo !== false
  );
  if (q.provincia) lista = lista.filter(p => p.provincia === q.provincia);
  if (q.municipio) lista = lista.filter(p => p.municipio === q.municipio);
  if (q.categoria) lista = lista.filter(p => (p.category || '') === q.categoria);
  if (q.estado) lista = lista.filter(p => p.estado === q.estado);
  if (q.buscar) {
    const term = String(q.buscar).toLowerCase();
    lista = lista.filter(p => (p.title || '').toLowerCase().includes(term));
  }
  if (q.destacados === '1') lista = lista.filter(p => p.destacado);

  const proyeccion = lista.map(p => ({
    id: p.id,
    title: p.title,
    image: p.image,
    images: p.images || [p.image],
    category: p.category,
    description: p.description || '',
    salePrice: p.salePrice,
    precioCUP: p.precioCUP || null,
    provincia: p.provincia || null,
    municipio: p.municipio || null,
    estado: p.estado || 'nuevo',
    cantidad: p.cantidad || 1,
    destacado: !!p.destacado,
    createdAt: p.createdAt,
    tipo: 'local',
  }));

  // ── Productos de vendedores aprobados ──
  let sellerProds = [];
  try {
    const raw = await dbSelect(
      'seller_products',
      '?publicado=eq.true&activo=eq.true&select=*,sellers!inner(estado,activo,nombre,provincia,municipio)'
    );
    sellerProds = (raw || [])
      .filter(p => p.sellers && p.sellers.estado === 'aprobado' && p.sellers.activo !== false)
      .filter(p => p.imagenes && Array.isArray(p.imagenes) && p.imagenes.length > 0)
      .map(p => ({
        id: 'seller_' + p.id,
        title: p.titulo,
        image: p.imagenes[0],
        images: p.imagenes,
        category: p.categoria || 'Sin categoría',
        description: p.descripcion || '',
        salePrice: p.precio_usd,
        precioCUP: p.precio_cup || null,
        provincia: p.provincia,
        municipio: p.municipio,
        estado: p.estado_producto || 'nuevo',
        cantidad: p.stock || 1,
        destacado: false,
        createdAt: p.created_at,
        tipo: 'seller',
        seller_nombre: p.sellers.nombre,
        seller_id: p.seller_id,
      }));
  } catch(e) {
    app.log.error('[PUBLIC-LOCAL-SELLERS] ' + e.message);
  }

  // Filtros a sellers
  let sellerFiltrado = sellerProds;
  if (q.provincia) sellerFiltrado = sellerFiltrado.filter(p => p.provincia === q.provincia);
  if (q.municipio) sellerFiltrado = sellerFiltrado.filter(p => p.municipio === q.municipio);
  if (q.categoria) sellerFiltrado = sellerFiltrado.filter(p => (p.category || '') === q.categoria);
  if (q.estado) sellerFiltrado = sellerFiltrado.filter(p => p.estado === q.estado);
  if (q.buscar) {
    const term = String(q.buscar).toLowerCase();
    sellerFiltrado = sellerFiltrado.filter(p => (p.title || '').toLowerCase().includes(term));
  }

  const todos = proyeccion.concat(sellerFiltrado);

  return {
    ok: true,
    total: todos.length,
    productos: todos,
  };
});

// ═══ PÚBLICO: filtros disponibles para locales ═══
app.get('/api/public/local/filtros', async () => {
  const lista = (state.productosManuales || []).filter(p =>
    p.publicado !== false && p.tipo === 'local' && p.activo !== false
  );
  const provincias = {};
  const categorias = new Set();
  for (const p of lista) {
    if (p.provincia) {
      provincias[p.provincia] = provincias[p.provincia] || new Set();
      if (p.municipio) provincias[p.provincia].add(p.municipio);
    }
    if (p.category) categorias.add(p.category);
  }
  // Convertir Sets a arrays
  const provinciasOut = {};
  for (const prov in provincias) {
    provinciasOut[prov] = [...provincias[prov]].sort();
  }
  return {
    ok: true,
    provincias: provinciasOut,
    categorias: [...categorias].sort(),
    total: lista.length,
  };
});

const PORT = process.env.PORT || 3000;

// Auto-búsqueda al arrancar si no hay productos
async function autoSearchOnStart() {
  try {
    const actual = (state.results || []).length;
    
    // Si ya hay productos suficientes, no hacer nada
    if (actual >= 500) {
      app.log.info('[AUTO-START] Ya hay ' + actual + ' productos, no se regenera');
      return;
    }
    
    // PROTECCIÓN: si hay pocos productos, verificar GitHub antes de buscar
    app.log.warn('[AUTO-START] Solo ' + actual + ' productos. Verificando GitHub...');
    
    try {
      const remoto = await leerEstado();
      if (remoto && remoto.results && remoto.results.length > 500) {
        app.log.info('[AUTO-START] GitHub tiene ' + remoto.results.length + ' productos. Cargando.');
        state.results = mergeProducts(state.results || [], remoto.results);
        if (remoto.published) state.published = remoto.published;
        if (remoto.productosManuales) state.productosManuales = remoto.productosManuales;
        if (remoto.categories) state.categories = remoto.categories;
        if (remoto.shopConfig) state.shopConfig = { ...state.shopConfig, ...remoto.shopConfig };
        await save();
        app.log.info('[AUTO-START] Restaurados ' + state.results.length + ' productos desde GitHub');
        return;
      }
    } catch(e) {
      app.log.warn('[AUTO-START] No se pudo leer GitHub: ' + e.message);
    }
    
    // Solo si GitHub también está vacío, hacer búsqueda inicial
    app.log.info('[AUTO-START] GitHub vacío. Ejecutando búsqueda inicial.');
    await runSearch('auto-start');
    app.log.info('[AUTO-START] Búsqueda completada: ' + state.results.length + ' productos');
  } catch (e) {
    app.log.error('[AUTO-START] Error: ' + e.message);
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
  scheduleIA();
  scheduleDaily();
  setTimeout(autoSearchOnStart, 15000);  // 15s para dar margen a cargarDesdeNube
});
});
