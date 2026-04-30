'use strict';

/**
 * voice.js
 * Voice input — Web Speech API + product parser (Hindi/English Hinglish).
 * Depends on: storage.js, products.js, billing.js
 */

const Voice = (() => {

  const $ = id => document.getElementById(id);

  // ─── State ───────────────────────────────────────────────────────
  let _recognition   = null;
  let _isListening   = false;
  let _finalTranscript = '';

  // Number word map (Hindi + English)
  const NUMBER_WORDS = {
    // Hindi
    'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'paanch': 5,
    'chhe': 6, 'saat': 7, 'aath': 8, 'nau': 9, 'das': 10,
    'gyarah': 11, 'barah': 12, 'tera': 13, 'chaudah': 14, 'pandrah': 15,
    'solah': 16, 'satrah': 17, 'atharah': 18, 'unnis': 19, 'bees': 20,
    // English
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'dozen': 12,
    // Common spoken shortcuts
    'ik': 1, 'doh': 2, 'tin': 3, 'pach': 5,
  };

  // Words to strip from transcript (filler words)
  const STOP_WORDS = new Set([
    'aur', 'and', 'tatha', 'ke', 'ka', 'ki', 'mujhe', 'de', 'dena',
    'please', 'lao', 'chahiye', 'add', 'karo', 'lagao',
  ]);

  // ─── Speech Recognition Setup ────────────────────────────────────

  function _initRecognition() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn('[Voice] Web Speech API not supported');
      _disableVoiceBtn();
      return false;
    }

    _recognition = new SpeechRecognition();
    const lang = Storage.getSettings().voiceLang || 'hi-IN';
    _recognition.lang             = lang;
    _recognition.interimResults   = true;
    _recognition.maxAlternatives  = 3;
    _recognition.continuous       = false; // single utterance mode

    _recognition.onstart = () => {
      _isListening = true;
      _updateVoiceBtnState(true);
      _setTranscript('🎙 सुन रहा हूँ… / Listening…');
    };

    _recognition.onresult = e => {
      let interim = '';
      let final   = '';

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          final += text;
        } else {
          interim += text;
        }
      }

      if (interim) _setTranscript(interim, 'interim');
      if (final)   { _finalTranscript = final; _setTranscript(final, 'final'); }
    };

    _recognition.onerror = e => {
      console.warn('[Voice] Error:', e.error);
      const messages = {
        'no-speech'       : 'No speech detected — try again',
        'audio-capture'   : 'Microphone not available',
        'not-allowed'     : 'Mic permission denied — please allow in browser settings',
        'network'         : 'Network error — voice needs internet first time',
      };
      _setTranscript(messages[e.error] || `Error: ${e.error}`);
      _stopListening();
    };

    _recognition.onend = () => {
      _stopListening();
      if (_finalTranscript.trim()) {
        _parseAndAddProducts(_finalTranscript.trim());
        _finalTranscript = '';
      }
    };

    return true;
  }

  function _disableVoiceBtn() {
    const btn = $('voice-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.title = 'Voice not supported in this browser';
    $('voice-label').textContent = 'Voice not supported';
    _setTranscript('Voice input is not supported in this browser. Use manual add instead.');
  }

  // ─── Listening Controls ──────────────────────────────────────────

  function startListening() {
    if (!_recognition && !_initRecognition()) return;
    if (_isListening) { stopListening(); return; }

    // Update language from settings (user may have changed it)
    _recognition.lang = Storage.getSettings().voiceLang || 'hi-IN';

    _finalTranscript = '';
    try {
      _recognition.start();
    } catch (e) {
      console.error('[Voice] Start failed:', e);
    }
  }

  function stopListening() {
    if (_recognition && _isListening) {
      _recognition.stop();
    }
    _stopListening();
  }

  function _stopListening() {
    _isListening = false;
    _updateVoiceBtnState(false);
  }

  function _updateVoiceBtnState(listening) {
    const btn   = $('voice-btn');
    const label = $('voice-label');
    if (!btn) return;

    if (listening) {
      btn.classList.add('listening');
      btn.setAttribute('aria-label', 'Stop voice input');
      label.textContent = 'Listening…';
    } else {
      btn.classList.remove('listening');
      btn.setAttribute('aria-label', 'Start voice input');
      label.textContent = 'Tap to Speak';
    }
  }

  function _setTranscript(text, state = 'idle') {
    const el = $('voice-transcript');
    if (!el) return;
    el.textContent = text;
    el.className = `voice-transcript ${state}`;
  }

  // ─── Parser ──────────────────────────────────────────────────────

  /**
   * Parse a voice transcript like:
   *   "parle g do maggi ek tata salt teen"
   *   "2 maggi, 1 parle g, surf excel do"
   * Returns [{name, qty}]
   */
  function parseTranscript(transcript) {
    const cleaned = transcript.toLowerCase()
      .replace(/[,،;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const tokens = cleaned.split(' ');
    const results = [];
    let i = 0;

    while (i < tokens.length) {
      const token = tokens[i];

      // Skip stop words
      if (STOP_WORDS.has(token)) { i++; continue; }

      // Is this token a number/number-word?
      const numVal = _parseNumber(token);

      if (numVal !== null) {
        // Number FIRST style: "2 maggi" or "ek parle g"
        const nameTokens = [];
        i++;
        while (i < tokens.length && _parseNumber(tokens[i]) === null && !STOP_WORDS.has(tokens[i])) {
          nameTokens.push(tokens[i]);
          i++;
          // If next token is also a number we've collected enough
          if (nameTokens.length >= 4) break;
        }
        if (nameTokens.length > 0) {
          results.push({ rawName: nameTokens.join(' '), qty: numVal });
        }
      } else {
        // Product name FIRST: collect name tokens until we hit a number
        const nameTokens = [token];
        i++;
        while (i < tokens.length && _parseNumber(tokens[i]) === null && !STOP_WORDS.has(tokens[i])) {
          nameTokens.push(tokens[i]);
          i++;
          if (nameTokens.length >= 5) break;
        }
        // Check if next is a number
        let qty = 1;
        if (i < tokens.length) {
          const n = _parseNumber(tokens[i]);
          if (n !== null) { qty = n; i++; }
        }
        results.push({ rawName: nameTokens.join(' '), qty });
      }
    }

    return results;
  }

  function _parseNumber(token) {
    // Digit string
    if (/^\d+$/.test(token)) return parseInt(token);
    // Word map
    if (NUMBER_WORDS[token] !== undefined) return NUMBER_WORDS[token];
    return null;
  }

  // ─── Match & Add ─────────────────────────────────────────────────

  let _pendingMatches = [];
  let _confirmIndex   = 0;

  function _parseAndAddProducts(transcript) {
    _setTranscript(`Parsed: "${transcript}"`);

    const parsed = parseTranscript(transcript);
    if (parsed.length === 0) {
      _toast('Could not parse products — try again', 'error');
      return;
    }

    // Match each parsed item against product list
    const toProcess = parsed.map(item => {
      const match = Products.findBestMatch(item.rawName);
      return { ...item, match };
    });

    // Separate confident matches from uncertain ones
    const confident  = toProcess.filter(i => i.match && i.match.score < 0.25);
    const uncertain  = toProcess.filter(i => !i.match || i.match.score >= 0.25);

    // Add confident ones immediately
    confident.forEach(item => {
      Billing.addToCart(item.match.product.id, item.qty);
    });

    if (confident.length > 0) {
      _toast(`${confident.length} item${confident.length > 1 ? 's' : ''} added ✓`);
    }

    // Queue uncertain ones for confirm dialog
    if (uncertain.length > 0) {
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
    const dialogBody = $('confirm-dialog-body');
    const dialog     = $('confirm-dialog');

    if (!dialog) return;

    if (item.match) {
      dialogBody.innerHTML = `
        <p>You said: <strong>"${_esc(item.rawName)}"</strong> × ${item.qty}</p>
        <p>Did you mean: <strong>${_esc(item.match.product.name)}</strong>?</p>
        <p class="match-score">Match confidence: ${Math.round((1 - item.match.score) * 100)}%</p>
      `;
    } else {
      dialogBody.innerHTML = `
        <p>You said: <strong>"${_esc(item.rawName)}"</strong> × ${item.qty}</p>
        <p>⚠️ No product found in your list.</p>
        <p>Press "Yes" to add as a custom item, or "No" to skip.</p>
      `;
    }

    dialog.classList.remove('hidden');

    // Set up confirm/deny
    const yesBtn = $('confirm-dialog-yes');
    const noBtn  = $('confirm-dialog-no');

    // Clone to remove old listeners
    const newYes = yesBtn.cloneNode(true);
    const newNo  = noBtn.cloneNode(true);
    yesBtn.parentNode.replaceChild(newYes, yesBtn);
    noBtn.parentNode.replaceChild(newNo, noBtn);

    newYes.addEventListener('click', () => {
      dialog.classList.add('hidden');
      if (item.match) {
        Billing.addToCart(item.match.product.id, item.qty);
      } else {
        // Add as unnamed item
        Billing.addToCart(null, item.qty, item.rawName, 0);
      }
      _confirmIndex++;
      _processNextConfirm();
    });

    newNo.addEventListener('click', () => {
      dialog.classList.add('hidden');
      _confirmIndex++;
      _processNextConfirm();
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  function _esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function _toast(msg, type = 'success') {
    if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type);
    else console.log(`[Toast] ${msg}`);
  }

  // ─── Init ────────────────────────────────────────────────────────

  function init() {
    const voiceBtn = $('voice-btn');
    if (!voiceBtn) return;

    // Check browser support first
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      _disableVoiceBtn();
      return;
    }

    voiceBtn.addEventListener('click', startListening);

    // Init recognition lazily on first click (avoids permissions prompt on load)
    // Already handled inside startListening
  }

  // ─── Public API ──────────────────────────────────────────────────
  return {
    init,
    startListening,
    stopListening,
    parseTranscript,   // exposed for testing
  };

})();
