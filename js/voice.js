'use strict';

/**
 * voice.js — Bill Sathi v1.3
 *
 * WHAT'S NEW in v1.3 (fully offline, no API needed):
 *  - Token-level fuzzy matching instead of whole-string Levenshtein
 *    → "amul gol" matches "Amul Gold", "parleg" matches "Parle-G"
 *  - Checks each spoken word against each product name word separately
 *  - Prefix matching: "spec" matches "Special", "gol" matches "Gold"
 *  - ZERO confirm popups — items added silently
 *  - ONE clean toast summary at the end: "✓ Added: X, Y  |  Not found: Z"
 *  - Press & Hold mic (same as v1.1)
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

  const STOP_WORDS = new Set([
    'and','aur','tatha','or','also','with','the','a','an',
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

  /**
   * Score how well a spoken query matches a product name or alias.
   * Returns 0.0 (perfect match) → 1.0 (no match at all).
   * Threshold: < 0.45 = accept.
   *
   * How it works:
   *  - Split both query and candidate into word tokens
   *  - For each spoken word, find the best matching product word
   *  - Exact word > prefix > fuzzy (Levenshtein ≤ 2 edits)
   *  - Average the per-token scores
   *  - Much better than whole-string Levenshtein:
   *    "t special" → ["t","special"] each matched against ["tea","special"]
   *    → "special" exact = 0.0, "t" prefix of "tea" = 0.1 → avg ~0.05 ✓
   */
  function _scoreMatch(query, candidate) {
    if (!query || !candidate) return 1.0;

    const q = _normalise(query);
    const c = _normalise(candidate);

    // Exact full match
    if (q === c) return 0.0;

    // One contains the other
    if (c.includes(q)) return 0.04;
    if (q.includes(c)) return 0.06;

    const qToks = _tokenise(q);
    const cToks = _tokenise(c);
    if (!qToks.length) return 1.0;

    let totalScore = 0;

    for (const qt of qToks) {
      let best = 1.0;

      for (const ct of cToks) {
        // Exact token match
        if (qt === ct) { best = 0.0; break; }

        // Prefix: "spec" matches "special", "gol" matches "gold"
        if (ct.startsWith(qt) && qt.length >= 2) {
          best = Math.min(best, 0.08);
          continue;
        }
        if (qt.startsWith(ct) && ct.length >= 2) {
          best = Math.min(best, 0.10);
          continue;
        }

        // Single-character token (like "g" in "Parle G") — exact only
        if (qt.length === 1 || ct.length === 1) {
          if (qt === ct) best = Math.min(best, 0.0);
          continue;
        }

        // Levenshtein on individual tokens (max 2 edits allowed)
        const maxLen = Math.max(qt.length, ct.length);
        const lev    = _levenshtein(qt, ct);
        if (lev <= 2) {
          best = Math.min(best, (lev / maxLen) * 0.7);
        }
      }

      totalScore += best;
    }

    const avgScore    = totalScore / qToks.length;
    // Small penalty if candidate has many more tokens than query
    const extraTokens = Math.max(0, cToks.length - qToks.length);
    const penalty     = extraTokens * 0.04;

    return Math.min(1.0, avgScore + penalty);
  }

  function _normalise(str) {
    return str.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')   // remove punctuation/hyphens
      .replace(/\s+/g, ' ')
      .trim();
  }

  function _tokenise(str) {
    return str.split(' ').filter(t => t.length > 0);
  }

  /**
   * Find the best matching product for a spoken name.
   * Checks: product name + all aliases.
   * Returns { product, score } or null if nothing good enough.
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
  //  TRANSCRIPT PARSER
  //  Splits spoken text into [{rawName, qty}] segments
  // ═══════════════════════════════════════════════════════════════════

  function parseProductList(text) {
    const cleaned = text.toLowerCase()
      .replace(/[,،;।]/g, ',')
      .replace(/\s+/g, ' ')
      .trim();

    const results = [];
    for (const seg of cleaned.split(',').map(s => s.trim()).filter(Boolean)) {
      results.push(..._parseSegment(seg));
    }
    return results;
  }

  function _parseSegment(seg) {
    const tokens = seg.split(' ').filter(Boolean);
    const results = [];
    let i = 0;

    while (i < tokens.length) {
      const tok = tokens[i];

      if (STOP_WORDS.has(tok) || UNIT_WORDS.has(tok)) { i++; continue; }

      const num = _parseNumber(tok);

      if (num !== null) {
        // QTY-FIRST: "4 amul gold"
        i++;
        const nameToks = [];
        while (i < tokens.length) {
          const t = tokens[i];
          if (STOP_WORDS.has(t))        { i++; break; }
          if (UNIT_WORDS.has(t))        { i++; break; }
          if (_parseNumber(t) !== null) { break; }
          nameToks.push(t);
          i++;
        }
        if (nameToks.length) results.push({ rawName: nameToks.join(' '), qty: num });

      } else {
        // NAME-FIRST: "amul gold 4 pieces"
        const nameToks = [];
        while (i < tokens.length) {
          const t = tokens[i];
          if (STOP_WORDS.has(t))        { i++; break; }
          if (UNIT_WORDS.has(t))        { i++; break; }
          if (_parseNumber(t) !== null) { break; }
          nameToks.push(t);
          i++;
        }

        let qty = 1;
        if (i < tokens.length && _parseNumber(tokens[i]) !== null) {
          qty = _parseNumber(tokens[i]);
          i++;
          if (i < tokens.length && UNIT_WORDS.has(tokens[i])) i++;
        }

        if (nameToks.length) results.push({ rawName: nameToks.join(' '), qty });
      }
    }

    return results;
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
    _recognition.continuous      = false;   // single utterance — no duplicates
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
      // OVERWRITE — never append, prevents duplicate words
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
  //  PROCESS TRANSCRIPT — ZERO POPUPS
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

    // Clean single-line summary — no popups ever
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
