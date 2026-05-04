'use strict';

/**
 * voice.js — Bill Sathi
 * Smart voice input with intent detection.
 *
 * Supported intents:
 *  1. BILLING        (default) — "amul gold 4 pieces, tea special 5"
 *  2. INVENTORY                — "add to inventory amul gold 20 pieces"
 *  3. KHATA BILL               — "abbasbhai account, amul gold 4 and tea special one"
 *  4. KHATA PAYMENT            — "abbasbhai given 200 rupees" / "abbasbhai ne 500 diya"
 *  5. OPEN ACCOUNT             — "open account of abbasbhai" / "abbasbhai ka khata kholo"
 *
 * Mic behaviour: PRESS AND HOLD to listen, release to process.
 * Works on mobile (touchstart/touchend) and desktop (mousedown/mouseup).
 *
 * Depends on: storage.js, products.js, billing.js, khata.js, app.js
 */

const Voice = (() => {

  const $ = id => document.getElementById(id);

  // ─── State ───────────────────────────────────────────────────────
  let _recognition     = null;
  let _isListening     = false;
  let _isHolding       = false;
  let _finalTranscript = '';
  let _holdTimer       = null;

  // Only start if held for this long — prevents accidental taps
  const MIN_HOLD_MS = 120;

  // ─── Number Word Map ─────────────────────────────────────────────
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
    'thirty':30,'forty':40,'fifty':50,'sixty':60,'seventy':70,'eighty':80,'ninety':90,
    'hundred':100,'dozen':12,
    'ik':1,'doh':2,'tin':3,'pach':5,'atha':8,
    // currency words — map to null so _parseNumber returns null (skipped)
    'rs':null,'rupees':null,'rupee':null,'rupe':null,
  };

  // ─── Unit words — stop product name after qty ────────────────────
  const UNIT_WORDS = new Set([
    'pieces','piece','pcs','pc','nos','no','number',
    'kg','kilo','kilos','kilogram','grams','gram','g',
    'liter','litre','litres','liters','ltr','ml','milliliter',
    'packet','packets','pkt','pkts','box','boxes',
    'dozen','dozens','bottle','bottles','meter','meters',
    'nag','nug','tukda','tukde','kille',
  ]);

  // ─── Filler words — ignored during product name parsing ──────────
  const STOP_WORDS = new Set([
    'and','aur','tatha','or','also','with',
    'ke','ka','ki','ko','se',
    'mujhe','de','dena','please','lao','chahiye',
    'add','karo','lagao','dalo','the','a','an',
  ]);

  // ─── Intent triggers ─────────────────────────────────────────────

  const INVENTORY_TRIGGERS = [
    'add to inventory','inventory mein add','stock mein add',
    'add in inventory','add in stock','add stock',
    'inventory add','stock add','maal aaya','naya maal',
    'stock update','update stock','inventory update',
  ];

  // Prefix-style: "open account of X"
  const OPEN_ACCOUNT_PREFIXES = [
    'open account of','open khata of','show account of','show khata of',
    'dikhao account of','dikhao khata of',
    'open account','open khata','show account','show khata',
    'dikhao account','dikhao khata',
  ];

  // Suffix-style: "X ka khata kholo" — regex applied to full sentence
  const OPEN_ACCOUNT_SUFFIX_RE =
    /\b(ka|ke)\s+(account|khata)\s*(kholo|dekho|dikhao|open|show|batao)?\b|\b(khata|account)\s*(kholo|dekho|dikhao)\b/;

  // Payment keywords — sorted longest-first for greedy matching
  const PAYMENT_KEYWORDS = [
    'ne diya','ne bheja','de diya','wapas kiya',
    'given','paid','payment','jama',
    'diya','bheja','bheji','aaya','aya',
    'received','mila','mili','wapas','returned',
  ].sort((a, b) => b.length - a.length);

  // Khata bill trigger words after customer name
  const KHATA_BILL_TRIGGERS = [
    'ka khata','ke khata','ka account','ke account',
    'account','khata','udhaar','udhar','credit','ledger',
  ].sort((a, b) => b.length - a.length);

  const CURRENCY_WORDS = new Set([
    'rs','rupees','rupee','rupe','/-','paisa','hazar','thousand',
  ]);

  // ═══════════════════════════════════════════════════════════════════
  //  INTENT DETECTION
  // ═══════════════════════════════════════════════════════════════════

  function detectIntent(raw) {
    const lower = raw.toLowerCase().trim();

    // 1. Inventory
    for (const trigger of INVENTORY_TRIGGERS) {
      if (lower.includes(trigger))
        return { intent: 'inventory', rest: lower.replace(trigger, '').trim() };
    }

    // 2. Open account — prefix style ("open account of abbasbhai")
    for (const prefix of OPEN_ACCOUNT_PREFIXES) {
      if (lower.startsWith(prefix)) {
        const customerName = lower.slice(prefix.length)
          .replace(/^[\s,of]+/, '').trim();
        if (customerName) return { intent: 'open_account', customerName };
      }
    }

    // 3. Open account — suffix style ("abbasbhai ka khata kholo")
    if (OPEN_ACCOUNT_SUFFIX_RE.test(lower)) {
      const customerName = lower
        .replace(OPEN_ACCOUNT_SUFFIX_RE, '')
        .replace(/\b(ka|ke|ki|open|kholo|dekho|dikhao|show|account|khata|batao)\b/g, '')
        .replace(/\s+/g, ' ').trim();
      if (customerName.length > 1)
        return { intent: 'open_account', customerName };
    }

    // 4. Khata payment ("abbasbhai given 200 rupees")
    const payResult = _detectPaymentIntent(lower);
    if (payResult) return payResult;

    // 5. Khata bill ("abbasbhai account, amul gold 4")
    const khataResult = _detectKhataBillIntent(lower);
    if (khataResult) return khataResult;

    // 6. Default billing
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

      const rest = lower.slice(idx + trigger.length)
        .replace(/^[\s,،:]+/, '').trim();

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

  function parseProductList(text) {
    const cleaned = text.toLowerCase()
      .replace(/[,،;।]/g, ' , ')
      .replace(/\s+/g, ' ').trim();

    const results = [];
    for (const seg of cleaned.split(',').map(s => s.trim()).filter(Boolean))
      results.push(..._parseSegment(seg));
    return results;
  }

  function _parseSegment(seg) {
    const tokens = seg.split(' ').filter(Boolean);
    const results = [];
    let i = 0;

    while (i < tokens.length) {
      const token = tokens[i];
      if (STOP_WORDS.has(token)) { i++; continue; }

      const leadingNum = _parseNumber(token);

      if (leadingNum !== null) {
        // Qty-first: "4 amul gold"
        i++;
        const nameToks = [];
        while (i < tokens.length) {
          const t = tokens[i];
          if (STOP_WORDS.has(t))        { i++; break; }
          if (UNIT_WORDS.has(t))        { i++; break; }
          if (_parseNumber(t) !== null)        break;
          nameToks.push(t); i++;
          if (nameToks.length >= 5) break;
        }
        if (nameToks.length) results.push({ rawName: nameToks.join(' '), qty: leadingNum });

      } else {
        // Name-first: "amul gold 4 pieces"
        const nameToks = [];
        while (i < tokens.length) {
          const t = tokens[i];
          if (STOP_WORDS.has(t))        { i++; break; }
          if (_parseNumber(t) !== null)        break;
          nameToks.push(t); i++;
          if (nameToks.length >= 5) break;
        }

        let qty = 1;
        if (i < tokens.length) {
          const n = _parseNumber(tokens[i]);
          if (n !== null) {
            qty = n; i++;
            if (i < tokens.length && UNIT_WORDS.has(tokens[i])) i++;
          }
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

  function _handleBilling(rest) {
    const parsed = parseProductList(rest);
    if (!parsed.length) { _toast('No products understood — try again', 'error'); return; }
    _matchAndAddToCart(parsed);
  }

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

  function _handleOpenAccount(customerName) {
    const customers = Storage.getAllKhata();
    if (!customers.length) { _toast('No khata accounts yet', 'error'); return; }

    const match = _findBestCustomer(customerName, customers);
    if (!match) { _toast(`"${customerName}" not found in Khata`, 'error'); return; }

    // Switch to Khata tab first, then open modal
    if (typeof App !== 'undefined') App.switchTab('khata');

    setTimeout(() => {
      if (typeof Khata !== 'undefined') {
        Khata.renderKhataList();
        Khata.openDetailModal(match.id);
        _toast(`Opened ${match.name}'s account ✓`);
      }
    }, 150);
  }

  function _handleKhataBill(customerName, rest) {
    const customers = Storage.getAllKhata();
    if (!customers.length) { _toast('No khata customers found', 'error'); return; }

    const custMatch = _findBestCustomer(customerName, customers);
    if (!custMatch) { _toast(`"${customerName}" not found in Khata`, 'error'); return; }

    const parsed = parseProductList(rest);
    if (!parsed.length) { _toast('No products understood for khata bill', 'error'); return; }

    _showKhataConfirm(custMatch, parsed);
  }

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

  // ─── Khata bill confirm ───────────────────────────────────────────

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

  // ─── Generic confirm dialog ───────────────────────────────────────

  function _showConfirmDialog(title, bodyHtml, confirmLabel, onConfirm) {
    const dialog = $('confirm-dialog');
    if (!dialog) return;

    $('confirm-dialog-title').textContent = title;
    $('confirm-dialog-body').innerHTML    = bodyHtml;
    dialog.classList.remove('hidden');

    const yesBtn = $('confirm-dialog-yes');
    const noBtn  = $('confirm-dialog-no');
    yesBtn.textContent = confirmLabel;
    noBtn.textContent  = 'Cancel';

    const newYes = yesBtn.cloneNode(true);
    const newNo  = noBtn.cloneNode(true);
    yesBtn.parentNode.replaceChild(newYes, yesBtn);
    noBtn.parentNode.replaceChild(newNo, noBtn);

    const _close = () => {
      dialog.classList.add('hidden');
      $('confirm-dialog-title').textContent = 'Confirm Product';
      $('confirm-dialog-yes').textContent   = 'Yes, Add';
      $('confirm-dialog-no').textContent    = 'No';
    };

    newYes.addEventListener('click', () => { _close(); onConfirm(); });
    newNo.addEventListener('click',  _close);
  }

  // ─── Match products & add to cart ────────────────────────────────

  let _pendingMatches = [];
  let _confirmIndex   = 0;

  function _matchAndAddToCart(parsed) {
    const toProcess = parsed.map(item => ({
      ...item, match: Products.findBestMatch(item.rawName),
    }));

    const confident = toProcess.filter(i => i.match && i.match.score < 0.25);
    const uncertain = toProcess.filter(i => !i.match || i.match.score >= 0.25);

    confident.forEach(item => Billing.addToCart(item.match.product.id, item.qty));
    if (confident.length) _toast(`${confident.length} item${confident.length > 1 ? 's' : ''} added ✓`);

    if (uncertain.length) {
      _pendingMatches = uncertain;
      _confirmIndex   = 0;
      _processNextConfirm();
    }
  }

  function _processNextConfirm() {
    if (_confirmIndex >= _pendingMatches.length) { _pendingMatches = []; return; }

    const item = _pendingMatches[_confirmIndex];
    const body = item.match
      ? `<p>You said: <strong>"${_esc(item.rawName)}"</strong> × ${item.qty}</p>
         <p>Did you mean: <strong>${_esc(item.match.product.name)}</strong>?</p>
         <p class="match-score">Confidence: ${Math.round((1 - item.match.score) * 100)}%</p>`
      : `<p>You said: <strong>"${_esc(item.rawName)}"</strong> × ${item.qty}</p>
         <p>⚠️ No product found. Add as custom item?</p>`;

    _showConfirmDialog('Confirm Product', body, 'Yes, Add', () => {
      if (item.match) Billing.addToCart(item.match.product.id, item.qty);
      else            Billing.addToCart(null, item.qty, item.rawName, 0);
      _confirmIndex++;
      _processNextConfirm();
    });

    // Override cancel button to also advance the queue
    const noBtn = $('confirm-dialog-no');
    const newNo = noBtn.cloneNode(true);
    noBtn.parentNode.replaceChild(newNo, noBtn);
    newNo.textContent = 'No';
    newNo.addEventListener('click', () => {
      $('confirm-dialog').classList.add('hidden');
      $('confirm-dialog-title').textContent = 'Confirm Product';
      $('confirm-dialog-yes').textContent   = 'Yes, Add';
      $('confirm-dialog-no').textContent    = 'No';
      _confirmIndex++;
      _processNextConfirm();
    });
  }

  // ─── Customer fuzzy match ─────────────────────────────────────────

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
  //  SPEECH RECOGNITION
  // ═══════════════════════════════════════════════════════════════════

  function _initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { _disableVoiceBtn(); return false; }

    _recognition = new SpeechRecognition();
    _recognition.lang            = Storage.getSettings().voiceLang || 'hi-IN';
    _recognition.interimResults  = true;
    _recognition.maxAlternatives = 3;
    _recognition.continuous      = true; // keep capturing while held down

    _recognition.onstart = () => {
      _isListening = true;
      _updateVoiceBtnState(true);
      _setTranscript('🎙 सुन रहा हूँ… / Listening…');
    };

    _recognition.onresult = e => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript;
        if (e.results[i].isFinal) final   += text;
        else                       interim += text;
      }
      if (interim) _setTranscript(interim, 'interim');
      if (final) {
        _finalTranscript += ' ' + final;
        _setTranscript(_finalTranscript.trim(), 'final');
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
      const transcript = _finalTranscript.trim();
      _finalTranscript = '';
      if (transcript) _processTranscript(transcript);
    };

    return true;
  }

  // ─── Main processing ─────────────────────────────────────────────

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

  // ═══════════════════════════════════════════════════════════════════
  //  PRESS & HOLD BUTTON
  // ═══════════════════════════════════════════════════════════════════

  function _onHoldStart(e) {
    e.preventDefault(); // prevent touch firing mouse events too

    if (!_recognition && !_initRecognition()) return;
    _isHolding       = true;
    _finalTranscript = '';

    // Only start if still held after MIN_HOLD_MS (filters accidental taps)
    _holdTimer = setTimeout(() => {
      if (!_isHolding) return;
      _recognition.lang = Storage.getSettings().voiceLang || 'hi-IN';
      try { _recognition.start(); }
      catch (err) { console.warn('[Voice] Start error:', err); }
    }, MIN_HOLD_MS);
  }

  function _onHoldEnd(e) {
    e.preventDefault();
    _isHolding = false;
    clearTimeout(_holdTimer);

    if (_isListening) {
      // Stop recognition — onend fires and processes transcript
      try { _recognition.stop(); }
      catch (err) { console.warn('[Voice] Stop error:', err); }
    } else {
      // Released before recognition started (quick tap)
      _updateVoiceBtnState(false);
    }
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

    // Touch (mobile) — primary interaction
    btn.addEventListener('touchstart',  _onHoldStart, { passive: false });
    btn.addEventListener('touchend',    _onHoldEnd,   { passive: false });
    btn.addEventListener('touchcancel', _onHoldEnd,   { passive: false });

    // Mouse (desktop/testing)
    btn.addEventListener('mousedown', _onHoldStart);
    btn.addEventListener('mouseup',   _onHoldEnd);
    btn.addEventListener('mouseleave', e => { if (_isHolding) _onHoldEnd(e); });

    // Set initial label
    _updateVoiceBtnState(false);
  }

  // ─── Public API ──────────────────────────────────────────────────
  return {
    init,
    parseProductList, // for testing
    detectIntent,     // for testing
  };

})();
