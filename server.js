require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

const SHOPIFY_URL = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01`;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CACHE_KEY = 'jg_all_products';
const CACHE_TTL = 60 * 5;

const SYSTEM_PROMPT = `You are a helpful shopping assistant for Joella Grace Jewelry,
a vintage and antique jewelry store. Be warm, elegant and knowledgeable.

Store Information:
- We specialize in vintage, antique, and custom engagement rings
- Free expedited shipping on all orders worldwide
- 14-day return window on all purchases
- Custom jewelry design services available
- Price range: $500 to $25,000+

IMPORTANT: Never make up or invent product names, prices, or descriptions.
If asked about specific products, only describe what you know about our store generally.
Keep responses short, warm and friendly.`;

// ─── Redis ────────────────────────────────────────────────────────────────────
async function redisGet(key) {
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const data = await res.json();
    if (!data.result) return null;
    // Value may have been stored double-encoded — unwrap until we get the real array
    let v = data.result;
    for (let i = 0; i < 3 && typeof v === 'string'; i++) v = JSON.parse(v);
    return Array.isArray(v) ? v : null;
  } catch (e) { console.error('redisGet error:', e.message); return null; }
}

async function redisSet(key, value, ttl) {
  try {
    const body = JSON.stringify(JSON.stringify(value));
    const r = await fetch(`${REDIS_URL}/set/${key}?EX=${ttl}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body
    });
    const ok = r.ok;
    if (!ok) console.error(`redisSet failed: ${r.status} (${(body.length / 1048576).toFixed(2)} MB)`);
    return { ok, bytes: body.length };
  } catch (e) { console.error('redisSet error:', e.message); return { ok: false, bytes: 0 }; }
}

// ─── Fetch all products from Shopify Admin ────────────────────────────────────
// Keep only the fields the search needs so the whole catalogue (5,000+ items)
// fits comfortably in the Redis cache.
function slimProduct(p) {
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    product_type: p.product_type,
    tags: p.tags,
    created_at: p.created_at,
    body_html: (p.body_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
    variants: (p.variants || []).slice(0, 3).map(v => ({
      id: v.id,
      price: v.price,
      inventory_management: v.inventory_management,
      inventory_quantity: v.inventory_quantity
    })),
    images: (p.images || []).slice(0, 1).map(i => ({ src: i.src }))
  };
}

async function fetchAllFromShopify() {
  let allProducts = [];
  const fields = 'id,title,handle,product_type,tags,created_at,body_html,variants,images';
  let url = `${SHOPIFY_URL}/products.json?limit=250&status=active&fields=${fields}`;
  let pages = 0;
  while (url && pages < 100) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
    if (!res.ok) throw new Error(`Shopify responded ${res.status} on page ${pages + 1}`);
    const data = await res.json();
    if (data.products) for (const p of data.products) allProducts.push(slimProduct(p));
    const linkHeader = res.headers.get('link');
    const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    pages++;
  }
  console.log(`Fetched ${allProducts.length} products in ${pages} pages`);
  return allProducts;
}

let memCache = { at: 0, data: null };
async function getAllProducts() {
  const cached = await redisGet(CACHE_KEY);
  if (Array.isArray(cached) && cached.length > 0) { console.log(`Cache hit: ${cached.length} products`); return cached; }
  if (memCache.data && Date.now() - memCache.at < CACHE_TTL * 1000) { console.log(`Memory cache hit: ${memCache.data.length}`); return memCache.data; }
  console.log('Cache miss — fetching from Shopify...');
  const products = await fetchAllFromShopify();
  if (products.length > 0) {
    memCache = { at: Date.now(), data: products };
    await redisSet(CACHE_KEY, products, CACHE_TTL);
  }
  return products;
}

// ─── AI: intent + structured search filters ───────────────────────────────────
async function analyzeMessage(userMessage) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You analyze messages sent to the chat assistant of a vintage jewelry and antiques store (rings, watches, necklaces, pendants, earrings, bracelets, brooches, cufflinks, charms, coins, etc.).
Return a JSON object with exactly these fields:
- "isProduct": true if the user wants to SEE, FIND, BROWSE or BUY any item (even vaguely, e.g. "something cheap", "gift for my wife", "newest items"). When in doubt return true. false only for policies, shipping, returns, custom-design questions, greetings, thanks.
- "query": ONLY the product type and material/gem/style words, singular, lowercase, max 3 words (e.g. "diamond ring", "watch", "sapphire necklace", "gold bracelet"). Never include price, sorting or filler words. Use "" when no specific product type or material is named.
- "sort": one of "relevance", "price_asc" (cheapest/lowest/affordable/budget), "price_desc" (most expensive/luxury/highest), "newest" (newest/latest/recent/new arrivals), "oldest". Default "relevance".
- "maxPrice": number or null. "under $1000", "below 500", "$500 or less", "up to 2k", "less than 1k" -> that number (1k = 1000).
- "minPrice": number or null. "over $5000", "above 2k", "at least 300", "starting from 1000" -> that number.
  "between $1000 and $2000" -> minPrice 1000, maxPrice 2000. "around $2000" -> minPrice 1600, maxPrice 2400.
Examples:
"show me few watches" -> {"isProduct":true,"query":"watch","sort":"relevance","maxPrice":null,"minPrice":null}
"cheapest diamond ring" -> {"isProduct":true,"query":"diamond ring","sort":"price_asc","maxPrice":null,"minPrice":null}
"engagement rings under $1000" -> {"isProduct":true,"query":"engagement ring","sort":"relevance","maxPrice":1000,"minPrice":null}
"newest items" -> {"isProduct":true,"query":"","sort":"newest","maxPrice":null,"minPrice":null}
"what is your return policy" -> {"isProduct":false,"query":"","sort":"relevance","maxPrice":null,"minPrice":null}`
        },
        { role: 'user', content: userMessage }
      ]
    });
    const j = JSON.parse(res.choices[0].message.content.trim());
    const num = v => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
    const regex = parsePriceFilters(userMessage);
    return {
      isProduct: !!j.isProduct,
      query: String(j.query || '').toLowerCase().trim(),
      sort: ['price_asc', 'price_desc', 'newest', 'oldest'].includes(j.sort) ? j.sort : 'relevance',
      maxPrice: num(j.maxPrice) ?? regex.maxPrice,
      minPrice: num(j.minPrice) ?? regex.minPrice
    };
  } catch (e) {
    console.error('analyzeMessage error:', e.message);
    return { isProduct: false, query: '', sort: 'relevance', maxPrice: null, minPrice: null };
  }
}

// ─── Availability filter ──────────────────────────────────────────────────────
function isAvailable(p) {
  const title = p.title.toLowerCase();
  const price = parseFloat(p.variants[0]?.price || 0);
  if (price <= 0) return false;
  if (title.startsWith('sold')) return false;
  // If Shopify tracks inventory, need stock > 0
  const hasStock = p.variants.some(v => {
    if (!v.inventory_management || v.inventory_management === 'none') return true;
    return v.inventory_quantity > 0;
  });
  return hasStock;
}

// ─── Price filter parser ──────────────────────────────────────────────────────
function parsePriceFilters(msg) {
  const maxMatch = msg.match(/(?:under|below|less\s+than|max|maximum|budget\s+of|up\s+to)\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
  const minMatch = msg.match(/(?:over|above|more\s+than|at\s+least|starting\s+from)\s*\$?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
  return {
    maxPrice: maxMatch ? parseFloat(maxMatch[1].replace(/,/g, '')) : null,
    minPrice: minMatch ? parseFloat(minMatch[1].replace(/,/g, '')) : null
  };
}

function formatProduct(p) {
  return {
    title: p.title,
    price: p.variants[0]?.price || '0.00',
    image: p.images[0]?.src || null,
    url: `https://${SHOPIFY_STORE}/products/${p.handle}`,
    inStock: p.variants.some(v => v.inventory_quantity > 0),
    tags: p.tags || '',
    product_type: p.product_type || '',
    variant_id: p.variants[0]?.id || null
  };
}

// ─── Search over the FULL cached catalogue ────────────────────────────────────
const stem = t => t.replace(/ies$/, 'y').replace(/(ch|sh|x|ss)es$/, '$1').replace(/(?<!s)s$/, '');
const priceOf = p => parseFloat(p.variants[0]?.price || 0);

async function searchProducts(intent) {
  try {
    const { query, sort, maxPrice, minPrice } = intent;
    const wantsMounting = /mount/i.test(query);
    const allProducts = await getAllProducts();

    // 1) availability, price range, mountings
    let pool = allProducts.filter(isAvailable);
    if (maxPrice) pool = pool.filter(p => priceOf(p) <= maxPrice);
    if (minPrice) pool = pool.filter(p => priceOf(p) >= minPrice);
    if (!wantsMounting) pool = pool.filter(p => !/\bmount(ing)?\b/i.test(p.title));

    // 2) strict AND match on every query term
    const terms = query.split(/\s+/).map(stem).filter(t => t.length > 1);
    let matched = pool;
    if (terms.length > 0) {
      // Word-start matching: "ring" matches ring/rings but NOT earring/earrings
      const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Longer words (5+ letters) may also end a compound word: "watch" matches "Wristwatch"
      const res = terms.map(t => new RegExp('\\b' + esc(t) + (t.length >= 5 ? '|(?<=[a-z])' + esc(t) + '(?:e?s)?\\b' : ''), 'i'));
      const hasAll = text => res.every(r => r.test(text));
      const head = p => [p.title, p.product_type, p.tags].join(' ');
      const full = p => head(p) + ' ' + (p.body_html || '');
      matched = pool.filter(p => hasAll(head(p)));
      if (matched.length === 0) matched = pool.filter(p => hasAll(full(p)));
      const phrase = new RegExp('\\b' + terms.map(esc).join('\\s+'), 'i');
      const score = p => (phrase.test(p.title) ? 50 : 0) + res.filter(r => r.test(p.title)).length * 10;
      matched.sort((a, b) => score(b) - score(a) || new Date(b.created_at) - new Date(a.created_at));
    } else {
      matched = [...pool].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    // 3) requested ordering
    if (sort === 'price_asc') matched.sort((a, b) => priceOf(a) - priceOf(b));
    else if (sort === 'price_desc') matched.sort((a, b) => priceOf(b) - priceOf(a));
    else if (sort === 'newest') matched.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    else if (sort === 'oldest') matched.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    console.log(`Search "${query}" sort=${sort} max=${maxPrice} min=${minPrice} → ${matched.length} matches`);
    return matched.slice(0, 6).map(formatProduct);
  } catch (err) {
    console.error('searchProducts error:', err);
    return [];
  }
}

// ─── Chat endpoint ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    const intent = await analyzeMessage(message);
    console.log('Intent:', JSON.stringify(intent));

    if (intent.isProduct) {
      const products = await searchProducts(intent);
      if (products.length > 0) return res.json({ type: 'products', text: "Here are some pieces from our collection!", products });

      const { query, maxPrice, minPrice } = intent;
      const fmt = n => '$' + n.toLocaleString('en-US');
      const what = query ? `"${query}" pieces` : 'pieces';
      if (maxPrice || minPrice) {
        const range = maxPrice && minPrice ? `between ${fmt(minPrice)} and ${fmt(maxPrice)}` : maxPrice ? `under ${fmt(maxPrice)}` : `over ${fmt(minPrice)}`;
        return res.json({ type: 'text', text: `I couldn't find any available ${what} ${range} right now. Would you like to try a different price range?` });
      }
      return res.json({ type: 'text', text: `We don't currently have any ${what} available in our collection. We specialize in vintage and antique rings, necklaces, earrings, bracelets, brooches, watches, and more. Can I help you find something similar?` });
    }

    const reply = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: message }]
    });
    res.json({ type: 'text', text: reply.choices[0].message.content });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── Related products ─────────────────────────────────────────────────────────
app.post('/api/related', async (req, res) => {
  try {
    const { title, tags, product_type } = req.body;
    const allProducts = await getAllProducts();
    if (!allProducts.length) return res.json({ products: [] });

    const titleLower = (title || '').toLowerCase();
    const available = allProducts.filter(isAvailable);
    const searchTerms = [
      ...(tags || '').split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 2),
      (product_type || '').toLowerCase().trim()
    ].filter(Boolean);

    if (searchTerms.length === 0) {
      return res.json({ products: available.filter(p => p.title.toLowerCase() !== titleLower).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 3).map(formatProduct) });
    }

    const scored = available.map(p => {
      if (p.title.toLowerCase() === titleLower) return { product: p, score: -1 };
      const text = [p.title, p.product_type, p.tags].join(' ').toLowerCase();
      let score = 0;
      searchTerms.forEach(t => { if (text.includes(t)) score++; if (p.title.toLowerCase().includes(t)) score++; });
      return { product: p, score };
    });

    const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(s => formatProduct(s.product));
    if (matched.length === 0) {
      return res.json({ products: available.filter(p => p.title.toLowerCase() !== titleLower).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 3).map(formatProduct) });
    }
    res.json({ products: matched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Cache refresh ────────────────────────────────────────────────────────────
app.post('/api/refresh-cache', async (req, res) => {
  try {
    const products = await fetchAllFromShopify();
    memCache = { at: Date.now(), data: products };
    const saved = await redisSet(CACHE_KEY, products, CACHE_TTL);
    res.json({ success: true, count: products.length, redisSaved: saved.ok, megabytes: +(saved.bytes / 1048576).toFixed(2) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => { res.json({ status: 'Joella Grace Chat API is running!' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
