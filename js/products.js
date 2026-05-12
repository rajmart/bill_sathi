'use strict';

/**
 * products.js — Bill Sathi
 * Added: company field, group/filter by company
 */

const Products = (() => {

  let _searchQuery   = '';
  let _filterCompany = '';
  const $ = id => document.getElementById(id);

  // ═══════════════════════════════════════════════════════════════════
  //  FUZZY MATCHER (unchanged — works well)
  // ═══════════════════════════════════════════════════════════════════

  function _normalise(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function _tokenise(str) { return str.split(' ').filter(t => t.length > 0); }

  function _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  }

  function _scoreMatch(query, candidate) {
    if (!query || !candidate) return 1.0;
    const q = _normalise(query), c = _normalise(candidate);
    if (q === c)        return 0.0;
    if (c.includes(q)) return 0.04;
    if (q.includes(c)) return 0.06;
    const qToks = _tokenise(q), cToks = _tokenise(c);
    if (!qToks.length) return 1.0;
    let totalScore = 0;
    for (const qt of qToks) {
      let best = 1.0;
      for (const ct of cToks) {
        if (qt === ct) { best = 0.0; break; }
        if (ct.startsWith(qt) && qt.length >= 2) { best = Math.min(best, 0.08); continue; }
        if (qt.startsWith(ct) && ct.length >= 2) { best = Math.min(best, 0.10); continue; }
        if (qt.length === 1 || ct.length === 1) continue;
        const lev = _levenshtein(qt, ct);
        if (lev <= 2) best = Math.min(best, (lev / Math.max(qt.length, ct.length)) * 0.7);
      }
      totalScore += best;
    }
    const avg = totalScore / qToks.length;
    const extraPenalty = Math.max(0, cToks.length - qToks.length) * 0.04;
    return Math.min(1.0, avg + extraPenalty);
  }

  function findBestMatch(query) {
    const products = Storage.getAllProducts();
    if (!products.length || !query) return null;
    let best = null, bestScore = 1.0;
    for (const product of products) {
      for (const candidate of [product.name, ...(product.aliases || [])]) {
        const score = _scoreMatch(query, candidate);
        if (score < bestScore) { bestScore = score; best = { product, score, exact: score === 0 }; }
      }
    }
    console.log(`[Match] "${query}" → "${best?.product?.name}" score=${bestScore.toFixed(3)} ${bestScore < 0.45 ? '✓' : '✗'}`);
    return best && bestScore < 0.45 ? best : null;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  RENDER — grouped by company with filter tabs
  // ═══════════════════════════════════════════════════════════════════

  function _renderCompanyTabs() {
    const companies = Storage.getAllCompanies();
    const wrap = $('company-filter-tabs');
    if (!wrap) return;

    wrap.innerHTML = '';

    // "All" tab
    const allBtn = document.createElement('button');
    allBtn.className = `company-tab-btn${_filterCompany === '' ? ' active' : ''}`;
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => { _filterCompany = ''; _renderCompanyTabs(); renderProductList(); });
    wrap.appendChild(allBtn);

    // One tab per company
    companies.forEach(co => {
      const btn = document.createElement('button');
      btn.className = `company-tab-btn${_filterCompany === co ? ' active' : ''}`;
      btn.textContent = co;
      btn.addEventListener('click', () => { _filterCompany = co; _renderCompanyTabs(); renderProductList(); });
      wrap.appendChild(btn);
    });
  }

  function renderProductList() {
    const tbody   = $('product-table-body');
    const empty   = $('product-empty');
    const table   = $('product-table');
    if (!tbody) return;

    let products = Storage.getAllProducts();

    // Filter by company
    if (_filterCompany) {
      products = products.filter(p => (p.company || '').trim() === _filterCompany);
    }

    // Filter by search
    if (_searchQuery) {
      const q = _searchQuery.toLowerCase();
      products = products.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.company || '').toLowerCase().includes(q) ||
        (p.aliases || []).some(a => a.toLowerCase().includes(q))
      );
    }

    tbody.innerHTML = '';

    if (products.length === 0) {
      empty.style.display  = 'block';
      table.style.display  = 'none';
    } else {
      empty.style.display  = 'none';
      table.style.display  = '';

      // Group by company
      const groups = {};
      products.forEach(p => {
        const co = (p.company || '').trim() || '—';
        if (!groups[co]) groups[co] = [];
        groups[co].push(p);
      });

      Object.entries(groups).forEach(([company, items]) => {
        // Company header row
        const headerRow = document.createElement('tr');
        headerRow.className = 'company-group-header';
        headerRow.innerHTML = `<td colspan="6">🏷 ${_esc(company)}</td>`;
        tbody.appendChild(headerRow);

        items.forEach(p => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>
              <strong>${_esc(p.name)}</strong>
              ${p.aliases && p.aliases.length ? `<br><small class="alias-list">${_esc(p.aliases.join(', '))}</small>` : ''}
            </td>
            <td>₹${p.sellPrice.toFixed(2)}</td>
            <td>${p.costPrice > 0 ? '₹' + p.costPrice.toFixed(2) : '—'}</td>
            <td>${_esc(p.unit)}</td>
            <td>${p.stock > 0 ? p.stock : '<span class="low-stock">0</span>'}</td>
            <td class="action-cell">
              <button class="tbl-btn edit-btn" data-id="${p.id}" aria-label="Edit">✏️</button>
              <button class="tbl-btn del-btn"  data-id="${p.id}" aria-label="Delete">🗑</button>
            </td>
          `;
          tbody.appendChild(tr);
        });
      });

      tbody.querySelectorAll('.edit-btn').forEach(btn =>
        btn.addEventListener('click', () => openEditForm(btn.dataset.id))
      );
      tbody.querySelectorAll('.del-btn').forEach(btn =>
        btn.addEventListener('click', () => confirmDelete(btn.dataset.id))
      );
    }

    _renderCompanyTabs();
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
    $('product-company-input').value     = p.company || '';
    $('product-aliases-input').value     = (p.aliases || []).join(', ');
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
    ['product-edit-id','product-name-input','product-company-input',
     'product-aliases-input','product-sell-price','product-cost-price',
     'product-stock'].forEach(id => { const el = $(id); if (el) el.value = ''; });
    const unit = $('product-unit');
    if (unit) unit.value = 'pcs';
  }

  function saveProduct() {
    const name      = $('product-name-input').value.trim();
    const sellPrice = parseFloat($('product-sell-price').value);
    if (!name)                          { _toast('Product name is required', 'error'); return; }
    if (isNaN(sellPrice) || sellPrice < 0) { _toast('Enter a valid sell price', 'error'); return; }

    const aliasRaw = $('product-aliases-input').value.trim();
    const aliases  = aliasRaw ? aliasRaw.split(',').map(a => a.trim().toLowerCase()).filter(Boolean) : [];

    const data = {
      name,
      company   : $('product-company-input').value.trim(),
      aliases,
      sellPrice,
      costPrice : parseFloat($('product-cost-price').value) || 0,
      unit      : $('product-unit').value,
      stock     : parseInt($('product-stock').value) || 0,
    };

    const editId = $('product-edit-id').value;
    if (editId) { Storage.updateProduct(editId, data); _toast(`"${name}" updated ✓`); }
    else        { Storage.addProduct(data);             _toast(`"${name}" added ✓`); }

    closeForm();
    renderProductList();
    if (typeof Khata !== 'undefined') Khata.refreshCustomerSelect();
  }

  function confirmDelete(id) {
    const p = Storage.getProductById(id);
    if (!p) return;
    if (confirm(`Delete "${p.name}"?`)) {
      Storage.deleteProduct(id);
      _toast(`"${p.name}" deleted`);
      renderProductList();
    }
  }

  function _esc(str) {
    const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML;
  }

  function _toast(msg, type = 'success') {
    if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type);
    else console.log(`[Toast] ${msg}`);
  }

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

  return { init, renderProductList, findBestMatch, openAddForm, openEditForm, closeForm };
})();
