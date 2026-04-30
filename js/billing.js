'use strict';

/**
 * billing.js
 * Cart management — add/remove items, totals, discount, profit.
 * Depends on: storage.js
 */

const Billing = (() => {

  const $ = id => document.getElementById(id);

  // ─── Cart State ──────────────────────────────────────────────────
  let _cart = []; // [{ productId, name, qty, sellPrice, costPrice, unit, lineTotal, lineProfit }]

  // ─── Cart Operations ─────────────────────────────────────────────

  /**
   * Add a product to the cart by productId and quantity.
   * If product already in cart, increments quantity.
   */
  function addToCart(productId, qty = 1, customName = null, customPrice = null) {
    qty = parseInt(qty) || 1;

    // Check if it's a known product
    const product = Storage.getProductById(productId);

    if (product) {
      const existing = _cart.find(item => item.productId === productId);
      if (existing) {
        existing.qty += qty;
        existing.lineTotal  = existing.qty * existing.sellPrice;
        existing.lineProfit = existing.qty * (existing.sellPrice - existing.costPrice);
      } else {
        _cart.push({
          productId  : product.id,
          name       : product.name,
          qty,
          sellPrice  : product.sellPrice,
          costPrice  : product.costPrice || 0,
          unit       : product.unit || 'pcs',
          lineTotal  : qty * product.sellPrice,
          lineProfit : qty * (product.sellPrice - (product.costPrice || 0)),
        });
      }
    } else if (customName) {
      // Unmatched voice item — add with custom name and price
      const price = customPrice || 0;
      _cart.push({
        productId  : null,
        name       : customName,
        qty,
        sellPrice  : price,
        costPrice  : 0,
        unit       : 'pcs',
        lineTotal  : qty * price,
        lineProfit : qty * price, // unknown cost, profit = full price
      });
    }

    renderCart();
  }

  function removeFromCart(index) {
    _cart.splice(index, 1);
    renderCart();
  }

  function updateQty(index, newQty) {
    newQty = parseInt(newQty);
    if (isNaN(newQty) || newQty < 1) {
      removeFromCart(index);
      return;
    }
    const item = _cart[index];
    if (!item) return;
    item.qty        = newQty;
    item.lineTotal  = newQty * item.sellPrice;
    item.lineProfit = newQty * (item.sellPrice - item.costPrice);
    renderCart();
  }

  function clearCart() {
    _cart = [];
    renderCart();
    $('discount-input').value = 0;
    $('khata-toggle').checked = false;
    $('khata-customer-select-wrap')?.classList.add('hidden');
  }

  function getCart() {
    return [..._cart];
  }

  function getDiscount() {
    return parseFloat($('discount-input')?.value) || 0;
  }

  function getSubtotal() {
    return _cart.reduce((sum, item) => sum + item.lineTotal, 0);
  }

  function getTotal() {
    return Math.max(0, getSubtotal() - getDiscount());
  }

  function getTotalProfit() {
    return _cart.reduce((sum, item) => sum + item.lineProfit, 0) - getDiscount();
  }

  function getSelectedKhataCustomer() {
    if (!$('khata-toggle')?.checked) return null;
    const id = $('khata-customer-select')?.value;
    return id || null;
  }

  // ─── Render Cart ─────────────────────────────────────────────────

  function renderCart() {
    const tbody    = $('cart-body');
    const emptyEl  = $('cart-empty');
    const tableEl  = $('cart-table');
    const curr     = Storage.getSettings().currency || '₹';
    if (!tbody) return;

    tbody.innerHTML = '';

    if (_cart.length === 0) {
      emptyEl.style.display = 'block';
      tableEl.style.display = 'none';
    } else {
      emptyEl.style.display = 'none';
      tableEl.style.display = '';

      _cart.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${index + 1}</td>
          <td>
            <span class="item-name">${_esc(item.name)}</span>
            <small class="item-unit">${_esc(item.unit)}</small>
          </td>
          <td>
            <input
              type="number"
              class="qty-input"
              value="${item.qty}"
              min="1"
              data-index="${index}"
              aria-label="Quantity for ${_esc(item.name)}"
            />
          </td>
          <td>${curr}${item.sellPrice.toFixed(2)}</td>
          <td>${curr}${item.lineTotal.toFixed(2)}</td>
          <td>
            <button class="tbl-btn remove-btn" data-index="${index}" aria-label="Remove ${_esc(item.name)}">✕</button>
          </td>
        `;
        tbody.appendChild(tr);
      });

      // Qty change listeners
      tbody.querySelectorAll('.qty-input').forEach(input => {
        input.addEventListener('change', e => {
          updateQty(parseInt(e.target.dataset.index), e.target.value);
        });
      });

      // Remove listeners
      tbody.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          removeFromCart(parseInt(btn.dataset.index));
        });
      });
    }

    _updateSummary(curr);
  }

  function _updateSummary(curr) {
    const subtotal = getSubtotal();
    const discount = getDiscount();
    const total    = getTotal();

    const s = $('summary-subtotal');
    const t = $('summary-total');
    if (s) s.textContent = `${curr}${subtotal.toFixed(2)}`;
    if (t) t.textContent = `${curr}${total.toFixed(2)}`;
  }

  // ─── Init ────────────────────────────────────────────────────────

  function init() {
    // Discount input — update totals live
    $('discount-input')?.addEventListener('input', () => {
      _updateSummary(Storage.getSettings().currency || '₹');
    });

    // Clear cart button
    $('clear-cart-btn')?.addEventListener('click', () => {
      if (_cart.length === 0) return;
      if (confirm('Clear all items from cart?')) clearCart();
    });

    // Generate bill button
    $('generate-bill-btn')?.addEventListener('click', () => {
      if (_cart.length === 0) {
        _toast('Cart is empty — add products first', 'error');
        return;
      }
      if (typeof BillPrint !== 'undefined') BillPrint.generateBill();
    });

    // Khata toggle
    $('khata-toggle')?.addEventListener('change', e => {
      const wrap = $('khata-customer-select-wrap');
      if (e.target.checked) {
        wrap?.classList.remove('hidden');
        if (typeof Khata !== 'undefined') Khata.refreshCustomerSelect();
      } else {
        wrap?.classList.add('hidden');
        if ($('khata-customer-select')) $('khata-customer-select').value = '';
      }
    });

    // Manual add button
    $('manual-add-btn')?.addEventListener('click', manualAdd);
    $('manual-product-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') manualAdd();
    });

    renderCart();
  }

  function manualAdd() {
    const nameInput = $('manual-product-input');
    const qtyInput  = $('manual-qty-input');
    const query = nameInput.value.trim();
    const qty   = parseInt(qtyInput.value) || 1;

    if (!query) { _toast('Enter a product name', 'error'); return; }

    // Try fuzzy match via Products module
    if (typeof Products !== 'undefined') {
      const match = Products.findBestMatch(query);
      if (match) {
        addToCart(match.product.id, qty);
        nameInput.value = '';
        qtyInput.value  = 1;
        _toast(`${match.product.name} × ${qty} added`);
        return;
      }
    }

    // No match — add as custom item with price prompt
    const priceStr = prompt(`No product found for "${query}". Enter price (₹) or Cancel:`);
    if (priceStr === null) return;
    const price = parseFloat(priceStr) || 0;
    addToCart(null, qty, query, price);
    nameInput.value = '';
    qtyInput.value  = 1;
    _toast(`${query} × ${qty} added`);
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

  // ─── Public API ──────────────────────────────────────────────────
  return {
    init,
    addToCart,
    removeFromCart,
    updateQty,
    clearCart,
    renderCart,
    getCart,
    getDiscount,
    getSubtotal,
    getTotal,
    getTotalProfit,
    getSelectedKhataCustomer,
  };

})();
