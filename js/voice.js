'use strict';

/**
 * voice.js — Bill Sathi v1.4
 *
 * WHAT'S NEW in v1.4:
 *  - Smarter multi-item parser: no longer relies on commas alone
 *  - Natural speech "gold one piece and tea special one piece" → 2 items ✓
 *  - Product-boundary detection using sliding window + fuzzy match
 *  - Quantity can appear BEFORE or AFTER the product name
 *  - Handles mixed Hindi/English number words
 *  - Zero confirm popups — items added silently
 *  - ONE clean toast summary: "✓ Added: X, Y  |  Not found: Z"
 *  - Press & Hold mic
 *  - 100% offline
 *
 * Depends on: storage.js, products.js, billing.js, khata.js, app.js
 */

const Voice = (() => {

  const $ = id => document.getElementById(id);

  // ─── State ───────────────────────────────────────────────────────
  let _recognition  = null;
  let _isListening  = false;
  let _isHolding    = false;
  let _holdTimer    = null;
  let _transcript   = '';
  let _touchActive  = false;

  const MIN_HOLD_MS = 120;

  // ═══════════════════════════════════════════════════════════════════
  //  NUMBER & WORD MAPS
  // ═══════════════════════════════════════════════════════════════════

  const NUMBER_WORDS = {
    'ek':1,'do':2,'teen':3,'char':4,'paanch':5,
    'chhe':6,'chah':6,'saat':7,'aath':8,'nau':9,'das':10,
    'gyarah':11,'barah':12,'tera':13,'chaudah':14,'pandrah':15,
    'solah':16,'satrah':17,'atharah':18,'unnis':19,'bees':20,
    'pachees':25,'tees':30,'chalees':40,'pachaas':50,
    'saath':70,'assi':80,'nabbe':90,'sau':100,
    'one':1,'two':2,'three':3,'four':4,'five':5,
    'six':6,'seven':7,'eight':8,'nine':9,'ten':10,
    'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,
    'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,
    'thirty':30,'forty':40,'fifty':50,'sixty':60,'seventy':70,
    'eighty':80,'ninety':90,'hundred':100,'dozen':12,
    'ik':1,'doh':2,'tin':3,'pach':5,'atha':8,
  };

  const UNIT_WORDS = new Set([
    'piece','pieces','pcs','pc','nos','no','number',
    'kg','kilo','kilos','kilogram','gram','grams',
    'liter','litre','litres','liters','ltr','ml',
    'packet','packets','pkt','pkts','box','boxes',
    'bottle','bottles','meter','meters','dozen','dozens',
    'nag','nug','tukda','tukde',
  ]);

  // Words that separate items in natural speech
  const SEPARATOR_WORDS = new Set([
    'and','aur','tatha','phir','then','also','plus',
    'or','aur','aur bhi','saath','ke saath',
  ]);

  const STOP_WORDS = new Set([
    'the','a','an',
    'ke','ka','ki','ko','se','ne',
    'mujhe','de','dena','please','lao','chahiye',
    'add','karo','lagao','dalo',
  ]);

  // ─── Intent triggers ─────────────────────────────────────────────

  const INVENTORY_TRIGGERS = [
    'add to inventory','inventory mein add','stock mein add',
    'add in inventory','add in stock','add stock',
    'inventory add','stock add','maal aaya','naya maal',
    'stock update','update stock','inventory update',
  ];

  const OPEN_ACCOUNT_PREFIXES = [
    'open account of','open khata of','show account of','show khata of',
    'dikhao account of','dikhao khata of',
    'open account','open khata','show account','show khata',
    'dikhao account','dikhao khata',
  ];

  const OPEN_ACCOUNT_SUFFIX_RE =
    /\b(ka|ke)\s+(account|khata)\s*(kholo|dekho|dikhao|open|show|batao)?\b|\b(khata|account)\s*(kholo|dekho|dikhao)\b/;

  const PAYMENT_KEYWORDS = [
    'ne diya','ne bheja','de diya','wapas kiya',
    'given','paid','payment received',
    'diya','bheja','received','mila','wapas','returned',
  ].sort((a, b) => b.length - a.length);

  const KHATA_BILL_TRIGGERS = [
    'ka khata','ke khata','ka account','ke account',
    'account','khata','udhaar','udhar','credit','ledger',
  ].sort((a, b) => b.length - a.length);

  const CURRENCY_WORDS = new Set([
    'rs','rupees','rupee','rupe','/-','paisa','hazar','thousand',
  ]);

  // ═══════════════════════════════════════════════════════════════════
  //  SMART TOKEN-LEVEL PRODUCT MATCHER
  // ═══════════════════════════════════════════════════════════════════

  function _scoreMatch(query, candidate) {
    if (!query || !candidate) return 1.0;

    const q = _normalise(query);
    const c = _normalise(candidate);

    if (q === c) return 0.0;
    if (c.includes(q)) return 0.04;
    if (q.includes(c)) return 0.06;

    const qToks = _tokenise(q);
    const cToks = _tokenise(c);
    if (!qToks.length) return 1.0;

    let totalScore = 0;

    for (const qt of qToks) {
      let best = 1.0;

      for (const ct of cToks) {
        if (qt === ct) { best = 0.0; break; }

        if (ct.startsWith(qt) && qt.length >= 2) {
          best = Math.min(best, 0.08);
          continue;
        }
        if (qt.startsWith(ct) && ct.length >= 2) {
          best = Math.min(best, 0.10);
          continue;
        }

        if (qt.length === 1 || ct.length === 1) {
          if (qt === ct) best = Math.min(best, 0.0);
          continue;
        }

        const maxLen = Math.max(qt.length, ct.length);
        const lev    = _levenshtein(qt, ct);
        if (lev <= 2) {
          best = Math.min(best, (lev / maxLen) * 0.7);
        }
      }

      totalScore += best;
    }

    const avgScore    = totalScore / qToks.length;
    const extraTokens = Math.max(0, cToks.length - qToks.length);
    const penalty     = extraTokens * 0.04;

    return Math.min(1.0, avgScore + penalty);
  }

  function _normalise(str) {
    return str.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function _tokenise(str) {
    return str.split(' ').filter(t => t.length > 0);
  }

  /**
   * Find the best matching product for a spoken name.
   */
  function findBestMatch(query) {
    const products = Storage.getAllProducts();
    if (!products.length || !query) return null;

    let best = null;
    let bestScore = 1.0;

    for (const product of products) {
      const candidates = [product.name, ...(product.aliases || [])];

      for (const candidate of candidates) {
        const score = _scoreMatch(query, candidate);
        if (score < bestScore) {
          bestScore = score;
          best = { product, score };
        }
      }
    }

    return best && bestScore < 0.45 ? best : null;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  TRANSCRIPT PARSER — v1.4 SLIDING WINDOW APPROACH
  //
  //  The old approach split only on commas, which failed for natural
  //  speech like "gold one piece and tea special one piece".
  //
  //  New approach:
  //  1. First split on hard separators (commas, semicolons, "and"/"aur")
  //  2. For each segment, try to find product + quantity using a
  //     sliding window: try windows of 1..N tokens as product name,
  //     pick the one that gives the best product match score,
  //     then parse what's left as quantity.
  //  3. If a segment has multiple products (e.g. "gold two tea three"),
  //     greedily consume tokens until we find a match boundary.
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Main entry point: parse a transcript into [{rawName, qty}] items.
   */
  function parseProductList(text) {
    // Step 1: Normalise separators
    const cleaned = text.toLowerCase()
      .replace(/[,،;।]/g, '|')           // hard punctuation → pipe
      .replace(/\b(and|aur|tatha|phir|then|also|plus)\b/g, '|')  // connector words → pipe
      .replace(/\s+/g, ' ')
      .trim();

    const results = [];

    // Step 2: Split on pipes, parse each segment
    for (const seg of cleaned.split('|').map(s => s.trim()).filter(Boolean)) {
      const items = _parseSegmentV2(seg);
      results.push(...items);
    }

    return results;
  }

  /**
   * Parse a single segment (already split at connectors).
   * Uses sliding-window product detection to find item boundaries.
   *
   * Handles these patterns within one segment:
   *   "gold one piece"            → [{gold, 1}]
   *   "two amul gold"             → [{amul gold, 2}]
   *   "tea special"               → [{tea special, 1}]
   *   "parle g three"             → [{parle g, 3}]
   *   "gold 1 tea special 1"      → [{gold,1},{tea special,1}]  (no connector)
   */
  function _parseSegmentV2(seg) {
    const tokens = seg.split(' ').filter(t => t.length > 0 && !STOP_WORDS.has(t));
    if (!tokens.length) return [];

    const results = [];
    let i = 0;

    while (i < tokens.length) {
      // Skip unit words
      if (UNIT_WORDS.has(tokens[i])) { i++; continue; }

      // ── QTY-FIRST pattern: number then product name ──────────────
      const leadNum = _parseNumber(tokens[i]);
      if (leadNum !== null) {
        i++;
        // Collect following non-number, non-unit tokens as product name
        // Use sliding window to find the best matching product
        const { name, len } = _findProductWindow(tokens, i);
        if (name) {
          results.push({ rawName: name, qty: leadNum });
          i += len;
          // Skip trailing unit word if present
          if (i < tokens.length && UNIT_WORDS.has(tokens[i])) i++;
        } else {
          // No product found after the number — skip
        }
        continue;
      }

      // ── NAME-FIRST pattern: product name then optional number ─────
      const { name, len } = _findProductWindow(tokens, i);
      if (name) {
        i += len;
        // Skip unit words between name and qty
        while (i < tokens.length && UNIT_WORDS.has(tokens[i])) i++;
        // Read trailing qty if present
        let qty = 1;
        if (i < tokens.length && _parseNumber(tokens[i]) !== null) {
          qty = _parseNumber(tokens[i]);
          i++;
          if (i < tokens.length && UNIT_WORDS.has(tokens[i])) i++;
        }
        results.push({ rawName: name, qty });
        continue;
      }

      // ── Nothing matched at position i — skip token ────────────────
      i++;
    }

    return results;
  }

  /**
   * Sliding window product finder.
   * Starting at `tokens[start]`, tries windows of length 1..MAX_WINDOW
   * (skipping number/unit tokens), picks the window that gives the
   * best product match score. Returns { name, len } or { name: null, len: 0 }.
   *
   * MAX_WINDOW: we try up to 4 tokens as a product name, which covers
   * names like "amul gold full cream milk" while not over-consuming.
   */
  const MAX_WINDOW = 4;

  function _findProductWindow(tokens, start) {
    const products = Storage.getAllProducts();
    if (!products.length) return { name: null, len: 0 };

    let bestName  = null;
    let bestLen   = 0;
    let bestScore = 1.0;

    // Build candidate windows
    const windowTokens = [];
    for (let w = 0; w < MAX_WINDOW && (start + w) < tokens.length; w++) {
      const tok = tokens[start + w];

      // Stop window expansion at numbers (they are quantities) or unit words
      if (_parseNumber(tok) !== null) break;
      if (UNIT_WORDS.has(tok)) break;

      windowTokens.push(tok);
      const windowStr = windowTokens.join(' ');

      // Score this window against all products
      for (const product of products) {
        const candidates = [product.name, ...(product.aliases || [])];
        for (const candidate of candidates) {
          const score = _scoreMatch(windowStr, candidate);
          if (score < bestScore) {
            bestScore = score;
            bestName  = windowStr;
            bestLen   = w + 1;
          }
        }
      }
    }

    // Only accept if score is good enough
    if (bestScore < 0.45) {
      return { name: bestName, len: bestLen };
    }

    return { name: null, len: 0 };
  }

  function _parseNumber(token) {
    if (!token) return null;
    if (/^\d+(\.\d+)?$/.test(token)) return parseFloat(token);
    const v = NUMBER_WORDS[token];
    return (v !== undefined && v !== null) ? v : null;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  INTENT DETECTION
  // ═══════════════════════════════════════════════════════════════════

  function detectIntent(raw) {
    const lower = raw.toLowerCase().trim();

    for (const trigger of INVENTORY_TRIGGERS) {
      if (lower.includes(trigger))
        return { intent: 'inventory', rest: lower.replace(trigger, '').trim() };
    }

    for (const prefix of OPEN_ACCOUNT_PREFIXES) {
      if (lower.startsWith(prefix)) {
        const customerName = lower.slice(prefix.length).replace(/^[\s,of]+/, '').trim();
        if (customerName) return { intent: 'open_account', customerName };
      }
    }

    if (OPEN_ACCOUNT_SUFFIX_RE.test(lower)) {
      const customerName = lower
        .replace(OPEN_ACCOUNT_SUFFIX_RE, '')
        .replace(/\b(ka|ke|ki|open|kholo|dekho|dikhao|show|account|khata|batao)\b/g, '')
        .replace(/\s+/g, ' ').trim();
      if (customerName.length > 1) return { intent: 'open_account', customerName };
    }

    const payResult = _detectPaymentIntent(lower);
    if (payResult) return payResult;

    const khataResult = _detectKhataBillIntent(lower);
    if (khataResult) return khataResult;

    return { intent: 'billing', rest: lower };
  }

  function _detectPaymentIntent(lower) {
    for (const keyword of PAYMENT_KEYWORDS) {
      const idx = lower.indexOf(keyword);
      if (idx === -1) continue;
      const before = lower.slice(0, idx).replace(/\bne\b/g, '').trim();
      if (!before) continue;
      const after  = lower.slice(idx + keyword.length).trim();
      const amount = _extractAmount(after);
      if (amount !== null)
        return { intent: 'khata_payment', customerName: before, amount };
    }
    return null;
  }

  function _detectKhataBillIntent(lower) {
    for (const trigger of KHATA_BILL_TRIGGERS) {
      const idx = lower.indexOf(trigger);
      if (idx === -1) continue;
      const customerName = lower.slice(0, idx).trim();
      if (!customerName) continue;
      const rest = lower.slice(idx + trigger.length).replace(/^[\s,،:]+/, '').trim();
      return { intent: 'khata_bill', customerName, rest };
    }
    return null;
  }

  function _extractAmount(str) {
    const tokens = str.split(/[\s,]+/).filter(Boolean);
    let total = 0, found = false;
    for (const t of tokens) {
      if (CURRENCY_WORDS.has(t)) continue;
      const n = _parseNumber(t);
      if (n !== null) { total += n; found = true; }
    }
    return found ? total : null;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SPEECH RECOGNITION — PRESS & HOLD
  // ═══════════════════════════════════════════════════════════════════

  function _initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { _disableVoiceBtn(); return false; }

    _recognition = new SpeechRecognition();
    _recognition.lang            = Storage.getSettings().voiceLang || 'hi-IN';
    _recognition.continuous      = false;
    _recognition.interimResults  = true;
    _recognition.maxAlternatives = 1;

    _recognition.onstart = () => {
      _isListening = true;
      _transcript  = '';
      _updateVoiceBtnState(true);
      _setTranscript('🎙 Listening…', 'interim');
    };

    _recognition.onresult = e => {
      let interimText = '';
      let finalText   = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText   += t;
        else                       interimText += t;
      }
      if (interimText && !finalText) _setTranscript(interimText, 'interim');
      if (finalText) { _transcript = finalText.trim(); _setTranscript(_transcript, 'final'); }
    };

    _recognition.onerror = e => {
      const msgs = {
        'no-speech'    : 'No speech detected — try again',
        'audio-capture': 'Microphone not available',
        'not-allowed'  : 'Mic permission denied — allow in browser settings',
        'network'      : 'Network error',
      };
      _setTranscript(msgs[e.error] || `Error: ${e.error}`);
      _isListening = false;
      _updateVoiceBtnState(false);
    };

    _recognition.onend = () => {
      _isListening = false;
      _updateVoiceBtnState(false);
      const t = _transcript.trim();
      _transcript = '';
      if (t) _processTranscript(t);
    };

    return true;
  }

  function _onTouchStart(e) { e.preventDefault(); _touchActive = true;  _beginHold(); }
  function _onTouchEnd(e)   { e.preventDefault(); _touchActive = false; _endHold();   }
  function _onMouseDown()   { if (_touchActive) return; _beginHold(); }
  function _onMouseUp()     { if (_touchActive) return; _endHold();   }
  function _onMouseLeave()  { if (_isHolding && !_touchActive) _endHold(); }

  function _beginHold() {
    _recognition = null;
    if (!_initRecognition()) return;
    _isHolding  = true;
    _transcript = '';
    _holdTimer  = setTimeout(() => {
      if (!_isHolding) return;
      try { _recognition.start(); }
      catch (err) { console.warn('[Voice] Start error:', err); }
    }, MIN_HOLD_MS);
  }

  function _endHold() {
    _isHolding = false;
    clearTimeout(_holdTimer);
    if (_isListening) {
      try { _recognition.stop(); }
      catch (err) { console.warn('[Voice] Stop error:', err); }
    } else {
      _updateVoiceBtnState(false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  PROCESS TRANSCRIPT
  // ═══════════════════════════════════════════════════════════════════

  function _processTranscript(raw) {
    _setTranscript(`Heard: "${raw}"`);
    const { intent, rest, customerName, amount } = detectIntent(raw);
    console.log('[Voice] intent=%s customer=%s amount=%s rest=%s', intent, customerName, amount, rest);

    switch (intent) {
      case 'inventory':     _handleInventory(rest);                    break;
      case 'open_account':  _handleOpenAccount(customerName);          break;
      case 'khata_payment': _handleKhataPayment(customerName, amount); break;
      case 'khata_bill':    _handleKhataBill(customerName, rest);      break;
      default:              _handleBilling(rest);                      break;
    }
  }

  function _handleBilling(rest) {
    const parsed = parseProductList(rest);
    console.log('[Voice] parsed items:', JSON.stringify(parsed));

    if (!parsed.length) { _toast('Could not understand — try again', 'error'); return; }

    const added    = [];
    const notFound = [];

    for (const item of parsed) {
      const match = findBestMatch(item.rawName);
      if (match) {
        Billing.addToCart(match.product.id, item.qty);
        added.push(`${match.product.name} ×${item.qty}`);
      } else {
        notFound.push(item.rawName);
      }
    }

    if (added.length)    _toast(`✓ ${added.join(',  ')}`, 'success', 3500);
    if (notFound.length) _toast(`Not found: ${notFound.join(', ')}`, 'error', 4000);
  }

  function _handleInventory(rest) {
    const parsed   = parseProductList(rest);
    if (!parsed.length) { _toast('No products understood', 'error'); return; }

    const updated  = [];
    const notFound = [];

    for (const item of parsed) {
      const match = findBestMatch(item.rawName);
      if (match) {
        const p = match.product;
        Storage.updateProduct(p.id, { stock: (p.stock || 0) + item.qty });
        updated.push(`${p.name} +${item.qty}`);
      } else {
        notFound.push(item.rawName);
      }
    }

    if (updated.length) {
      if (typeof Products !== 'undefined') Products.renderProductList();
      _toast(`📦 ${updated.join(',  ')}`, 'success', 3500);
    }
    if (notFound.length) _toast(`Not found: ${notFound.join(', ')}`, 'error', 4000);
  }

  function _handleOpenAccount(customerName) {
    const customers = Storage.getAllKhata();
    if (!customers.length) { _toast('No khata accounts yet', 'error'); return; }
    const match = _findBestCustomer(customerName, customers);
    if (!match) { _toast(`"${customerName}" not found`, 'error'); return; }
    if (typeof App !== 'undefined') App.switchTab('khata');
    setTimeout(() => {
      if (typeof Khata !== 'undefined') {
        Khata.renderKhataList();
        Khata.openDetailModal(match.id);
        _toast(`Opened: ${match.name}`);
      }
    }, 150);
  }

  function _handleKhataBill(customerName, rest) {
    const custMatch = _findBestCustomer(customerName, Storage.getAllKhata());
    if (!custMatch) { _toast(`"${customerName}" not found`, 'error'); return; }

    const parsed   = parseProductList(rest);
    const added    = [];
    const notFound = [];

    for (const item of parsed) {
      const match = findBestMatch(item.rawName);
      if (match) { Billing.addToCart(match.product.id, item.qty); added.push(`${match.product.name} ×${item.qty}`); }
      else        notFound.push(item.rawName);
    }

    if (added.length) {
      const toggle = $('khata-toggle');
      const select = $('khata-customer-select');
      if (toggle) toggle.checked = true;
      $('khata-customer-select-wrap')?.classList.remove('hidden');
      if (typeof Khata !== 'undefined') Khata.refreshCustomerSelect();
      if (select) select.value = custMatch.id;
      if (typeof BillPrint !== 'undefined') BillPrint.generateBill();
      _toast(`📒 ${custMatch.name}: ${added.join(', ')}`, 'success', 3500);
    }
    if (notFound.length) _toast(`Not found: ${notFound.join(', ')}`, 'error', 4000);
  }

  function _handleKhataPayment(customerName, amount) {
    const custMatch = _findBestCustomer(customerName, Storage.getAllKhata());
    if (!custMatch) { _toast(`"${customerName}" not found`, 'error'); return; }
    const curr = Storage.getSettings().currency || '₹';
    Storage.addKhataTransaction(custMatch.id, 'jama', amount, 'Payment received');
    if (typeof Khata !== 'undefined') Khata.renderKhataList();
    _toast(`💰 ${curr}${amount} from ${custMatch.name} ✓`, 'success', 3000);
  }

  // ─── Customer fuzzy match ─────────────────────────────────────────

  function _findBestCustomer(query, customers) {
    if (!query || !customers.length) return null;
    const q = query.toLowerCase().trim();
    let best = null, bestScore = Infinity;
    customers.forEach(c => {
      const score = _levenshtein(q, c.name.toLowerCase()) / Math.max(q.length, c.name.length);
      if (score < bestScore) { bestScore = score; best = c; }
    });
    return bestScore < 0.55 ? best : null;
  }

  function _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  }

  // ─── UI helpers ──────────────────────────────────────────────────

  function _disableVoiceBtn() {
    const btn = $('voice-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.title    = 'Voice not supported in this browser';
    const label  = $('voice-label');
    if (label) label.textContent = 'Not supported';
    _setTranscript('Voice not supported. Use manual add instead.');
  }

  function _updateVoiceBtnState(listening) {
    const btn   = $('voice-btn');
    const label = $('voice-label');
    if (!btn) return;
    if (listening) {
      btn.classList.add('listening');
      btn.setAttribute('aria-label', 'Release to process');
      if (label) label.textContent = 'Listening…';
    } else {
      btn.classList.remove('listening');
      btn.setAttribute('aria-label', 'Hold to speak');
      if (label) label.textContent = 'Hold to Speak';
    }
  }

  function _setTranscript(text, state = 'idle') {
    const el = $('voice-transcript');
    if (!el) return;
    el.textContent = text;
    el.className   = `voice-transcript ${state}`;
  }

  function _toast(msg, type = 'success', duration = 2800) {
    if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type, duration);
    else console.log(`[Toast] ${msg}`);
  }

  // ─── Init ────────────────────────────────────────────────────────

  function init() {
    const btn = $('voice-btn');
    if (!btn) return;

    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      _disableVoiceBtn();
      return;
    }

    btn.addEventListener('touchstart',  _onTouchStart,  { passive: false });
    btn.addEventListener('touchend',    _onTouchEnd,    { passive: false });
    btn.addEventListener('touchcancel', _onTouchEnd,    { passive: false });
    btn.addEventListener('mousedown',   _onMouseDown);
    btn.addEventListener('mouseup',     _onMouseUp);
    btn.addEventListener('mouseleave',  _onMouseLeave);

    _updateVoiceBtnState(false);
  }

  return { init, parseProductList, detectIntent, findBestMatch };

})();
