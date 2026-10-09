// comdiaz/backend/ebay.js
// Adapter de eBay con manejo de OAuth y cache de token

const EBAY_SANDBOX_API  = 'https://api.sandbox.ebay.com';
const EBAY_PROD_API     = 'https://api.ebay.com';

// Cache del token por entorno
const tokenCache = {
  sandbox:    { token: null, expiresAt: 0 },
  production: { token: null, expiresAt: 0 },
};

// Obtener token (con cache de 2 horas)
async function getAccessToken(config = {}) {
  const env = config.environment === 'production' ? 'production' : 'sandbox';
  const appId  = config.appId  || process.env.EBAY_APP_ID;
  const certId = config.certId || process.env.EBAY_CERT_ID;

  if (!appId || !certId) {
    throw new Error('eBay: faltan App ID o Cert ID');
  }

  // ¿Token válido en cache?
  const cache = tokenCache[env];
  if (cache.token && cache.expiresAt > Date.now() + 60000) {
    return { token: cache.token, env };
  }

  // Pedir token nuevo
  const base = env === 'production' ? EBAY_PROD_API : EBAY_SANDBOX_API;
  const auth = Buffer.from(appId + ':' + certId).toString('base64');

  const res = await fetch(base + '/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + auth,
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });

  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error('eBay auth ' + res.status + ': ' + errTxt.slice(0, 200));
  }

  const data = await res.json();
  cache.token = data.access_token;
  cache.expiresAt = Date.now() + (data.expires_in - 300) * 1000; // renueva 5 min antes
  return { token: cache.token, env };
}

// Mapear categorías Comdiaz → palabras clave eBay
const CATEGORY_KEYWORDS = {
  'Ropa de Mujer':                 'women dress',
  'Ropa de Hombre':                'men shirt',
  'Ropa Infantil':                 'kids clothes',
  'Calzado':                       'shoes',
  'Bolsos y Mochilas':             'handbag',
  'Bisutería y Accesorios':        'jewelry',
  'Belleza':                       'makeup',
  'Cabello':                       'hair',
  'Barbería':                      'razor',
  'Hogar':                         'home decor',
  'Cocina':                        'kitchen',
  'Electrodomésticos':             'appliance',
  'Electrónica':                   'electronics',
  'Teléfonos y Accesorios':        'phone case',
  'Computación':                   'laptop',
  'Energía e Iluminación':         'light',
  'Automóviles':                   'car',
  'Piezas de Automóviles':         'auto part',
  'Motos':                         'motorcycle',
  'Bicicletas':                    'bicycle',
  'Ferretería':                    'hardware',
  'Herramientas':                  'tool',
  'Electricidad':                  'electrical',
  'Plomería':                      'plumbing',
  'Pintura':                       'paint',
  'Agricultura y Jardinería':      'garden',
  'Deportes':                      'sports',
  'Niños y Juguetes':              'toy',
  'Material Escolar':              'stationery',
  'Oficina':                       'office',
  'Fotografía y Creación de Contenido': 'camera',
  'Productos para Negocios':       'business',
  'Repuestos de Electrodomésticos':'appliance part',
  'Reparación de Teléfonos':       'phone screen',
  'Mascotas':                      'pet',
  'Viajes':                        'luggage',
  'Fiestas y Eventos':             'party',
  'Costura':                       'sewing',
  'Manualidades':                  'craft',
  'Seguridad':                     'security',
  'Limpieza':                      'cleaning',
  'Accesibilidad':                 'accessibility',
  'Regalos':                       'gift',
  'Productos Profesionales':       'professional',
  'Energía Solar':                 'solar',
};

// Buscar productos en eBay
async function searchByCategory(categoryLabel, config = {}) {
  const { token, env } = await getAccessToken(config);
  const base = env === 'production' ? EBAY_PROD_API : EBAY_SANDBOX_API;

  // Convertir categoría a keywords
  const query = CATEGORY_KEYWORDS[categoryLabel] || categoryLabel;

  // Construir filtros
  const filters = [];
  if (config.condition && config.condition !== 'any') {
    filters.push('conditions:{' + config.condition + '}');
  }
  if (config.priceMin || config.priceMax) {
    let priceFilter = 'price:[' + (config.priceMin || '') + '..' + (config.priceMax || '') + ']';
    priceFilter += ',priceCurrency:USD';
    filters.push(priceFilter);
  }
  if (config.buyingOptions) {
    filters.push('buyingOptions:{' + config.buyingOptions + '}');
  }

  const filterParam = filters.length ? '&filter=' + filters.join(',') : '';

  const url = base + '/buy/browse/v1/item_summary/search?q=' +
    encodeURIComponent(query) +
    '&limit=' + (config.limit || 20) +
    filterParam;

  const res = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'X-EBAY-C-MARKETPLACE-ID': config.marketplace || 'EBAY_US',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('eBay search ' + res.status + ': ' + err.slice(0, 200));
  }

  const data = await res.json();
  const items = data.itemSummaries || [];

  return items.map(it => {
    const img = it.image?.imageUrl || (it.thumbnailImages && it.thumbnailImages[0]?.imageUrl) || '';
    const price = parseFloat(it.price?.value) || 0;

    // Recolectar TODAS las imágenes disponibles
    const allImages = [];
    if (img) allImages.push(img.replace('http://', 'https://'));
    (it.thumbnailImages || []).forEach(t => {
      if (t.imageUrl) {
        const url = t.imageUrl.replace('http://', 'https://');
        if (!allImages.includes(url)) allImages.push(url);
      }
    });
    (it.additionalImages || []).forEach(t => {
      if (t.imageUrl) {
        const url = t.imageUrl.replace('http://', 'https://');
        if (!allImages.includes(url)) allImages.push(url);
      }
    });

    return {
      id: 'ebay-' + (it.itemId || Math.random().toString(36).slice(2)),
      title: it.title || 'Sin título',
      price: price,
      image: img.replace('http://', 'https://'),
      images: allImages.slice(0, 5),
      url: (function() {
        const u = it.itemWebUrl || '';
        // Extraer solo https://www.ebay.com/itm/ITEM_ID
        const m = u.match(/ebay\.com\/itm\/(\d+)/);
        return m ? 'https://www.ebay.com/itm/' + m[1] : u;
      })(),
      source: 'ebay',
      extra: {
        condition: it.condition || '',
        currency: it.price?.currency || 'USD',
        seller: it.seller?.feedbackScore || 0,
      },
    };
  }).filter(p => p.price > 0);
}

export { searchByCategory, getAccessToken, CATEGORY_KEYWORDS };
