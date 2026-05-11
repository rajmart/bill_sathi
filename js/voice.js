'use strict';

/**
 * voice.js — Bill Sathi
 *
 * VOICE FORMAT: "[product name] [qty] aur [product name] [qty]"
 * Example: "gold one aur taaza two aur parle g three"
 *
 * Rules:
 *  - Items split on "aur" or "and"
 *  - Quantity is ALWAYS the last word of each chunk
 *  - Product name is everything before the last word
 *  - English number words only: one, two, three... + plain digits
 *
 * Mic: PRESS AND HOLD to listen, release to process.
 * Depends on: storage.js, products.js, billing.js, app.js
 */

const Voice = (() => {

  const $ = id => document.getElementById(id);

  // ─── State ───────────────────────────────────────────────────────
  let _recognition = null;
  let _isListening = false;
  let _isHolding   = false;
  let _holdTimer   = null;
  let _transcript  = '';

  const MIN_HOLD_MS = 120;

  // ─── Number Word Map (English only) ──────────────────────────────
  const NUMBER_WORDS = {
    'one':1,   'two':2,   'three':3,  'four':4,   'five':5,
    'six':6,   'seven':7, 'eight':8,  'nine':9,   'ten':10,
    'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,
    'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,
    'thirty':30,'forty':40,'fifty':50,'sixty':60,'seventy':70,
    'eighty':80,'ninety':90,'hundred':100,'dozen':12,
  };

  function _parseNumber(token) {
    if (!token) return null;
    if (/^\d+$/.test(token)) return parseInt(token, 10);
    return NUMBER_WORDS[token.toLowerCase()] ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CORE PARSER
  //
  //  Input : "gold one aur taaza two aur parle g three"
  //  Output: [ {rawName:"gold", qty:1},
  //            {rawName:"taaza", qty:2},
  //            {rawName:"parle g", qty:3} ]
  // ═══════════════════════════════════════════════════════════════════

  function parseTranscript(transcript) {
    const lower = transcript.toLowerCase().trim();

    // Split on "aur" or "and" as whole words
    const chunks = lower
      .split(/\b(aur|and)\b/)
      .map(s => s.trim())
      .filter(s => s && s !== 'aur' && s !== 'and');

    const results = [];

    for (const chunk of chunks) {
      const tokens = chunk.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;

      const lastToken = tokens[tokens.length - 1];
      const qty       = _parseNumber(lastToken);

      if (qty !== null && tokens.length > 1) {
        // "gold one" → name=gold qty=1
        const rawName = tokens.slice(0, -1).join(' ').trim();
        if (rawName) results.push({ rawName, qty });
      } else {
        // No number found at end — whole chunk is the name, qty defaults to 1
        // Forgiving: user may have forgotten to say quantity
        const rawName = tokens.join(' ').trim();
        if (rawName) results.push({ rawName, qty: 1 });
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  PRODUCT MATCHING + CART
  // ═══════════════════════════════════════════════════════════════════

  function _matchAndAdd(parsed) {
    if (!parsed.length) {
      _toast('Nothing understood — say product name then quantity', 'error');
      return;
    }

    const confident = [];
    const uncertain = [];

    parsed.forEach(item => {
      const match = Products.findBestMatch(item.rawName);
      if (match) confident.push({ ...item, match });
      else        uncertain.push(item);
    });

    // Add confident matches straight to cart
    confident.forEach(item => Billing.addToCart(item.match.product.id, item.qty));
    if (confident.length) {
      const names = confident.map(i => `${i.match.product.name} ×${i.qty}`).join(', ');
      _toast(`✓ ${names}`);
    }

    // Ask user about unmatched items
    if (uncertain.length) _confirmUnknown(uncertain, 0);
  }

  function _confirmUnknown(items, index) {
    if (index >= items.length) return;
    const item = items[index];

    _showConfirmDialog(
      'Product Not Found',
      `<p>Heard: <strong>"${_esc(item.rawName)}"</strong> × ${item.qty}</p>
       <p>Not in your product list. Add as custom item?</p>`,
      'Yes, Add',
      () => {
        const priceStr = prompt(`Price for "${item.rawName}" (₹)?`);
        const price    = parseFloat(priceStr) || 0;
        Billing.addToCart(null, item.qty, item.rawName, price);
        _confirmUnknown(items, index + 1);
      },
      () => _confirmUnknown(items, index + 1)
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  //  PROCESS TRANSCRIPT
  // ═══════════════════════════════════════════════════════════════════

  function _processTranscript(raw) {
    console.log('[Voice] Raw:', raw);
    _setTranscript(`Heard: "${raw}"`, 'final');

    const parsed = parseTranscript(raw);
    console.log('[Voice] Parsed:', parsed);

    if (!parsed.length) {
      _toast('Could not understand — say product then quantity', 'error');
      return;
    }

    _matchAndAdd(parsed);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SPEECH RECOGNITION
  // ═══════════════════════════════════════════════════════════════════

  function _initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { _disableVoiceBtn(); return false; }

    _recognition = new SpeechRecognition();
    _recognition.lang            = 'en-IN'; // Indian English — best for your accent
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
      if (finalText) {
        _transcript = finalText.trim();
        _setTranscript(_transcript, 'final');
      }
    };

    _recognition.onerror = e => {
      const msgs = {
        'no-speech'    : 'No speech — try again',
        'audio-capture': 'Microphone not available',
        'not-allowed'  : 'Mic permission denied',
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

  // ─── Press & Hold ────────────────────────────────────────────────

  function _onHoldStart(e) {
    e.preventDefault();
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

  function _onHoldEnd(e) {
    e.preventDefault();
    _isHolding = false;
    clearTimeout(_holdTimer);
    if (_isListening) {
      try { _recognition.stop(); }
      catch (err) { console.warn('[Voice] Stop error:', err); }
    } else {
      _updateVoiceBtnState(false);
    }
  }

  // ─── Confirm Dialog ───────────────────────────────────────────────

  function _showConfirmDialog(title, bodyHtml, confirmLabel, onConfirm, onCancel) {
    const dialog = $('confirm-dialog');
    if (!dialog) return;

    $('confirm-dialog-title').textContent = title;
    $('confirm-dialog-body').innerHTML    = bodyHtml;
    dialog.classList.remove('hidden');

    const yesBtn = $('confirm-dialog-yes');
    const noBtn  = $('confirm-dialog-no');

    const newYes = yesBtn.cloneNode(true);
    const newNo  = noBtn.cloneNode(true);
    yesBtn.parentNode.replaceChild(newYes, yesBtn);
    noBtn.parentNode.replaceChild(newNo,  noBtn);

    newYes.textContent = confirmLabel;
    newNo.textContent  = 'Skip';

    const _close = () => {
      dialog.classList.add('hidden');
      $('confirm-dialog-yes').textContent = 'Yes, Add';
      $('confirm-dialog-no').textContent  = 'No';
    };

    newYes.addEventListener('click', () => { _close(); onConfirm(); });
    newNo.addEventListener('click',  () => { _close(); if (onCancel) onCancel(); });
  }

  // ─── UI Helpers ──────────────────────────────────────────────────

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

    btn.addEventListener('touchstart',  _onHoldStart, { passive: false });
    btn.addEventListener('touchend',    _onHoldEnd,   { passive: false });
    btn.addEventListener('touchcancel', _onHoldEnd,   { passive: false });

    btn.addEventListener('mousedown',  _onHoldStart);
    btn.addEventListener('mouseup',    _onHoldEnd);
    btn.addEventListener('mouseleave', e => { if (_isHolding) _onHoldEnd(e); });

    _updateVoiceBtnState(false);
  }

  // parseTranscript exposed so you can test in browser console:
  // Voice.parseTranscript("gold one aur taaza two")
  return { init, parseTranscript };

})();