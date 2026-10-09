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

// Zona horaria configurable (por defecto Cuba = America/Havana)
const APP_TZ = process.env.COMDIAZ_TZ || 'America/Havana';


// Tolerar body vacío cuando Content-Type es JSON
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (!body || body.length === 0) return done(null, {});
  try { done(null, JSON.parse(body)); }
  catch (e) { done(e); }
});



// ---- Auth por API Key ----
app.addHook('onRequest', async (req, reply) => {
  // Solo exige auth en /api/* (deja pasar el root y OPTIONS)
  if (!req.url.startsWith('/api/')) return;
  if (req.method === 'OPTIONS') return;
  // EXCEPCIÓN: /api/auth no requiere clave (es la que la valida)
  if (req.url.startsWith('/api/auth')) return;
  if (req.url.startsWith('/api/pin/change')) return;
  const expected = state.pin;
  if (!expected) return;
  const got = req.headers['x-comdiaz-key'] || req.query?.k;
  if (got !== expected) {
    reply.code(401).send({ ok: false, error: 'No autorizado' });
  }
});

// ---- CORS ----
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Comdiaz-Key');
});
app.options('*', async (req, reply) => reply.code(204).send());


const DB_FILE = path.join(process.cwd(), 'data.json');

// 45 categorías por defecto de Comdiaz
// dummyjson: [] significa "sin equivalente en la prueba, listo para Amazon/SheIn"
const DEFAULT_CATEGORIES = [
  { label: 'Ropa de Mujer',                 dummyjson: ['womens-dresses', 'tops'] },
  { label: 'Ropa de Hombre',                dummyjson: ['mens-shirts'] },
  { label: 'Ropa Infantil',                 dummyjson: [] },
  { label: 'Calzado',                       dummyjson: ['mens-shoes', 'womens-shoes'] },
  { label: 'Bolsos y Mochilas',             dummyjson: ['womens-bags'] },
  { label: 'Bisutería y Accesorios',        dummyjson: ['womens-jewellery', 'womens-watches', 'mens-watches'] },
  { label: 'Belleza',                       dummyjson: ['beauty', 'skin-care', 'fragrances'] },
  { label: 'Cabello',                       dummyjson: [] },
  { label: 'Barbería',                      dummyjson: [] },
  { label: 'Hogar',                         dummyjson: ['home-decoration', 'furniture'] },
  { label: 'Cocina',                        dummyjson: ['kitchen-accessories', 'groceries'] },
  { label: 'Electrodomésticos',             dummyjson: ['kitchen-accessories'] },
  { label: 'Electrónica',                   dummyjson: ['laptops', 'tablets', 'mobile-accessories'] },
  { label: 'Teléfonos y Accesorios',        dummyjson: ['smartphones', 'mobile-accessories'] },
  { label: 'Computación',                   dummyjson: ['laptops', 'tablets'] },
  { label: 'Energía e Iluminación',         dummyjson: [] },
  { label: 'Automóviles',                   dummyjson: ['vehicle'] },
  { label: 'Piezas de Automóviles',         dummyjson: [] },
  { label: 'Motos',                         dummyjson: ['motorcycle'] },
  { label: 'Bicicletas',                    dummyjson: [] },
  { label: 'Ferretería',                    dummyjson: [] },
  { label: 'Herramientas',                  dummyjson: [] },
  { label: 'Electricidad',                  dummyjson: [] },
  { label: 'Plomería',                      dummyjson: [] },
  { label: 'Pintura',                       dummyjson: [] },
  { label: 'Agricultura y Jardinería',      dummyjson: [] },
  { label: 'Deportes',                      dummyjson: ['sports-accessories'] },
  { label: 'Niños y Juguetes',              dummyjson: [] },
  { label: 'Material Escolar',              dummyjson: [] },
  { label: 'Oficina',                       dummyjson: [] },
  { label: 'Fotografía y Creación de Contenido', dummyjson: [] },
  { label: 'Productos para Negocios',       dummyjson: [] },
  { label: 'Repuestos de Electrodomésticos', dummyjson: [] },
  { label: 'Reparación de Teléfonos',       dummyjson: ['mobile-accessories'] },
  { label: 'Mascotas',                      dummyjson: [] },
  { label: 'Viajes',                        dummyjson: [] },
  { label: 'Fiestas y Eventos',             dummyjson: [] },
  { label: 'Costura',                       dummyjson: [] },
  { label: 'Manualidades',                  dummyjson: [] },
  { label: 'Seguridad',                     dummyjson: [] },
  { label: 'Limpieza',                      dummyjson: [] },
  { label: 'Accesibilidad',                 dummyjson: [] },
  { label: 'Regalos',                       dummyjson: [] },
  { label: 'Productos Profesionales',       dummyjson: [] },
  { label: 'Energía Solar',                 dummyjson: [] },
];

const DEFAULTS = {
  automation: {
    running: false,
    delaySeconds: 5,
    publishTimes: ['09:00', '15:00', '21:00'],
    lastRun: null,
    nextRuns: [],
  },
  margin: 35,
  pin: '985898',
  loginAttempts: {}, // IP -> { count, blockedUntil }
  activityLog: [], // ultimos eventos
  categories: DEFAULT_CATEGORIES,
  results: [],
  sources: JSON.parse(JSON.stringify(DEFAULT_SOURCE_STATE)),
};

const state = fs.existsSync(DB_FILE)
  ? { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }
  : structuredClone(DEFAULTS);

const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));

const adapters = {
  async searchFrom(sourceId, query, sourceState) {
    const src = SOURCES[sourceId];
    if (!src) throw new Error('Fuente desconocida: ' + sourceId);
    const st = sourceState[sourceId] || {};
    if (!st.enabled) return [];
    return await src.searchByCategory(query, st.config || {});
  }
};


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
  out.push('Pedidos por WhatsApp');
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
    const queries = cat.dummyjson || [];
    if (!queries.length) { skipped++; continue; }
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

  task = cron.schedule(expr, () => {
    if (!state.automation.running) {
      app.log.warn('Cron disparó pero automatización en pausa.');
      return;
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
  // Activa el estado INMEDIATAMENTE
  state.automation.running = true;
  await save();
  app.log.info('Comdiaz · play activado, primera búsqueda en ' + delay + 's');
  logActivity('play', { delay });
  // Solo la primera búsqueda se retrasa
  setTimeout(() => {
    if (state.automation.running) {
      runSearch('arranque');
    }
  }, delay * 1000);
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
  state.margin = Number(req.body?.margin) || state.margin;
  const marginViejo = state.margin;
  state.margin = Number(req.body?.margin) || state.margin;
  if (marginViejo !== state.margin) logActivity('margin', { viejo: marginViejo, nuevo: state.margin });
  // Evitar doble asignacion
  state.margin = state.margin;
  state.results = state.results.map(r => ({
    ...r,
    salePrice: +(r.basePrice * (1 + state.margin / 100)).toFixed(2),
    marginPct: state.margin,
  }));
  save();
  return { ok: true, margin: state.margin };
});

app.post('/api/categories/add', async (req) => {
  const label = String(req.body?.label || req.body?.category || '').trim();
  const dummyjson = Array.isArray(req.body?.dummyjson) ? req.body.dummyjson : [];
  if (!label) return { ok: false, error: 'label requerido' };
  if (!state.categories.find(c => c.label === label)) {
    state.categories.push({ label, dummyjson });
    save();
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

const PORT = process.env.PORT || 3000;

app.listen({ port: PORT, host: '0.0.0.0' }, () => {
  console.log(BRAND);
  console.log(`Comdiaz backend en http://localhost:${PORT}`);
  console.log(`Categorías activas: ${state.categories.length}`);
  console.log(`Margen: ${state.margin}%`);
  console.log(`Publicaciones: ${state.automation.publishTimes.join(' · ')}`);
  console.log(`Estado: ${state.automation.running ? 'ACTIVO' : 'EN PAUSA'}\n`);
  schedule();
});
