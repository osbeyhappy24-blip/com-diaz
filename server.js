// comdiaz/backend/server.js
// Comdiaz · Backend de automatización de compras y publicación

import Fastify from 'fastify';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';

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

// ---- CORS ----
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
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
  categories: DEFAULT_CATEGORIES,
  results: [],
};

const state = fs.existsSync(DB_FILE)
  ? { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }
  : structuredClone(DEFAULTS);

const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));

const adapters = {
  dummyjson: {
    label: 'DummyJSON (prueba)',
    async searchByCategory(q) {
      const res = await fetch(
        `https://dummyjson.com/products/category/${encodeURIComponent(q)}?limit=10`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.products || []).map(p => ({
        id: `${q}-${p.id}`,
        title: p.title,
        price: p.price,
        image: p.thumbnail,
        url: `https://dummyjson.com/products/${p.id}`,
        source: 'dummyjson',
      }));
    },
  },
};

async function runSearch(trigger = 'manual') {
  const started = Date.now();
  app.log.info(`Comdiaz · búsqueda iniciada (${trigger})`);
  const found = [];
  let skipped = 0;

  for (const cat of state.categories) {
    const queries = cat.dummyjson || [];
    if (!queries.length) {
      skipped++;
      continue;
    }
    for (const q of queries) {
      try {
        const items = await adapters.dummyjson.searchByCategory(q);
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
        app.log.error(`  err [${cat.label} · ${q}]: ${e.message}`);
      }
    }
    app.log.info(`  ok ${cat.label}`);
  }

  const seen = new Set();
  const unique = found.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  state.results = unique;
  state.automation.lastRun = new Date().toISOString();
  save();

  const ms = Date.now() - started;
  app.log.info(`Comdiaz · ${found.length} productos · ${skipped} categorías sin equivalente en prueba · ${ms}ms`);
  return found.length;
}

let task = null;

function timesToCron(times) {
  const hours = times
    .map(t => t.split(':')[0])
    .filter(h => /^\d{1,2}$/.test(h))
    .join(',');
  return `0 ${hours} * * *`;
}

function computeNextRuns(times) {
  const now = new Date();
  return times
    .map(t => {
      const [h, m] = t.split(':').map(Number);
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      return d;
    })
    .filter(d => d > now)
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

app.get('/api/state', async () => state);

app.post('/api/automation/play', async () => {
  const delay = state.automation.delaySeconds;
  app.log.info(`Comdiaz · arranca en ${delay}s`);
  setTimeout(() => {
    state.automation.running = true;
    save();
    runSearch('arranque');
  }, delay * 1000);
  return { ok: true, message: `Arranca en ${delay}s`, delay };
});

app.post('/api/automation/pause', async () => {
  state.automation.running = false;
  save();
  app.log.info('Comdiaz · automatización pausada');
  return { ok: true };
});

app.post('/api/margin', async (req) => {
  state.margin = Number(req.body?.margin) || state.margin;
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
  const maxTotal = Number(req.body?.limit) || 30;
  const perCat = Number(req.body?.perCategory) || 5;
  const onlyCats = Array.isArray(req.body?.categories) && req.body.categories.length
    ? req.body.categories
    : [...new Set(state.results.map(r => r.category))];

  const grouped = {};
  for (const r of state.results) {
    if (!onlyCats.includes(r.category)) continue;
    grouped[r.category] = grouped[r.category] || [];
    if (grouped[r.category].length < perCat) grouped[r.category].push(r);
  }

  const out = [];
  out.push('\uD83D\uDECD *Comdiaz - Ofertas disponibles*');
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

  return { ok: true, text: out.join('\n'), count };
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
