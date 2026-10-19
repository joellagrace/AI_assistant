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
const CACHE_TTL = 60 * 30; // 30 minutes

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

// ─── Step 1: Use OpenAI to extract a clean search query ──────────────────────
async function extractSearchQuery(userMessage) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 60,
      messages: [
        {
          role: 'system',
          content: `You are a search query extractor for a jewelry store.
Extract a simple 1-3 word product search query from the user's message.
Return ONLY the search query, nothing else.
Examples:
- "show me some ruby rings" → "ruby ring"
- "I want something cheap" → "affordable"
- "show me expensive pieces" → "expensive"
- "do you have sapphire necklaces?" → "sapphire necklace"
- "what engagement rings do you have" → "engagement ring"
- "show me vintage bracelets" → "vintage bracelet"
- "cheapest items" → "cheapest"
- "most expensive" → "most expensive"
- "newest arrivals" → "newest"
If no clear product query, return "jewelry".`
        },
        { role: 'user', content: userMessage }
      ]
    });
    return res.choices[0].message.content.trim().toLowerCase();
  } catch {
    return userMessage.toLowerCase();
  }
}

// ─── Step 2: Search products using extracted query ────────────────────────────
async function searchProducts(userMessage) {
  try {
    const allProducts = await getAllProducts();
    if (allProducts.length === 0) return [];

    // Get AI-extracted search query
    const searchQuery = await extractSearchQuery(userMessage);
    console.log(`Search query: "${searchQuery}"`);

    const terms = searchQuery.split(' ').filter(t => t.length > 1);
    let results = [...allProducts];

    // Handle sort intents
    if (/cheap|lowest|affordable|budget|least expensive|low price/.test(searchQuery)) {
      results.sort((a, b) =>
        parseFloat(a.variants[0]?.price || 0) - parseFloat(b.variants[0]?.price || 0)
      );
      return results.slice(0, 4).map(formatProduct);
    }

    if (/expensive|highest|luxury|most costly|priciest|high end|high-end|most expensive/.test(searchQuery)) {
      results.sort((a, b) =>
        parseFloat(b.variants[0]?.price || 0) - parseFloat(a.variants[0]?.price || 0)
      );
      return results.slice(0, 4).map(formatProduct);
    }

    if (/new|latest|newest|recent/.test(searchQuery)) {
      results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return results.slice(0, 4).map(formatProduct);
    }

    if (/old|oldest|classic|earliest/.test(searchQuery)) {
      results.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      return results.slice(0, 4).map(formatProduct);
    }

    // Score each product by how many terms match
    const scored = results.map(p => {
      const searchText = [
        p.title,
        p.product_type,
        p.tags,
        p.body_html?.replace(/<[^>]*>/g, '') || ''
      ].join(' ').toLowerCase();

      let score = 0;
      terms.forEach(term => {
        if (searchText.includes(term)) score++;
        // Bonus for title match
        if (p.title.toLowerCase().includes(term)) score += 2;
      });
      return { product: p, score };
    });

    // Sort by score, filter out zero matches
    const matched = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(s => s.product);

    // Hide mountings unless user explicitly asked for them
    const wantsMounting = /mount|mounting|semi.mount/i.test(userMessage);
    const filterMountings = (list) => wantsMounting
      ? list
      : list.filter(p => !/\bmount(ing)?\b/i.test(p.title));

    // If nothing matched, return newest products
    const finalResults = matched.length > 0 ? matched : results;
    const filtered = filterMountings(finalResults);
    return (filtered.length > 0 ? filtered : finalResults).slice(0, 4).map(formatProduct);

  } catch (err) {
    console.error('searchProducts error:', err);
    return [];
  }
}

function formatProduct(p) {
  return {
    title: p.title,
    price: p.variants[0]?.price || '0.00',
    image: p.images[0]?.src || null,
    url: `https://${process.env.SHOPIFY_STORE}/products/${p.handle}`,
    inStock: p.variants.some(v => v.inventory_quantity > 0),
    tags: p.tags || '',
    product_type: p.product_type || ''
  };
}

// ─── Is this a product query? ─────────────────────────────────────────────────
function isProductQuery(msg) {
  return /ring|necklace|earring|bracelet|pendant|brooch|diamond|gold|silver|platinum|vintage|antique|suggest|show me|find me|looking for|engagement|wedding|jewelry|jewellery|collection|piece|buy|shop|cheap|expensive|latest|newest|oldest|affordable|luxury|ruby|emerald|sapphire|pearl|opal|garnet|cross|coin|show|suggest|recommend/i.test(msg);
}

// ─── API endpoint ─────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (isProductQuery(message)) {
      const products = await searchProducts(message);

      if (products.length > 0) {
        return res.json({
          type: 'products',
          text: "Here are some pieces from our collection!",
          products
        });
      }

      return res.json({
        type: 'text',
        text: "I'd love to help you find something special! Could you tell me more about what you're looking for?"
      });
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

    res.json({
      type: 'text',
      text: reply.choices[0].message.content
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── Related products endpoint ───────────────────────────────────────────────
app.post('/api/related', async (req, res) => {
  try {
    const { title, tags, product_type } = req.body;
    const allProducts = await getAllProducts();
    if (!allProducts.length) return res.json({ products: [] });

    const searchTerms = [
      ...(tags || '').split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 2),
      (product_type || '').toLowerCase().trim(),
    ].filter(Boolean);

    if (searchTerms.length === 0) return res.json({ products: [] });

    const titleLower = (title || '').toLowerCase();

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

    const related = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => formatProduct(s.product));

    res.json({ products: related });
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