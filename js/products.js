'use strict';

/**
 * products.js — Bill Sathi v1.4
 * Product master list — add, edit, delete, search, render.
 * Depends on: storage.js
 *
 * v1.4: findBestMatch() upgraded to token-level scoring
 *       (same engine as voice.js) — used by manual add & voice.
 */

const Products = (() => {

  let _searchQuery = '';
  const $ = id => document.getElementById(id);

  // ═══════════════════════════════════════════════════════════════════
  //  TOKEN-LEVEL FUZZY MATCHER
  //  Shared by voice input AND manual add.
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Normalise a string for matching:
   * lowercase, remove punctuation/hyphens, collapse whitespace.
   */
  function _normalise(str) {
    return (str || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Split normalised string into word tokens */
  function _tokenise(str) {
    return str.split(' ').filter(t => t.length > 0);
  }

  /** Classic Levenshtein distance between two strings */
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

  /**
   * Score how well a spoken/typed query matches a product name or alias.
   * Returns 0.0 (perfect) → 1.0 (no match). Accept if < 0.45.
   *
   * Strategy — token by token:
   *  "t special"   → ["t","special"] vs ["tea","special"]
   *    "special" exact  = 0.0
   *    "t" prefix "tea" = 0.08
   *    avg ≈ 0.04  → ✓ confident match
   *
   *  "amul gol"    → ["amul","gol"] vs ["amul","gold"]
   *    "amul" exact = 0.0
   *    "gol" prefix "gold" = 0.08
   *    avg ≈ 0.04  → ✓ confident match
   *
   *  "parleg"      → ["parleg"] vs ["parle","g"]
   *    whole-string contains check → 0.06  → ✓
   */
  function _scoreMatch(query, candidate) {
    if (!query || !candidate) return 1.0;

    const q = _normalise(query);
    const c = _normalise(candidate);

    if (q === c)         return 0.0;
    if (c.includes(q))  return 0.04;
    if (q.includes(c))  return 0.06;

    const qToks = _tokenise(q);
    const cToks = _tokenise(c);
    if (!qToks.length)  return 1.0;

    let totalScore = 0;

    for (const qt of qToks) {
      let best = 1.0;

      for (const ct of cToks) {
        if (qt === ct) { best = 0.0; break; }

        // Prefix match (min 2 chars to avoid single-letter noise)
        if (ct.startsWith(qt) && qt.length >= 2) { best = Math.min(best, 0.08); continue; }
        if (qt.startsWith(ct) && ct.length >= 2) { best = Math.min(best, 0.10); continue; }

        // Single-char tokens (e.g. "g" in "Parle G") — exact only
        if (qt.length === 1 || ct.length === 1) continue;

        // Per-token Levenshtein (max 2 edits)
        const lev = _levenshtein(qt, ct);
        if (lev <= 2) {
          best = Math.min(best, (lev / Math.max(qt.length, ct.length)) * 0.7);
        }
      }

      totalScore += best;
    }

    const avg          = totalScore / qToks.length;
    const extraPenalty = Math.max(0, cToks.length - qToks.length) * 0.04;
    return Math.min(1.0, avg + extraPenalty);
  }

  /**
   * Find best matching product for a query string.
   * Checks product name + all aliases.
   * Returns { product, score, exact } or null.
   *
   * This is the SINGLE matcher used by both voice.js and billing.js manual add.
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
          best = { product, score, exact: score === 0 };
        }
      }
    }

    // Log for debugging (open browser console to see this)
    console.log(
      `[Match] "${query}" → "${best?.product?.name}" score=${bestScore.toFixed(3)} ${bestScore < 0.45 ? '✓' : '✗ rejected'}`
    );

    return best && bestScore < 0.45 ? best : null;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════

  function renderProductList() {
    const tbody   = $('product-table-body');
    const empty   = $('product-empty');
    const wrapper = $('product-list-wrapper');
    if (!tbody) return;

    let products = Storage.getAllProducts();

    if (_searchQuery) {
      const q = _searchQuery.toLowerCase();
      products = products.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.aliases || []).some(a => a.toLowerCase().includes(q))
      );
    }

    tbody.innerHTML = '';

    if (products.length === 0) {
      empty.style.display = 'block';
      wrapper.querySelector('#product-table').style.display = 'none';
    } else {
      empty.style.display = 'none';
      wrapper.querySelector('#product-table').style.display = '';

      products.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>
            <strong>${_esc(p.name)}</strong>
            ${p.aliases && p.aliases.length
              ? `<br><small class="alias-list">${_esc(p.aliases.join(', '))}</small>`
              : ''}
          </td>
          <td>₹${p.sellPrice.toFixed(2)}</td>
          <td>${p.costPrice > 0 ? '₹' + p.costPrice.toFixed(2) : '—'}</td>
          <td>${_esc(p.unit)}</td>
          <td>${p.stock > 0 ? p.stock : '<span class="low-stock">0</span>'}</td>
          <td class="action-cell">
            <button class="tbl-btn edit-btn" data-id="${p.id}" aria-label="Edit ${_esc(p.name)}">✏️</button>
            <button class="tbl-btn del-btn"  data-id="${p.id}" aria-label="Delete ${_esc(p.name)}">🗑</button>
          </td>
        `;
        tbody.appendChild(tr);
      });

      tbody.querySelectorAll('.edit-btn').forEach(btn =>
        btn.addEventListener('click', () => openEditForm(btn.dataset.id))
      );
      tbody.querySelectorAll('.del-btn').forEach(btn =>
        btn.addEventListener('click', () => confirmDelete(btn.dataset.id))
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  FORM — ADD / EDIT
  // ═══════════════════════════════════════════════════════════════════

  function openAddForm() {
    _clearForm();
    $('product-form-title').textContent = 'Add Product';
    $('product-edit-id').value = '';
    $('product-form-wrap').classList.remove('hidden');
    $('product-name-input').focus();
  }

  function openEditForm(id) {
    const p = Storage.getProductById(id);
    if (!p) return;

    $('product-form-title').textContent  = 'Edit Product';
    $('product-edit-id').value           = p.id;
    $('product-name-input').value        = p.name;
    $('product-aliases-input').value     = p.aliases.join(', ');
    $('product-sell-price').value        = p.sellPrice;
    $('product-cost-price').value        = p.costPrice || '';
    $('product-unit').value              = p.unit;
    $('product-stock').value             = p.stock;

    $('product-form-wrap').classList.remove('hidden');
    $('product-name-input').focus();
  }

  function closeForm() {
    $('product-form-wrap').classList.add('hidden');
    _clearForm();
  }

  function _clearForm() {
    ['product-edit-id','product-name-input','product-aliases-input',
     'product-sell-price','product-cost-price','product-stock'].forEach(id => {
      const el = $(id);
      if (el) el.value = '';
    });
    const unit = $('product-unit');
    if (unit) unit.value = 'pcs';
  }

  function saveProduct() {
    const name      = $('product-name-input').value.trim();
    const sellPrice = parseFloat($('product-sell-price').value);

    if (!name) { _toast('Product name is required', 'error'); return; }
    if (isNaN(sellPrice) || sellPrice < 0) { _toast('Enter a valid sell price', 'error'); return; }

    const aliasRaw = $('product-aliases-input').value.trim();
    const aliases  = aliasRaw
      ? aliasRaw.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)
      : [];

    const data = {
      name,
      aliases,
      sellPrice,
      costPrice : parseFloat($('product-cost-price').value) || 0,
      unit      : $('product-unit').value,
      stock     : parseInt($('product-stock').value) || 0,
    };

    const editId = $('product-edit-id').value;

    if (editId) {
      Storage.updateProduct(editId, data);
      _toast(`"${name}" updated ✓`);
    } else {
      Storage.addProduct(data);
      _toast(`"${name}" added ✓`);
    }

    closeForm();
    renderProductList();
    if (typeof Khata !== 'undefined') Khata.refreshCustomerSelect();
  }

  function confirmDelete(id) {
    const p = Storage.getProductById(id);
    if (!p) return;
    if (confirm(`Delete "${p.name}"? This cannot be undone.`)) {
      Storage.deleteProduct(id);
      _toast(`"${p.name}" deleted`);
      renderProductList();
    }
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
    $('add-product-btn')?.addEventListener('click', openAddForm);
    $('product-form-save')?.addEventListener('click', saveProduct);
    $('product-form-cancel')?.addEventListener('click', closeForm);
    $('product-search-input')?.addEventListener('input', e => {
      _searchQuery = e.target.value;
      renderProductList();
    });
    renderProductList();
  }

  return {
    init,
    renderProductList,
    findBestMatch,      // ← upgraded, shared with voice.js & billing.js
    openAddForm,
    openEditForm,
    closeForm,
  };

})();
