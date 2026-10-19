(function () {
  const API_URL = window.JGChat?.apiUrl || 'http://localhost:3000/api/chat';
  const RELATED_URL = (window.JGChat?.apiUrl || 'http://localhost:3000').replace('/api/chat', '') + '/api/related';
  let history = [];
  let isOpen = false;

  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500&display=swap');

    #jg-launcher {
      position: fixed;
      bottom: 28px;
      right: 28px;
      width: 68px;
      height: 68px;
      border-radius: 50%;
      background: #EBB9AA;
      border: none;
      cursor: pointer;
      box-shadow: 0 6px 24px rgba(0,0,0,0.22);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      transition: transform .25s ease, box-shadow .25s ease;
      padding: 0;
      overflow: hidden;
    }
    #jg-launcher:hover {
      transform: scale(1.1);
      box-shadow: 0 10px 32px rgba(0,0,0,0.28);
    }
    #jg-launcher img {
      width: 54px;
      height: 54px;
      object-fit: contain;
      border-radius: 0;
      display: block;
    }

    #jg-panel {
      position: fixed;
      bottom: 110px;
      right: 24px;
      width: 360px;
      height: 540px;
      background: #FAF2F0;
      border-radius: 20px;
      box-shadow: 0 12px 60px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
      display: flex;
      flex-direction: column;
      z-index: 9998;
      font-family: 'Inter', sans-serif;
      transform: translateY(16px) scale(0.97);
      opacity: 0;
      pointer-events: none;
      transition: all .28s cubic-bezier(.34,1.4,.64,1);
      overflow: hidden;
    }
    #jg-panel.open {
      transform: translateY(0) scale(1);
      opacity: 1;
      pointer-events: auto;
    }

    #jg-header {
      background: #1a1410;
      color: #f5ede8;
      padding: 18px 20px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    #jg-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      overflow: hidden;
      flex-shrink: 0;
      border: 1.5px solid rgba(255,255,255,0.15);
    }
    #jg-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    #jg-header-info { flex: 1; }
    #jg-header-title {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.02em;
      line-height: 1.2;
    }
    #jg-header-status {
      font-size: 11px;
      color: #b5a99f;
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    #jg-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #7dcfa0;
      display: inline-block;
    }
    #jg-close {
      background: none;
      border: none;
      color: #9e8f88;
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 4px;
      transition: color .15s;
    }
    #jg-close:hover { color: #f5ede8; }

    #jg-messages {
      flex: 1;
      overflow-y: auto;
      padding: 18px 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #FAF2F0;
      scrollbar-width: thin;
      scrollbar-color: #e0d4cf transparent;
    }
    #jg-messages::-webkit-scrollbar { width: 4px; }
    #jg-messages::-webkit-scrollbar-track { background: transparent; }
    #jg-messages::-webkit-scrollbar-thumb { background: #d9cbc5; border-radius: 4px; }

    .jg-bot-msg, .jg-user-msg {
      max-width: 82%;
      padding: 10px 14px;
      font-size: 13.5px;
      line-height: 1.55;
      word-break: break-word;
    }
    .jg-bot-msg {
      background: #fff;
      color: #2a1f1a;
      align-self: flex-start;
      border-radius: 4px 16px 16px 16px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.07);
    }
    .jg-user-msg {
      background: #1a1410;
      color: #f5ede8;
      align-self: flex-end;
      border-radius: 16px 16px 4px 16px;
    }

    .jg-typing-wrap {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-self: flex-start;
    }
    .jg-typing-label {
      font-size: 11.5px;
      color: #9e8880;
      font-style: italic;
      padding-left: 4px;
      animation: jgFade 1.5s ease infinite;
    }
    @keyframes jgFade {
      0%,100% { opacity: 0.5; }
      50% { opacity: 1; }
    }

    .jg-products-wrap {
      align-self: flex-start;
      max-width: 100%;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .jg-products-label {
      font-size: 12px;
      color: #8a7570;
      font-style: italic;
      padding-left: 2px;
    }
    .jg-product-card {
      background: #fff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 1px 6px rgba(0,0,0,0.09);
      display: flex;
      align-items: center;
      gap: 0;
      text-decoration: none;
      color: inherit;
      transition: box-shadow .2s, transform .2s;
      width: 280px;
    }
    .jg-product-card:hover {
      box-shadow: 0 4px 16px rgba(0,0,0,0.14);
      transform: translateY(-1px);
    }
    .jg-product-img {
      width: 72px;
      height: 72px;
      object-fit: cover;
      flex-shrink: 0;
    }
    .jg-product-img-placeholder {
      width: 72px;
      height: 72px;
      background: #f0e8e4;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      flex-shrink: 0;
    }
    .jg-product-info {
      padding: 10px 12px;
      flex: 1;
      min-width: 0;
    }
    .jg-product-title {
      font-size: 12.5px;
      font-weight: 500;
      color: #1a1410;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }
    .jg-product-price {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 15px;
      font-weight: 600;
      color: #1a1410;
      margin-top: 4px;
    }
    .jg-product-stock {
      font-size: 10.5px;
      color: #7dcfa0;
      margin-top: 2px;
    }
    .jg-product-stock.out { color: #c97b6a; }

    .jg-typing {
      display: flex;
      gap: 5px;
      padding: 12px 16px;
      background: #fff;
      border-radius: 4px 16px 16px 16px;
      width: fit-content;
      box-shadow: 0 1px 4px rgba(0,0,0,0.07);
    }
    .jg-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #c4ada5;
      animation: jgBounce 1.3s infinite;
    }
    .jg-dot:nth-child(2) { animation-delay: .18s; }
    .jg-dot:nth-child(3) { animation-delay: .36s; }
    @keyframes jgBounce {
      0%,60%,100% { transform: translateY(0); opacity: .6; }
      30% { transform: translateY(-5px); opacity: 1; }
    }

    #jg-input-row {
      padding: 12px 14px;
      border-top: 1px solid #ecddd7;
      display: flex;
      gap: 8px;
      align-items: center;
      background: #FAF2F0;
      flex-shrink: 0;
    }
    #jg-input {
      flex: 1;
      padding: 9px 16px;
      border: 1.5px solid #e2d0c8;
      border-radius: 22px;
      font-size: 13px;
      font-family: 'Inter', sans-serif;
      outline: none;
      background: #fff;
      color: #2a1f1a;
      transition: border-color .2s;
    }
    #jg-input::placeholder { color: #b5a099; }
    #jg-input:focus { border-color: #c4956a; }
    #jg-send {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #1a1410;
      border: none;
      cursor: pointer;
      color: #f5ede8;
      font-size: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background .2s, transform .15s;
    }
    #jg-send:hover { background: #3a2e28; transform: scale(1.05); }

    #jg-footer {
      text-align: center;
      font-size: 10px;
      color: #c4ada5;
      padding: 0 12px 10px;
      letter-spacing: 0.04em;
      background: #FAF2F0;
      flex-shrink: 0;
    }

    .jg-related-wrap {
      align-self: flex-start;
      max-width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 4px;
    }
    .jg-related-label {
      font-size: 11px;
      color: #b5a099;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding-left: 2px;
    }
    .jg-related-row {
      display: flex;
      gap: 7px;
      flex-wrap: nowrap;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: none;
    }
    .jg-related-row::-webkit-scrollbar { display: none; }
    .jg-related-card {
      background: #fff;
      border-radius: 10px;
      overflow: hidden;
      box-shadow: 0 1px 5px rgba(0,0,0,0.08);
      text-decoration: none;
      color: inherit;
      flex-shrink: 0;
      width: 90px;
      transition: box-shadow .2s, transform .2s;
    }
    .jg-related-card:hover {
      box-shadow: 0 3px 12px rgba(0,0,0,0.13);
      transform: translateY(-1px);
    }
    .jg-related-img {
      width: 90px;
      height: 70px;
      object-fit: cover;
      display: block;
    }
    .jg-related-img-ph {
      width: 90px;
      height: 70px;
      background: #f0e8e4;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .jg-related-info {
      padding: 5px 6px 6px;
    }
    .jg-related-title {
      font-size: 10px;
      color: #2a1f1a;
      font-weight: 500;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.3;
    }
    .jg-related-price {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 12px;
      font-weight: 600;
      color: #1a1410;
      margin-top: 2px;
    }

    @media (max-width: 400px) {
      #jg-panel { width: calc(100vw - 24px); right: 12px; }
    }
  `;
  document.head.appendChild(style);

  document.body.insertAdjacentHTML('beforeend', `
    <button id="jg-launcher" aria-label="Open shopping assistant">
      <img src="https://cdn.shopify.com/s/files/1/0828/1735/1934/files/aibot.png?v=1792159848" alt="Chat" />
    </button>
    <div id="jg-panel" role="dialog" aria-label="Shopping Assistant">
      <div id="jg-header">
        <div id="jg-avatar">
          <img src="https://cdn.shopify.com/s/files/1/0828/1735/1934/files/aibot.png?v=1792159848" alt="" />
        </div>
        <div id="jg-header-info">
          <div id="jg-header-title">The Shopping Assistant</div>
          <div id="jg-header-status"><span id="jg-status-dot"></span> Online & ready to help</div>
        </div>
        <button id="jg-close" aria-label="Close">✕</button>
      </div>
      <div id="jg-messages"></div>
      <div id="jg-input-row">
        <input id="jg-input" placeholder="Ask about jewelry, shipping, returns…" autocomplete="off" />
        <button id="jg-send" aria-label="Send">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
      <div id="jg-footer">Powered By Huemono ✦</div>
    </div>
  `);

  const panel = document.getElementById('jg-panel');
  const messages = document.getElementById('jg-messages');
  const input = document.getElementById('jg-input');

  // ── Session persistence ──────────────────────────────────────────
  function saveSession() {
    try {
      sessionStorage.setItem('jg_history', JSON.stringify(history));
      sessionStorage.setItem('jg_messages', messages.innerHTML);
    } catch(e) {}
  }

  function restoreSession() {
    try {
      const savedHistory = sessionStorage.getItem('jg_history');
      const savedMessages = sessionStorage.getItem('jg_messages');
      if (savedHistory) history = JSON.parse(savedHistory);
      if (savedMessages) messages.innerHTML = savedMessages;
    } catch(e) {}
  }

  function toggle() {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    if (isOpen && messages.children.length === 0) {
      addMsg('bot', "Welcome to Joella Grace ✦ Ask me about any piece in our collection, shipping, returns, or custom designs, I'm here to help.");
      saveSession();
    }
    if (isOpen) {
      messages.scrollTop = messages.scrollHeight;
      setTimeout(() => input.focus(), 250);
    }
  }

  // Restore previous chat on load
  restoreSession();

  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = role === 'bot' ? 'jg-bot-msg' : 'jg-user-msg';
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function addProducts(text, products) {
    const wrap = document.createElement('div');
    wrap.className = 'jg-products-wrap';

    const label = document.createElement('div');
    label.className = 'jg-products-label';
    label.textContent = text;
    wrap.appendChild(label);

    products.forEach(p => {
      const a = document.createElement('a');
      a.className = 'jg-product-card';
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener';

      if (p.image) {
        const img = document.createElement('img');
        img.className = 'jg-product-img';
        img.src = p.image;
        img.alt = p.title;
        a.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'jg-product-img-placeholder';
        ph.textContent = '💍';
        a.appendChild(ph);
      }

      const info = document.createElement('div');
      info.className = 'jg-product-info';
      info.innerHTML = `
        <div class="jg-product-title">${p.title}</div>
        <div class="jg-product-price">$${parseFloat(p.price).toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
        <div class="jg-product-stock ${p.inStock ? '' : 'out'}">${p.inStock ? '✓ In stock' : '✗ Out of stock'}</div>
      `;
      a.appendChild(info);
      wrap.appendChild(a);
    });

    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  function addRelated(products) {
    if (!products || products.length === 0) return;
    const wrap = document.createElement('div');
    wrap.className = 'jg-related-wrap';
    const label = document.createElement('div');
    label.className = 'jg-related-label';
    label.textContent = '✦ You might also like';
    wrap.appendChild(label);
    const row = document.createElement('div');
    row.className = 'jg-related-row';
    products.forEach(p => {
      const a = document.createElement('a');
      a.className = 'jg-related-card';
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noopener';
      if (p.image) {
        const img = document.createElement('img');
        img.className = 'jg-related-img';
        img.src = p.image;
        img.alt = p.title;
        a.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'jg-related-img-ph';
        ph.textContent = '💍';
        a.appendChild(ph);
      }
      const info = document.createElement('div');
      info.className = 'jg-related-info';
      info.innerHTML = '<div class="jg-related-title">' + p.title + '</div><div class="jg-related-price">$' + parseFloat(p.price).toLocaleString('en-US', {minimumFractionDigits: 0}) + '</div>';
      a.appendChild(info);
      row.appendChild(a);
    });
    wrap.appendChild(row);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  async function fetchRelated(products) {
    if (!products || products.length === 0) return;
    try {
      const first = products[0];
      const res = await fetch(RELATED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: first.title, tags: first.tags || '', product_type: first.product_type || '' })
      });
      const data = await res.json();
      if (data.products && data.products.length > 0) {
        addRelated(data.products);
        saveSession();
      }
    } catch (e) {}
  }

  function addTyping(msg) {
    const wrap = document.createElement('div');
    wrap.className = 'jg-typing-wrap';

    const typing = document.createElement('div');
    typing.className = 'jg-typing';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'jg-dot';
      typing.appendChild(dot);
    }
    wrap.appendChild(typing);

    if (msg) {
      const label = document.createElement('div');
      label.className = 'jg-typing-label';
      label.textContent = msg;
      wrap.appendChild(label);
    }

    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
    return wrap;
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMsg('user', text);

    // Instant local replies — no API call needed
    const quickReplies = {
      'hi': "Hi there! 👋 How can I help you find something beautiful today?",
      'hello': "Hello! Welcome to Joella Grace ✦ What can I help you find?",
      'hey': "Hey! Looking for something special? I'm here to help! ✦",
      'thanks': "You're so welcome! Let me know if you need anything else ✦",
      'thank you': "My pleasure! Happy to help anytime ✦",
      'thankyou': "My pleasure! Happy to help anytime ✦",
      'bye': "Goodbye! Come back anytime ✦",
      'goodbye': "Goodbye! Come back anytime ✦",
      'ok': "Of course! Let me know if you need anything ✦",
      'okay': "Great! Feel free to ask anything ✦",
      'cool': "Great! Anything else I can help you with? ✦",
      'great': "Wonderful! Let me know if you need anything else ✦",
      'nice': "Thank you! Is there anything I can help you find? ✦",
    };
    const quickKey = text.toLowerCase().trim();
    if (quickReplies[quickKey]) {
      addMsg('bot', quickReplies[quickKey]);
      return;
    }

    const isProduct = /ring|necklace|earring|bracelet|diamond|gold|silver|expensive|cheap|latest|show me|find me|jewelry|pendant|brooch|engagement|wedding|vintage|antique|affordable|luxury/i.test(text);
    const typing = addTyping(isProduct ? 'Searching our collection…' : null);

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history })
      });
      const data = await res.json();
      typing.remove();

      if (data.type === 'products' && data.products && data.products.length > 0) {
        addProducts(data.text, data.products);
        fetchRelated(data.products);
      } else {
        addMsg('bot', data.text || 'Sorry, I could not get a response. Please try again.');
      }

      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: data.text || '' });
      if (history.length > 20) history = history.slice(-20);
      saveSession();
    } catch {
      typing.remove();
      addMsg('bot', 'Something went wrong. Please try again in a moment.');
    }
  }

  document.getElementById('jg-launcher').addEventListener('click', toggle);
  document.getElementById('jg-close').addEventListener('click', toggle);
  document.getElementById('jg-send').addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
})();