'use strict';

/**
 * voice.js — Bill Sathi v1.1
 * Smart voice input with intent detection.
 *
 * FIXES in v1.1:
 *  - Press & Hold mic (no toggle confusion)
 *  - OVERWRITE transcript (never append) → no duplicate words
 *  - Tighter fuzzy match threshold (0.30 confident, 0.45 uncertain)
 *  - Single recognition instance per hold — no stale state
 *  - Confirm dialog: sequential, one at a time, clean clone
 *  - Intent detection: billing / inventory / khata bill / khata payment / open account
 *
 * Supported intents:
 *  1. BILLING        (default) — "amul gold 4 pieces, tea special 5"
 *  2. INVENTORY                — "add to inventory amul gold 20 pieces"
 *  3. KHATA BILL               — "abbasbhai account, amul gold 4 and tea special one"
 *  4. KHATA PAYMENT            — "abbasbhai given 200 rupees"
 *  5. OPEN ACCOUNT             — "open account of abbasbhai"
 *
 * Mic: PRESS AND HOLD → release to process.
 * Works on mobile (touchstart/touchend) and desktop (mousedown/mouseup).
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
  let _touchActive  = false;   // guard: prevents mousedown after touchstart on Android

  const MIN_HOLD_MS = 120;     // min hold time before mic starts

  // ─── Number Word Map (Hindi + English + Hinglish) ────────────────
  const NUMBER_WORDS = {
    // Hindi
    'ek':1,'do':2,'teen':3,'char':4,'paanch':5,
    'chhe':6,'chah':6,'saat':7,'aath':8,'nau':9,'das':10,
    'gyarah':11,'barah':12,'tera':13,'chaudah':14,'pandrah':15,
    'solah':16,'satrah':17,'atharah':18,'unnis':19,'bees':20,
    'pachees':25,'tees':30,'chalees':40,'pachaas':50,
    'saath':70,'assi':80,'nabbe':90,'sau':100,
    // English
    'one':1,'two':2,'three':3,'four':4,'five':5,
    'six':6,'seven':7,'eight':8,'nine':9,'ten':10,
    'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,
    'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,
    'thirty':30,'forty':40,'fifty':50,'sixty':60,'seventy':70,'eighty':80,'ninety':90,
    'hundred':100,'dozen':12,
    // Spoken shortcuts
    'ik':1,'doh':2,'tin':3,'pach':5,'atha':8,
    // currency (ignored as numbers)
    'rs':null,'rupees':null,'rupee':null,'rupe':null,
  };

  const UNIT_WORDS = new Set([
    'pieces','piece','pcs','pc','nos','no','number',
    'kg','kilo','kilos','kilogram','grams','gram',
    'liter','litre','litres','liters','ltr','ml','milliliter',
    'packet','packets','pkt','pkts','box','boxes',
    'dozen','dozens','bottle','bottles','meter','meters',
    'nag','nug','tukda','tukde','kille',
    // intentionally NOT 'g' — breaks "parle g"
  ]);

  const STOP_WORDS = new Set([
    'and','aur','tatha','or','also','with',
    'ke','ka','ki','ko','se',
    'mujhe','de','dena','please','lao','chahiye',
    'add','karo','lagao','dalo','the','a','an',
  ]);

  // ─── Intent Trigger Lists ─────────────────────────────────────────

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
    'given','paid','payment','jama',
    'diya','bheja','bheji','aaya','aya',
    'received','mila','mili','wapas','returned',
  ].sort((a, b) => b.length - a.length);   // longest first for greedy match

  const KHATA_BILL_TRIGGERS = [
    'ka khata','ke khata','ka account','ke account',
    'account','khata','udhaar','udhar','credit','ledger',
  ].sort((a, b) => b.length - a.length);

  const CURRENCY_WORDS = new Set([
    'rs','rupees','rupee','rupe','/-','paisa','hazar','thousand',
  ]);

  // ═══════════════════════════════════════════════════════════════════
  //  SPEECH RECOGNITION
  // ═══════════════════════════════════════════════════════════════════

  function _initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { _disableVoiceBtn(); return false; }

    _recognition = new SpeechRecognition();
    _recognition.lang            = Storage.getSettings().voiceLang || 'hi-IN';
    _recognition.continuous      = false;   // SINGLE utterance — prevents duplicate onresult events
    _recognition.interimResults  = true;    // live preview while speaking
    _recognition.maxAlternatives = 1;

    _recognition.onstart = () => {
      _isListening = true;
      _transcript  = '';
      _updateVoiceBtnState(true);
      _setTranscript('🎙 Listening…', 'interim');
    };

    _recognition.onresult = e => {
      // ── KEY FIX: OVERWRITE, never append ────────────────────────
      // Collecting ALL results fresh each time prevents duplicate words
      // that occur when onresult fires multiple times.
      let interimText = '';
      let finalText   = '';

      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText   += t;
        else                       interimText += t;
      }

      if (interimText && !finalText) {
        _setTranscript(interimText, 'interim');
      }

      if (finalText) {
        _transcript = finalText.trim();   // OVERWRITE — never append
        _setTranscript(_transcript, 'final');
      }
    };

    _recognition.onerror = e => {
      const msgs = {
        'no-speech'    : 'No speech detected — try again',
        'audio-capture': 'Microphone not available',
        'not-allowed'  : 'Mic permission denied — allow in browser settings',
        'network'      : 'Network error — needs internet first time',
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

  // ─── Press & Hold Handlers ────────────────────────────────────────

  function _onTouchStart(e) {
    e.preventDefault();       // block the ghost mousedown/mouseup on Android
    _touchActive = true;
    _beginHold();
  }

  function _onTouchEnd(e) {
    e.preventDefault();
    _touchActive = false;
    _endHold();
  }

  function _onMouseDown() {
    if (_touchActive) return; // touch already handled this
    _beginHold();
  }

  function _onMouseUp() {
    if (_touchActive) return;
    _endHold();
  }

  function _onMouseLeave() {
    if (_isHolding && !_touchActive) _endHold();
  }

  function _beginHold() {
    // Always create a FRESH recognition instance — clears all stale state
    _recognition = null;
    if (!_initRecognition()) return;

    _isHolding  = true;
    _transcript = '';

    // Small delay before starting — avoids accidental taps
    _holdTimer = setTimeout(() => {
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
  //  INTENT DETECTION
  // ═══════════════════════════════════════════════════════════════════

  function detectIntent(raw) {
    const lower = raw.toLowerCase().trim();

    // 1. Inventory intent
    for (const trigger of INVENTORY_TRIGGERS) {
      if (lower.includes(trigger))
        return { intent: 'inventory', rest: lower.replace(trigger, '').trim() };
    }

    // 2. Open account intent (prefix style)
    for (const prefix of OPEN_ACCOUNT_PREFIXES) {
      if (lower.startsWith(prefix)) {
        const customerName = lower.slice(prefix.length).replace(/^[\s,of]+/, '').trim();
        if (customerName) return { intent: 'open_account', customerName };
      }
    }

    // 3. Open account intent (suffix style: "abbasbhai ka khata kholo")
    if (OPEN_ACCOUNT_SUFFIX_RE.test(lower)) {
      const customerName = lower
        .replace(OPEN_ACCOUNT_SUFFIX_RE, '')
        .replace(/\b(ka|ke|ki|open|kholo|dekho|dikhao|show|account|khata|batao)\b/g, '')
        .replace(/\s+/g, ' ').trim();
      if (customerName.length > 1) return { intent: 'open_account', customerName };
    }

    // 4. Khata payment intent
    const payResult = _detectPaymentIntent(lower);
    if (payResult) return payResult;

    // 5. Khata bill intent
    const khataResult = _detectKhataBillIntent(lower);
    if (khataResult) return khataResult;

    // 6. Default: billing
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
  //  PRODUCT LIST PARSER
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Parse transcript into [{rawName, qty}] entries.
   * Handles comma-separated segments, qty-first and name-first patterns.
   *
   * Examples:
   *   "amul gold four pieces"     → [{rawName:"amul gold", qty:4}]
   *   "four amul gold"            → [{rawName:"amul gold", qty:4}]
   *   "tea two and biscuit one"   → [{rawName:"tea",qty:2},{rawName:"biscuit",qty:1}]
   *   "gold 4 tea 2"              → [{rawName:"gold",qty:4},{rawName:"tea",qty:2}]
   */
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

      // Skip bare stop/unit words
      if (STOP_WORDS.has(tok) || UNIT_WORDS.has(tok)) { i++; continue; }

      const num = _parseNumber(tok);

      if (num !== null) {
        // ── QTY-FIRST: "4 amul gold" ──────────────────────────────
        i++;
        const nameToks = [];
        while (i < tokens.length) {
          const t = tokens[i];
          if (STOP_WORDS.has(t))        { i++; break; }
          if (UNIT_WORDS.has(t))        { i++; break; }
          if (_parseNumber(t) !== null) { break; }   // next qty → stop
          nameToks.push(t);
          i++;
        }
        if (nameToks.length) results.push({ rawName: nameToks.join(' '), qty: num });

      } else {
        // ── NAME-FIRST: "amul gold 4 pieces" ──────────────────────
        const nameToks = [];
        while (i < tokens.length) {
          const t = tokens[i];
          if (STOP_WORDS.has(t))        { i++; break; }
          if (UNIT_WORDS.has(t))        { i++; break; }
          if (_parseNumber(t) !== null) { break; }   // qty found → stop collecting name
          nameToks.push(t);
          i++;
        }

        // Optional trailing quantity
        let qty = 1;
        if (i < tokens.length && _parseNumber(tokens[i]) !== null) {
          qty = _parseNumber(tokens[i]);
          i++;
          // Swallow optional unit word e.g. "4 pieces"
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
  //  INTENT HANDLERS
  // ═══════════════════════════════════════════════════════════════════

  function _processTranscript(raw) {
    _setTranscript(`Heard: "${raw}"`);
    const { intent, rest, customerName, amount } = detectIntent(raw);
    console.log('[Voice] intent=%s customer=%s amount=%s rest=%s', intent, customerName, amount, rest);

    switch (intent) {
      case 'inventory':
        _toast('📦 Updating stock…', 'info');
        _handleInventory(rest);
        break;
      case 'open_account':
        _toast(`📒 Opening ${customerName}'s account…`, 'info');
        _handleOpenAccount(customerName);
        break;
      case 'khata_payment':
        _toast('💰 Recording payment…', 'info');
        _handleKhataPayment(customerName, amount);
        break;
      case 'khata_bill':
        _toast('📒 Khata bill…', 'info');
        _handleKhataBill(customerName, rest);
        break;
      case 'billing':
      default:
        _handleBilling(rest);
        break;
    }
  }

  // ─── Billing ─────────────────────────────────────────────────────

  function _handleBilling(rest) {
    const parsed = parseProductList(rest);
    if (!parsed.length) { _toast('No products understood — try again', 'error'); return; }
    _matchAndAddToCart(parsed);
  }

  // ─── Inventory ───────────────────────────────────────────────────

  function _handleInventory(rest) {
    const parsed = parseProductList(rest);
    if (!parsed.length) { _toast('No products understood for inventory', 'error'); return; }

    let added = 0;
    const unknown = [];
    parsed.forEach(item => {
      const match = Products.findBestMatch(item.rawName);
      if (match && match.score < 0.35) {
        const p = match.product;
        const newStock = (p.stock || 0) + item.qty;
        Storage.updateProduct(p.id, { stock: newStock });
        added++;
        _toast(`✓ ${p.name} stock +${item.qty} → now ${newStock}`, 'success');
      } else {
        unknown.push(item.rawName);
      }
    });

    if (added && typeof Products !== 'undefined') Products.renderProductList();
    if (unknown.length) _toast(`Not found: ${unknown.join(', ')}`, 'error');
  }

  // ─── Open Account ─────────────────────────────────────────────────

  function _handleOpenAccount(customerName) {
    const customers = Storage.getAllKhata();
    if (!customers.length) { _toast('No khata accounts yet', 'error'); return; }
    const match = _findBestCustomer(customerName, customers);
    if (!match) { _toast(`"${customerName}" not found in Khata`, 'error'); return; }
    if (typeof App !== 'undefined') App.switchTab('khata');
    setTimeout(() => {
      if (typeof Khata !== 'undefined') {
        Khata.renderKhataList();
        Khata.openDetailModal(match.id);
        _toast(`Opened ${match.name}'s account ✓`);
      }
    }, 150);
  }

  // ─── Khata Bill ───────────────────────────────────────────────────

  function _handleKhataBill(customerName, rest) {
    const customers = Storage.getAllKhata();
    if (!customers.length) { _toast('No khata customers found', 'error'); return; }
    const custMatch = _findBestCustomer(customerName, customers);
    if (!custMatch) { _toast(`"${customerName}" not found in Khata`, 'error'); return; }
    const parsed = parseProductList(rest);
    if (!parsed.length) { _toast('No products understood for khata bill', 'error'); return; }
    _showKhataConfirm(custMatch, parsed);
  }

  // ─── Khata Payment ────────────────────────────────────────────────

  function _handleKhataPayment(customerName, amount) {
    const customers = Storage.getAllKhata();
    const custMatch = _findBestCustomer(customerName, customers);
    if (!custMatch) { _toast(`"${customerName}" not found in Khata`, 'error'); return; }
    const curr = Storage.getSettings().currency || '₹';
    _showConfirmDialog(
      'Khata Payment',
      `<p>Customer: <strong>${_esc(custMatch.name)}</strong></p>
       <p>Payment received: <strong>${curr}${amount}</strong></p>
       <p>Current balance: <strong class="${custMatch.balance > 0 ? 'baki' : 'jama'}">
         ${custMatch.balance > 0 ? 'Baki' : 'Jama'} ${curr}${Math.abs(custMatch.balance || 0).toFixed(2)}
       </strong></p>`,
      'Record Payment',
      () => {
        Storage.addKhataTransaction(custMatch.id, 'jama', amount, 'Payment received');
        if (typeof Khata !== 'undefined') Khata.renderKhataList();
        _toast(`${curr}${amount} recorded for ${custMatch.name} ✓`);
      }
    );
  }

  // ─── Khata Bill Confirm ───────────────────────────────────────────

  function _showKhataConfirm(customer, parsedItems) {
    const curr    = Storage.getSettings().currency || '₹';
    const matched = parsedItems.map(item => ({
      ...item, match: Products.findBestMatch(item.rawName),
    }));
    const confident  = matched.filter(i => i.match && i.match.score < 0.35);
    const unresolved = matched.filter(i => !i.match || i.match.score >= 0.35);

    let html = `<p>Customer: <strong>${_esc(customer.name)}</strong></p>
                <p style="margin-bottom:6px">Items to add:</p>
                <ul style="padding-left:16px;font-size:0.85rem;line-height:1.9">`;
    confident.forEach(i => {
      const total = i.qty * i.match.product.sellPrice;
      html += `<li><strong>${_esc(i.match.product.name)}</strong> × ${i.qty} = ${curr}${total.toFixed(2)}</li>`;
    });
    if (unresolved.length)
      html += `<li style="color:var(--accent-red)">⚠ Not found: ${unresolved.map(i => i.rawName).join(', ')}</li>`;
    html += `</ul>`;

    _showConfirmDialog('Khata Bill', html, 'Add to Khata', () => {
      confident.forEach(i => Billing.addToCart(i.match.product.id, i.qty));
      const toggle = $('khata-toggle');
      const select = $('khata-customer-select');
      if (toggle) toggle.checked = true;
      $('khata-customer-select-wrap')?.classList.remove('hidden');
      if (typeof Khata !== 'undefined') Khata.refreshCustomerSelect();
      if (select) select.value = customer.id;
      if (typeof BillPrint !== 'undefined') {
        BillPrint.generateBill();
        _toast(`Khata bill created for ${customer.name} ✓`);
      }
    });
  }

  // ─── Generic Confirm Dialog ───────────────────────────────────────

  function _showConfirmDialog(title, bodyHtml, confirmLabel, onConfirm) {
    const dialog = $('confirm-dialog');
    if (!dialog) return;

    $('confirm-dialog-title').textContent = title;
    $('confirm-dialog-body').innerHTML    = bodyHtml;
    dialog.classList.remove('hidden');

    // Clone buttons to wipe all previous listeners
    const yesBtn = $('confirm-dialog-yes');
    const noBtn  = $('confirm-dialog-no');
    const newYes = yesBtn.cloneNode(true);
    const newNo  = noBtn.cloneNode(true);
    yesBtn.parentNode.replaceChild(newYes, yesBtn);
    noBtn.parentNode.replaceChild(newNo, noBtn);

    newYes.textContent = confirmLabel;
    newNo.textContent  = 'Cancel';

    const _close = () => {
      dialog.classList.add('hidden');
      // Reset labels for next use
      $('confirm-dialog-yes').textContent = 'Yes, Add';
      $('confirm-dialog-no').textContent  = 'No';
    };

    newYes.addEventListener('click', () => { _close(); onConfirm(); });
    newNo.addEventListener('click',  _close);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  MATCH PRODUCTS & ADD TO CART
  // ═══════════════════════════════════════════════════════════════════

  let _pendingMatches = [];
  let _confirmIndex   = 0;

  function _matchAndAddToCart(parsed) {
    const toProcess = parsed.map(item => ({
      ...item, match: Products.findBestMatch(item.rawName),
    }));

    // ── TIGHTER THRESHOLDS (v1.1 fix) ────────────────────────────
    // score < 0.30 → add immediately (high confidence)
    // score 0.30–0.45 → ask user to confirm
    // score > 0.45 → reject (too different)
    const confident = toProcess.filter(i => i.match && i.match.score < 0.30);
    const uncertain = toProcess.filter(i => i.match && i.match.score >= 0.30 && i.match.score < 0.45);
    const rejected  = toProcess.filter(i => !i.match || i.match.score >= 0.45);

    // Add confident items silently
    confident.forEach(item => Billing.addToCart(item.match.product.id, item.qty));
    if (confident.length) _toast(`${confident.length} item${confident.length > 1 ? 's' : ''} added ✓`);

    // Notify about rejected items
    if (rejected.length) {
      _toast(`Not found: ${rejected.map(i => i.rawName).join(', ')}`, 'error');
    }

    // Queue uncertain items for confirm dialog
    if (uncertain.length) {
      _pendingMatches = uncertain;
      _confirmIndex   = 0;
      _processNextConfirm();
    }
  }

  function _processNextConfirm() {
    if (_confirmIndex >= _pendingMatches.length) {
      _pendingMatches = [];
      return;
    }

    const item = _pendingMatches[_confirmIndex];
    const body = `<p>You said: <strong>"${_esc(item.rawName)}"</strong> × ${item.qty}</p>
                  <p>Did you mean: <strong>${_esc(item.match.product.name)}</strong>?</p>
                  <p class="match-score">Confidence: ${Math.round((1 - item.match.score) * 100)}%</p>`;

    _showConfirmDialog('Confirm Product', body, 'Yes, Add', () => {
      Billing.addToCart(item.match.product.id, item.qty);
      _confirmIndex++;
      _processNextConfirm();
    });

    // Override No button to skip (not close entirely)
    const noBtn  = $('confirm-dialog-no');
    const newNo  = noBtn.cloneNode(true);
    noBtn.parentNode.replaceChild(newNo, noBtn);
    newNo.textContent = 'Skip';
    newNo.addEventListener('click', () => {
      $('confirm-dialog').classList.add('hidden');
      $('confirm-dialog-yes').textContent = 'Yes, Add';
      $('confirm-dialog-no').textContent  = 'No';
      _confirmIndex++;
      _processNextConfirm();
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CUSTOMER FUZZY MATCH
  // ═══════════════════════════════════════════════════════════════════

  function _findBestCustomer(query, customers) {
    if (!query || !customers.length) return null;
    const q = query.toLowerCase().trim();
    let best = null, bestScore = Infinity;
    customers.forEach(c => {
      const score = _levenshtein(q, c.name.toLowerCase()) /
        Math.max(q.length, c.name.length);
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

  // ═══════════════════════════════════════════════════════════════════
  //  UI HELPERS
  // ═══════════════════════════════════════════════════════════════════

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

  function _esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function _toast(msg, type = 'success') {
    if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type);
    else console.log(`[Toast] ${msg}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════════════

  function init() {
    const btn = $('voice-btn');
    if (!btn) return;

    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      _disableVoiceBtn();
      return;
    }

    // Touch (mobile) — passive:false needed for preventDefault() to block ghost events
    btn.addEventListener('touchstart',  _onTouchStart,  { passive: false });
    btn.addEventListener('touchend',    _onTouchEnd,    { passive: false });
    btn.addEventListener('touchcancel', _onTouchEnd,    { passive: false });

    // Mouse (desktop)
    btn.addEventListener('mousedown',  _onMouseDown);
    btn.addEventListener('mouseup',    _onMouseUp);
    btn.addEventListener('mouseleave', _onMouseLeave);

    _updateVoiceBtnState(false);
  }

  // ─── Public API ──────────────────────────────────────────────────
  return {
    init,
    parseProductList,
    detectIntent,
  };

})();
