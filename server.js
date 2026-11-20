require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

const SHOPIFY_URL = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01`;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CACHE_KEY = 'jg_all_products';
const CACHE_TTL = 60 * 5; // 5 minutes

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

// ─── Redis helpers ────────────────────────────────────────────────────────────
async function redisGet(key) {
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function redisSet(key, value, ttl) {
  try {
    await fetch(`${REDIS_URL}/set/${key}?EX=${ttl}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch { }
}

// ─── Fetch ALL products from Shopify ─────────────────────────────────────────
async function fetchAllFromShopify() {
  let allProducts = [];
  let url = `${SHOPIFY_URL}/products.json?limit=250&status=active`;
  while (url) {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const data = await res.json();
    if (data.products) allProducts = [...allProducts, ...data.products];
    const linkHeader = res.headers.get('link');
    const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    if (allProducts.length >= 5000) break;
  }
  return allProducts;
}

// ─── Get products (from cache or Shopify) ────────────────────────────────────
async function getAllProducts() {
  const cached = await redisGet(CACHE_KEY);
  if (cached && cached.length > 0) {
    console.log(`Cache hit: ${cached.length} products`);
    return cached;
  }
  console.log('Cache miss — fetching from Shopify...');
  const products = await fetchAllFromShopify();
  if (products.length > 0) await redisSet(CACHE_KEY, products, CACHE_TTL);
  return products;
}

// ─── Live Shopify search (real-time, exact title match) ───────────────────────
async function searchShopifyLive(query) {
  try {
    const url = `${SHOPIFY_URL}/products.json?limit=10&status=active&title=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const data = await res.json();
    return data.products || [];
  } catch (err) {
    console.error('Shopify live search error:', err);
    return [];
  }
}

// ─── AI: Detect intent + extract search query (no hardcoding) ────────────────
async function analyzeMessage(userMessage) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content: `You are an assistant for a vintage jewelry and antiques store.
Analyze the user message and return a JSON object with two fields:
- "isProduct": true if the user is asking about, looking for, or inquiring about ANY product or item in the store (jewelry, watches, accessories, antiques, coins, etc.), false if it's a general question (shipping, returns, policies, custom design, greetings).
- "query": a simple 1-3 word search term (e.g. "ruby ring", "watch", "affordable", "newest", "most expensive"). If no specific product, return "jewelry".
Return ONLY valid JSON. Example: {"isProduct":true,"query":"vintage watch"}`
        },
        { role: 'user', content: userMessage }
      ]
    });
    const raw = res.choices[0].message.content.trim();
    return JSON.parse(raw);
  } catch {
    return { isProduct: false, query: userMessage.toLowerCase() };
  }
}

// ─── Format product for response ─────────────────────────────────────────────
function formatProduct(p) {
  return {
    title: p.title,
    price: p.variants[0]?.price || '0.00',
    image: p.images[0]?.src || null,
    url: `https://${process.env.SHOPIFY_STORE}/products/${p.handle}`,
    inStock: p.variants.some(v => v.inventory_quantity > 0),
    tags: p.tags || '',
    product_type: p.product_type || '',
    variant_id: p.variants[0]?.id || null
  };
}

// ─── Search products: live Shopify first, cache fallback ─────────────────────
async function searchProducts(userMessage, preAnalyzedQuery = null) {
  try {
    const searchQuery = preAnalyzedQuery || (await analyzeMessage(userMessage)).query;
    console.log(`Search query: "${searchQuery}"`);

    const wantsMounting = /mount|mounting|semi.mount/i.test(userMessage) || /mount/i.test(searchQuery);
    const filterMountings = (list) => wantsMounting
      ? list
      : list.filter(p => !/\bmount(ing)?\b/i.test(p.title));

    // ── Sort intents: use full cached product list ─────────────────────────
    if (/cheap|affordable|budget|low price|lowest/.test(searchQuery)) {
      const all = await getAllProducts();
      return filterMountings([...all].sort((a, b) =>
        parseFloat(a.variants[0]?.price || 0) - parseFloat(b.variants[0]?.price || 0)
      )).slice(0, 6).map(formatProduct);
    }
    if (/expensive|luxury|highest|most costly|priciest/.test(searchQuery)) {
      const all = await getAllProducts();
      return filterMountings([...all].sort((a, b) =>
        parseFloat(b.variants[0]?.price || 0) - parseFloat(a.variants[0]?.price || 0)
      )).slice(0, 6).map(formatProduct);
    }
    if (/newest|latest|recent/.test(searchQuery)) {
      const all = await getAllProducts();
      return filterMountings([...all].sort((a, b) =>
        new Date(b.created_at) - new Date(a.created_at)
      )).slice(0, 6).map(formatProduct);
    }
    if (/oldest|earliest/.test(searchQuery)) {
      const all = await getAllProducts();
      return filterMountings([...all].sort((a, b) =>
        new Date(a.created_at) - new Date(b.created_at)
      )).slice(0, 6).map(formatProduct);
    }

    // ── Live Shopify search for specific product queries ───────────────────
    const liveResults = await searchShopifyLive(searchQuery);
    console.log(`Live Shopify results: ${liveResults.length}`);

    if (liveResults.length > 0) {
      const queryLower = searchQuery.toLowerCase();
      const exact = liveResults.filter(p => p.title.toLowerCase().includes(queryLower));
      const partial = liveResults.filter(p => !p.title.toLowerCase().includes(queryLower));
      return filterMountings([...exact, ...partial]).slice(0, 6).map(formatProduct);
    }

    // ── Fallback: search cached products ──────────────────────────────────
    console.log('Live search empty, falling back to cache...');
    const allProducts = await getAllProducts();
    const terms = searchQuery.split(' ').filter(t => t.length > 1);
    const queryLower = searchQuery.toLowerCase();

    const scored = allProducts.map(p => {
      const titleLower = p.title.toLowerCase();
      const searchText = [p.title, p.product_type, p.tags,
        p.body_html?.replace(/<[^>]*>/g, '') || ''].join(' ').toLowerCase();
      let score = 0;
      if (titleLower.includes(queryLower)) score += 20;
      if (terms.every(t => titleLower.includes(t)) && terms.length > 1) score += 10;
      terms.forEach(term => {
        if (titleLower.includes(term)) score += 3;
        else if (searchText.includes(term)) score += 1;
      });
      return { product: p, score };
    });

    const matched = scored.filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score).map(s => s.product);
    const finalResults = matched.length > 0 ? matched : allProducts;
    return filterMountings(finalResults).slice(0, 6).map(formatProduct);

  } catch (err) {
    console.error('searchProducts error:', err);
    return [];
  }
}

// ─── Chat endpoint ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    // AI decides intent — zero hardcoding
    const { isProduct, query } = await analyzeMessage(message);
    console.log(`Intent: isProduct=${isProduct}, query="${query}"`);

    if (isProduct) {
      const products = await searchProducts(message, query);
      if (products.length > 0) {
        return res.json({ type: 'products', text: "Here are some pieces from our collection!", products });
      }
      return res.json({ type: 'text', text: "I'd love to help you find something special! Could you tell me more about what you're looking for?" });
    }

    const reply = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: message }
      ]
    });

    res.json({ type: 'text', text: reply.choices[0].message.content });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── Related products endpoint ────────────────────────────────────────────────
app.post('/api/related', async (req, res) => {
  try {
    const { title, tags, product_type } = req.body;
    const allProducts = await getAllProducts();
    if (!allProducts.length) return res.json({ products: [] });

    const titleLower = (title || '').toLowerCase();
    const searchTerms = [
      ...(tags || '').split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 2),
      (product_type || '').toLowerCase().trim(),
    ].filter(Boolean);

    if (searchTerms.length === 0) {
      const fallback = [...allProducts]
        .filter(p => p.title.toLowerCase() !== titleLower)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 3).map(formatProduct);
      return res.json({ products: fallback });
    }

    const scored = allProducts.map(p => {
      if (p.title.toLowerCase() === titleLower) return { product: p, score: -1 };
      const searchText = [p.title, p.product_type, p.tags].join(' ').toLowerCase();
      let score = 0;
      searchTerms.forEach(term => {
        if (searchText.includes(term)) score++;
        if (p.title.toLowerCase().includes(term)) score++;
      });
      return { product: p, score };
    });

    const matched = scored.filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score).slice(0, 3).map(s => formatProduct(s.product));

    if (matched.length === 0) {
      const fallback = [...allProducts]
        .filter(p => p.title.toLowerCase() !== titleLower)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 3).map(formatProduct);
      return res.json({ products: fallback });
    }

    res.json({ products: matched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cache refresh ────────────────────────────────────────────────────────────
app.post('/api/refresh-cache', async (req, res) => {
  try {
    const products = await fetchAllFromShopify();
    await redisSet(CACHE_KEY, products, CACHE_TTL);
    res.json({ success: true, count: products.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'Joella Grace Chat API is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
