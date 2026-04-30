'use strict';

/**
 * products.js
 * Product master list — add, edit, delete, search, render.
 * Depends on: storage.js
 */

const Products = (() => {

  // ─── State ───────────────────────────────────────────────────────
  let _searchQuery = '';

  // ─── DOM Refs ────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  // ─── Render ──────────────────────────────────────────────────────

  function renderProductList() {
    const tbody   = $('product-table-body');
    const empty   = $('product-empty');
    const wrapper = $('product-list-wrapper');
    if (!tbody) return;

    let products = Storage.getAllProducts();

    // Filter by search
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
            <button class="tbl-btn del-btn" data-id="${p.id}" aria-label="Delete ${_esc(p.name)}">🗑</button>
          </td>
        `;
        tbody.appendChild(tr);
      });

      // Edit buttons
      tbody.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => openEditForm(btn.dataset.id));
      });

      // Delete buttons
      tbody.querySelectorAll('.del-btn').forEach(btn => {
        btn.addEventListener('click', () => confirmDelete(btn.dataset.id));
      });
    }
  }

  // ─── Form Open / Close ───────────────────────────────────────────

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

    $('product-form-title').textContent = 'Edit Product';
    $('product-edit-id').value      = p.id;
    $('product-name-input').value   = p.name;
    $('product-aliases-input').value= p.aliases.join(', ');
    $('product-sell-price').value   = p.sellPrice;
    $('product-cost-price').value   = p.costPrice || '';
    $('product-unit').value         = p.unit;
    $('product-stock').value        = p.stock;

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
      $(`${id}`) && ($(`${id}`).value = '');
    });
    $('product-unit') && ($('product-unit').value = 'pcs');
  }

  // ─── Save ────────────────────────────────────────────────────────

  function saveProduct() {
    const name      = $('product-name-input').value.trim();
    const sellPrice = parseFloat($('product-sell-price').value);

    if (!name) {
      _toast('Product name is required', 'error'); return;
    }
    if (isNaN(sellPrice) || sellPrice < 0) {
      _toast('Enter a valid sell price', 'error'); return;
    }

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
    // Refresh khata customer dropdown if open
    if (typeof Khata !== 'undefined') Khata.refreshCustomerSelect();
  }

  // ─── Delete ──────────────────────────────────────────────────────

  function confirmDelete(id) {
    const p = Storage.getProductById(id);
    if (!p) return;
    if (confirm(`Delete "${p.name}"? This cannot be undone.`)) {
      Storage.deleteProduct(id);
      _toast(`"${p.name}" deleted`);
      renderProductList();
    }
  }

  // ─── Search (exposed for voice.js fuzzy matching) ────────────────

  /**
   * Find best matching product for a query string.
   * Returns { product, score, exact } or null if no reasonable match.
   */
  function findBestMatch(query) {
    const products = Storage.getAllProducts();
    if (!products.length || !query) return null;

    const q = query.toLowerCase().trim();
    let bestMatch = null;
    let bestScore = Infinity;

    products.forEach(product => {
      // Check name + all aliases
      const candidates = [
        product.name.toLowerCase(),
        ...(product.aliases || []).map(a => a.toLowerCase()),
      ];

      candidates.forEach(candidate => {
        const dist = _levenshtein(q, candidate);
        // Normalise score: shorter strings should still match
        const normalised = dist / Math.max(q.length, candidate.length);
        if (normalised < bestScore) {
          bestScore = normalised;
          bestMatch = { product, score: normalised, exact: dist === 0 };
        }
      });
    });

    // Accept if score < 0.45 (tunable)
    return bestMatch && bestScore < 0.45 ? bestMatch : null;
  }

  /** Levenshtein distance between two strings */
  function _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
    return dp[m][n];
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
    // Add product button
    $('add-product-btn')?.addEventListener('click', openAddForm);

    // Form save/cancel
    $('product-form-save')?.addEventListener('click', saveProduct);
    $('product-form-cancel')?.addEventListener('click', closeForm);

    // Search input
    $('product-search-input')?.addEventListener('input', e => {
      _searchQuery = e.target.value;
      renderProductList();
    });

    renderProductList();
  }

  // ─── Public API ──────────────────────────────────────────────────
  return {
    init,
    renderProductList,
    findBestMatch,
    openAddForm,
    openEditForm,
    closeForm,
  };

})();
