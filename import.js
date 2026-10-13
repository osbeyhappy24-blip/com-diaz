// Comdiaz Import Hub - Multi-fuente via Apify
// Fuentes soportadas: temu, amazon, walmart

import { ApifyClient } from 'apify-client';

let apifyClient = null;

export function initApify(token) {
  if (!token) return null;
  apifyClient = new ApifyClient({ token });
  return apifyClient;
}

export function isApifyReady() {
  return !!apifyClient;
}

// ─── Configuración de cada fuente ───
export const SOURCES_CONFIG = {
  temu: {
    label: 'Temu',
    icon: '🛍️',
    actor: 'scrapesage/temu-scraper',
    inputFn: (keyword, maxResults) => ({
      searchTerms: [keyword],
      maxResults
    }),
    mapper: (it) => ({
      id: 'temu-' + (it.productId || it.id || Date.now()),
      title: it.title || 'Producto Temu',
      image: it.imageUrl || it.image || '',
      images: it.imageUrl ? [it.imageUrl] : (it.images || []),
      priceBase: Number(it.price || 0),
      url: it.url || '',
      source: 'temu',
      category: 'Importado'
    })
  },
  amazon: {
    label: 'Amazon',
    icon: '📦',
    actor: 'powerai/amazon-product-search-scraper',
    inputFn: (keyword, maxResults) => ({
      keyword,
      maxResults
    }),
    mapper: (it) => {
      const priceStr = String(it.product_price || it.product_minimum_offer_price || '0').replace(/[^0-9.]/g, '');
      return {
        id: 'amazon-' + (it.asin || Date.now()),
        title: it.product_title || 'Producto Amazon',
        image: it.product_photo || '',
        images: it.product_photo ? [it.product_photo] : [],
        priceBase: Number(priceStr) || 0,
        url: it.product_url || '',
        source: 'amazon',
        category: 'Importado'
      };
    }
  },
  walmart: {
    label: 'Walmart',
    icon: '🏪',
    actor: 'burbn/walmart-product-search',
    inputFn: (keyword, maxResults) => ({
      query: keyword,
      maxResults
    }),
    mapper: (it) => ({
      id: 'walmart-' + (it.productId || it.usItemId || Date.now()),
      title: it.title || 'Producto Walmart',
      image: it.image || it.thumbnail || '',
      images: it.image ? [it.image] : [],
      priceBase: Number(it.price || it.primaryOffer?.offer_price || 0),
      url: it.url || '',
      source: 'walmart',
      category: 'Importado'
    })
  }
};

// ─── Buscar en una fuente ───
export async function searchSource(source, keyword, maxResults = 20) {
  if (!apifyClient) throw new Error('Apify no configurado');
  const config = SOURCES_CONFIG[source];
  if (!config) throw new Error('Fuente no soportada: ' + source);
  
  const input = config.inputFn(keyword, maxResults);
  console.log('[IMPORT] Buscando en ' + source + ': ' + keyword);
  
  const run = await apifyClient.actor(config.actor).call(input, { timeout: 180 });
  const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
  
  const products = (items || [])
    .map(config.mapper)
    .filter(p => p.title && p.priceBase > 0);
  
  console.log('[IMPORT] ' + source + ' → ' + products.length + ' productos');
  return products;
}

// ─── Importar productos a la tienda (los añade como manuales) ───
export function buildProductsForShop(products, marginPct) {
  return products.map(p => {
    const salePrice = +(p.priceBase * (1 + marginPct / 100)).toFixed(2);
    return {
      id: p.id,
      title: String(p.title).slice(0, 200),
      image: p.image,
      images: p.images || [p.image],
      category: p.category || 'Importado',
      description: '',
      priceBase: p.priceBase,
      salePrice: salePrice,
      margenPct: marginPct,
      cantidad: 1,
      publicado: true,
      source: p.source,
      sourceUrl: p.url,
      createdAt: new Date().toISOString()
    };
  });
}
