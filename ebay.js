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
  'Ropa de Mujer':                 'dress',
  'Ropa de Hombre':                'shirt',
  'Ropa Infantil':                 'kids',
  'Calzado':                       'shoes',
  'Bolsos y Mochilas':             'bag',
  'Bisutería y Accesorios':        'watch',
  'Belleza':                       'perfume',
  'Cabello':                       'shampoo',
  'Barbería':                      'razor',
  'Hogar':                         'decor',
  'Cocina':                        'kitchen',
  'Electrodomésticos':             'appliance',
  'Electrónica':                   'phone',
  'Teléfonos y Accesorios':        'iphone',
  'Computación':                   'laptop',
  'Energía e Iluminación':         'led',
  'Automóviles':                   'car',
  'Piezas de Automóviles':         'auto parts',
  'Motos':                         'motorcycle',
  'Bicicletas':                    'bicycle',
  'Ferretería':                    'tools',
  'Herramientas':                  'drill',
  'Electricidad':                  'cable',
  'Plomería':                      'plumbing',
  'Pintura':                       'paint',
  'Agricultura y Jardinería':      'garden',
  'Deportes':                      'sports',
  'Niños y Juguetes':              'toys',
  'Material Escolar':              'notebook',
  'Oficina':                       'office',
  'Fotografía y Creación de Contenido': 'camera',
  'Productos para Negocios':       'business',
  'Repuestos de Electrodomésticos':'parts',
  'Reparación de Teléfonos':       'phone repair',
  'Mascotas':                      'pet',
  'Viajes':                        'luggage',
  'Fiestas y Eventos':             'party',
  'Costura':                       'sewing',
  'Manualidades':                  'craft',
  'Seguridad':                     'camera',
  'Limpieza':                      'cleaning',
  'Accesibilidad':                 'accessibility',
  'Regalos':                       'gift',
  'Productos Profesionales':       'tools',
  'Energía Solar':                 'solar',
};

// Buscar productos en eBay
async function searchByCategory(categoryLabel, config = {}) {
  const { token, env } = await getAccessToken(config);
  const base = env === 'production' ? EBAY_PROD_API : EBAY_SANDBOX_API;

  // Convertir categoría a keywords
  const query = CATEGORY_KEYWORDS[categoryLabel] || categoryLabel;

  const url = base + '/buy/browse/v1/item_summary/search?q=' +
    encodeURIComponent(query) +
    '&limit=' + (config.limit || 10) +
    '';

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
    return {
      id: 'ebay-' + (it.itemId || Math.random().toString(36).slice(2)),
      title: it.title || 'Sin título',
      price: price,
      image: img.replace('http://', 'https://'),
      url: it.itemWebUrl || '',
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
