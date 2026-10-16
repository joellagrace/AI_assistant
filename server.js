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
  } catch { /* ignore cache write errors */ }
}

// ─── Fetch ALL products from Shopify (used only on cache miss) ────────────────
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
  // 1. Try Redis cache first
  const cached = await redisGet(CACHE_KEY);
  if (cached && cached.length > 0) {
    console.log(`Cache hit: ${cached.length} products`);
    return cached;
  }

  // 2. Cache miss → fetch from Shopify
  console.log('Cache miss — fetching from Shopify...');
  const products = await fetchAllFromShopify();

  // 3. Store in Redis for next 30 minutes
  if (products.length > 0) {
    await redisSet(CACHE_KEY, products, CACHE_TTL);
    console.log(`Cached ${products.length} products for 30 min`);
  }

  return products;
}

// ─── Search & filter products ─────────────────────────────────────────────────
async function searchProducts(query, intent = {}) {
  try {
    const allProducts = await getAllProducts();
    if (allProducts.length === 0) return [];

    let results = [...allProducts];

    // Color filter
    if (intent.color) {
      const colored = results.filter(p =>
        p.title.toLowerCase().includes(intent.color) ||
        (p.tags && p.tags.toLowerCase().includes(intent.color)) ||
        (p.body_html && p.body_html.toLowerCase().includes(intent.color)) ||
        (p.variants && p.variants.some(v => v.title.toLowerCase().includes(intent.color)))
      );
      if (colored.length > 0) results = colored;
    }

    // Product keyword filter
    if (intent.keyword) {
      const keyworded = results.filter(p =>
        p.title.toLowerCase().includes(intent.keyword) ||
        (p.product_type && p.product_type.toLowerCase().includes(intent.keyword)) ||
        (p.tags && p.tags.toLowerCase().includes(intent.keyword))
      );
      if (keyworded.length > 0) results = keyworded;
    }

    // Sort across ALL products
    if (intent.sort === 'cheapest') {
      results.sort((a, b) =>
        parseFloat(a.variants[0]?.price || 0) - parseFloat(b.variants[0]?.price || 0)
      );
    } else if (intent.sort === 'expensive') {
      results.sort((a, b) =>
        parseFloat(b.variants[0]?.price || 0) - parseFloat(a.variants[0]?.price || 0)
      );
    } else if (intent.sort === 'latest') {
      results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } else if (intent.sort === 'oldest') {
      results.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    return results.slice(0, 4).map(p => ({
      title: p.title,
      price: p.variants[0]?.price || '0.00',
      image: p.images[0]?.src || null,
      url: `https://${process.env.SHOPIFY_STORE}/products/${p.handle}`,
      inStock: p.variants.some(v => v.inventory_quantity > 0)
    }));
  } catch (err) {
    console.error('searchProducts error:', err);
    return [];
  }
}

// ─── Intent detection ─────────────────────────────────────────────────────────
function detectIntent(msg) {
  const lower = msg.toLowerCase();
  const intent = {};

  if (lower.includes('yellow gold')) intent.color = 'yellow gold';
  else if (lower.includes('white gold')) intent.color = 'white gold';
  else if (lower.includes('rose gold')) intent.color = 'rose gold';
  else if (lower.includes('platinum')) intent.color = 'platinum';
  else {
    const colors = ['red', 'blue', 'green', 'yellow', 'white', 'black',
                    'rose', 'pink', 'purple', 'orange', 'brown', 'grey', 'gray'];
    colors.forEach(c => { if (lower.includes(c)) intent.color = c; });
  }

  const keywords = ['ring', 'necklace', 'earring', 'bracelet', 'pendant',
                    'brooch', 'diamond', 'engagement', 'wedding', 'cross', 'coin'];
  keywords.forEach(k => { if (lower.includes(k)) intent.keyword = k; });

  if (/cheap|lowest|affordable|budget|least expensive|low price/.test(lower)) {
    intent.sort = 'cheapest';
  } else if (/expensive|highest|luxury|most costly|priciest|high end|high-end|most expensive/.test(lower)) {
    intent.sort = 'expensive';
  } else if (/new|latest|newest|recent|just arrived|fresh/.test(lower)) {
    intent.sort = 'latest';
  } else if (/old|oldest|classic|earliest/.test(lower)) {
    intent.sort = 'oldest';
  }

  return intent;
}

function getResponseText(intent) {
  if (intent.sort === 'cheapest') return "Here are our most affordable pieces!";
  if (intent.sort === 'expensive') return "Here are our most luxurious, high-end pieces!";
  if (intent.sort === 'latest') return "Here are our newest arrivals!";
  if (intent.sort === 'oldest') return "Here are some of our most classic vintage pieces!";
  if (intent.color) return `Here are pieces featuring ${intent.color} from our collection!`;
  if (intent.keyword) return `Here are our beautiful ${intent.keyword} pieces!`;
  return "Here are some beautiful pieces from our collection!";
}

function isProductQuery(msg) {
  return /ring|necklace|earring|bracelet|pendant|brooch|diamond|gold|silver|platinum|vintage|antique|suggest|show me|find me|looking for|engagement|wedding|jewelry|jewellery|collection|piece|buy|shop|cheap|expensive|latest|newest|oldest|affordable|luxury|red|blue|white|rose|yellow|cross|coin/i.test(msg);
}

// ─── API endpoint ─────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (isProductQuery(message)) {
      const intent = detectIntent(message);
      const products = await searchProducts(message, intent);
      const responseText = getResponseText(intent);

      if (products.length > 0) {
        return res.json({ type: 'products', text: responseText, products });
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

// ─── Cache refresh endpoint (optional) ───────────────────────────────────────
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