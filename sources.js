import { searchByCategory as ebaySearch } from './ebay.js';

// comdiaz/backend/sources.js
// Registro de fuentes (adapters) de productos

// ─────────────────────────────────────────────
//  Cada fuente tiene:
//  - id, label, emoji
//  - needsKey: si requiere credenciales
//  - keyFields: campos a pedir en el Home
//  - docsUrl: link para obtener las credenciales
//  - searchByCategory(query, cfg): la función de búsqueda
// ─────────────────────────────────────────────

const DUMMY_BASE = 'https://dummyjson.com/products/category/';
const ML_BASE = 'https://api.mercadolibre.com/sites/MLM/search';

export const SOURCES = {
  dummyjson: {
    id: 'dummyjson',
    label: 'DummyJSON (prueba)',
    emoji: '🧪',
    needsKey: false,
    keyFields: [],
    docsUrl: 'https://dummyjson.com',
    async searchByCategory(query) {
      const res = await fetch(DUMMY_BASE + encodeURIComponent(query) + '?limit=10');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return (data.products || []).map(p => ({
        id: 'dummyjson-' + query + '-' + p.id,
        title: p.title,
        price: Number(p.price) || 0,
        image: p.thumbnail,
        url: 'https://dummyjson.com/products/' + p.id,
        source: 'dummyjson',
      }));
    },
  },


  ebay: {
    id: 'ebay',
    label: 'eBay',
    emoji: '🛒',
    needsKey: true,
    keyFields: ['appId', 'certId'],
    docsUrl: 'https://developer.ebay.com/my/keys',
    async searchByCategory(query, config) {
      const environment = config?.environment || 'sandbox';
      const appId = config?.appId;
      const certId = config?.certId;
      if (!appId || !certId) {
        throw new Error('eBay: faltan App ID y Cert ID. Configúralos en el Home.');
      }
      return await ebaySearch(query, { environment, appId, certId, limit: 10 });
    },
  },

  mercadolibre: {
    id: 'mercadolibre',
    label: 'MercadoLibre',
    emoji: '🛒',
    needsKey: false,
    keyFields: [],
    docsUrl: 'https://developers.mercadolibre.com',
    async searchByCategory(query) {
      const url = ML_BASE + '?q=' + encodeURIComponent(query) + '&limit=10';
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Referer': 'https://www.mercadolibre.com.mx/',
        },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return (data.results || []).map(r => ({
        id: 'ml-' + r.id,
        title: r.title,
        price: Number(r.price) || 0,
        image: (r.thumbnail || '').replace('http://', 'https://'),
        url: r.permalink,
        source: 'mercadolibre',
      }));
    },
  },

  amazon: {
    id: 'amazon',
    label: 'Amazon PA-API',
    emoji: '📦',
    needsKey: true,
    keyFields: ['accessKey', 'secretKey', 'partnerTag'],
    docsUrl: 'https://webservices.amazon.com/paapi5/documentation/',
    async searchByCategory() {
      throw new Error('Amazon PA-API requiere credenciales aprobadas. Configura las keys en el Home.');
    },
  },

  shein: {
    id: 'shein',
    label: 'SheIn',
    emoji: '👗',
    needsKey: true,
    keyFields: ['apiKey'],
    docsUrl: 'https://shein.com',
    async searchByCategory() {
      throw new Error('SheIn no tiene API pública. Pendiente de integración.');
    },
  },
};

export const DEFAULT_SOURCE_STATE = {
  dummyjson:    { enabled: true,  config: {} },
  mercadolibre: { enabled: false, config: {} },
  amazon:       { enabled: false, config: { accessKey: '', secretKey: '', partnerTag: '' } },
  shein:        { enabled: false, config: { apiKey: '' } },
  ebay:         { enabled: false, config: { environment: 'sandbox', appId: '', certId: '' } },
};

export function listSources() {
  return Object.values(SOURCES).map(s => ({
    id: s.id,
    label: s.label,
    emoji: s.emoji,
    needsKey: s.needsKey,
    keyFields: s.keyFields,
    docsUrl: s.docsUrl,
  }));
}
