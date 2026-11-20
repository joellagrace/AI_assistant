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

// ─── Shopify Predictive Search (same engine as the store's search bar) ────────
// Returns product handles that Shopify considers most relevant
async function shopifyPredictiveSearch(query) {
  try {
    const url = `https://${SHOPIFY_STORE}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=15`;
    const res = await fetch(url);
    const data = await res.json();
    const hits = data.resources?.results?.products || [];
    // Returns array of { url, title, ... } — extract handles
    return hits.map(h => {
      const parts = h.url.split('/products/');
      return parts[1] ? parts[1].split('?')[0] : null;
    }).filter(Boolean);
  } catch (err) {
    console.error('Predictive search error:', err);
    return [];
  }
}

// ─── AI: intent + query ───────────────────────────────────────────────────────
async function analyzeMessage(userMessage) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content: `You are an assistant for a vintage jewelry and antiques store.
Analyze the user message and return a JSON object:
- "isProduct": true if the user wants to SEE, FIND, or BUY any item. When in doubt, return true.
  TRUE examples: "show me watches", "do you have rings", "show me few watches", "need rings",
  "any bracelets", "is there a necklace", "diamond stuff", "show me something cheap", "newest items"
  FALSE examples: "what is your return policy", "how long does shipping take", "hello", "thank you"
- "query": 1-3 word search using the most specific product noun.
  "show me few watches" -> "watch"
  "diamond rings under $1000" -> "diamond ring"
  "do you have sapphire necklaces" -> "sapphire necklace"
  "show me something cheap" -> "affordable"
  "newest items" -> "newest"
  If no specific type, return "jewelry".
Return ONLY valid JSON. Example: {"isProduct":true,"query":"watch"}`
        },
        { role: 'user', content: userMessage }
      ]
    });
    return JSON.parse(res.choices[0].message.content.trim());
  } catch { return { isProduct: false, query: userMessage.toLowerCase() }; }
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

// ─── Smart relevance scoring ──────────────────────────────────────────────────
// Strict AND logic: all terms must appear for high score
function scoreProduct(p, terms, exactPhrase) {
  const title = p.title.toLowerCase();
  const searchText = [p.title, p.product_type, p.tags, p.body_html?.replace(/<[^>]*>/g, '') || ''].join(' ').toLowerCase();
  let score = 0;

  // Exact full phrase in title = highest priority
  if (title.includes(exactPhrase)) score += 50;

  // ALL terms in title = strong match
  if (terms.every(t => title.includes(t))) score += 30;

  // ALL terms anywhere in product = decent match
  if (terms.every(t => searchText.includes(t))) score += 15;

  // Per-term scoring (partial matches)
  terms.forEach(t => {
    if (title.includes(t)) score += 5;
    else if (searchText.includes(t)) score += 1;
  });

  return score;
}

// ─── Main search ──────────────────────────────────────────────────────────────
async function searchProducts(userMessage, preAnalyzedQuery = null) {
  try {
    const searchQuery = preAnalyzedQuery || (await analyzeMessage(userMessage)).query;
    console.log(`Search query: "${searchQuery}"`);

    const { maxPrice, minPrice } = parsePriceFilters(userMessage);
    const wantsMounting = /mount|mounting|semi.mount/i.test(userMessage) || /mount/i.test(searchQuery);

    const applyFilters = (list) => {
      let f = list.filter(isAvailable);
      if (maxPrice) f = f.filter(p => parseFloat(p.variants[0]?.price || 0) <= maxPrice);
      if (minPrice) f = f.filter(p => parseFloat(p.variants[0]?.price || 0) >= minPrice);
      if (!wantsMounting) f = f.filter(p => !/\bmount(ing)?\b/i.test(p.title));
      return f;
    };

    const allProducts = await getAllProducts();
    const terms = searchQuery.toLowerCase().split(' ').filter(t => t.length > 1);
    const exactPhrase = searchQuery.toLowerCase();

    // ── Sort intents ─────────────────────────────────────────────────────────
    if (/cheap|affordable|budget|low price|lowest/.test(searchQuery)) {
      return applyFilters(allProducts).sort((a, b) => parseFloat(a.variants[0]?.price || 0) - parseFloat(b.variants[0]?.price || 0)).slice(0, 6).map(formatProduct);
    }
    if (/expensive|luxury|highest|most costly|priciest/.test(searchQuery)) {
      return applyFilters(allProducts).sort((a, b) => parseFloat(b.variants[0]?.price || 0) - parseFloat(a.variants[0]?.price || 0)).slice(0, 6).map(formatProduct);
    }
    if (/newest|latest|recent/.test(searchQuery)) {
      return applyFilters(allProducts).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 6).map(formatProduct);
    }
    if (/oldest|earliest/.test(searchQuery)) {
      return applyFilters(allProducts).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(0, 6).map(formatProduct);
    }

    // ── Step 1: Shopify Predictive Search — get relevant handles ─────────────
    const predictiveHandles = await shopifyPredictiveSearch(searchQuery);
    console.log(`Predictive search handles: ${predictiveHandles.length}`);

    let finalList = [];

    if (predictiveHandles.length > 0) {
      // Map handles to full product objects from cache
      const handleMap = new Map(allProducts.map(p => [p.handle, p]));
      const predictiveProducts = predictiveHandles
        .map(h => handleMap.get(h))
        .filter(Boolean);

      // Apply availability/price filters
      const cleanPredictive = applyFilters(predictiveProducts);

      if (cleanPredictive.length > 0) {
        // Re-score within predictive results for better ordering
        const scored = cleanPredictive.map(p => ({ product: p, score: scoreProduct(p, terms, exactPhrase) }));
        scored.sort((a, b) => b.score - a.score);
        finalList = scored.map(s => s.product);
      }
    }

    // ── Step 2: If predictive gave nothing (or all filtered), use cache scoring
    if (finalList.length === 0) {
      console.log('Predictive empty/filtered — using cache scoring...');
      const cleanAll = applyFilters(allProducts);
      const scored = cleanAll.map(p => ({ product: p, score: scoreProduct(p, terms, exactPhrase) }));
      // Strict: only show products where ALL terms matched somewhere (score > terms.length)
      const minScore = terms.length > 1 ? terms.length * 2 : 1;
      const matched = scored.filter(s => s.score >= minScore).sort((a, b) => b.score - a.score).map(s => s.product);
      finalList = matched.length > 0 ? matched : cleanAll.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    // If price filter gave no results, return empty (better UX than wrong products)
    if ((maxPrice || minPrice) && finalList.length === 0) return [];

    return finalList.slice(0, 6).map(formatProduct);

  } catch (err) {
    console.error('searchProducts error:', err);
    return [];
  }
}

// ─── Chat endpoint ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    const { isProduct, query } = await analyzeMessage(message);
    console.log(`Intent: isProduct=${isProduct}, query="${query}"`);

    if (isProduct) {
      const products = await searchProducts(message, query);
      if (products.length > 0) return res.json({ type: 'products', text: "Here are some pieces from our collection!", products });

      const { maxPrice, minPrice } = parsePriceFilters(message);
      if (maxPrice || minPrice) {
        const priceStr = maxPrice ? `under $${maxPrice.toLocaleString()}` : `over $${minPrice.toLocaleString()}`;
        return res.json({ type: 'text', text: `I couldn't find any available pieces ${priceStr} right now. Would you like me to show you our full collection, or try a different price range?` });
      }
      // Honest message: we don't carry that item
      return res.json({ type: 'text', text: `We don't currently have any "${query}" available in our collection. We specialize in vintage and antique rings, necklaces, earrings, bracelets, brooches, and more. Can I help you find something similar?` });
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
