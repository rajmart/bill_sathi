'use strict';

/**
 * khata.js
 * Khata (ledger) module — customer accounts, baki/jama transactions.
 * Depends on: storage.js
 */

const Khata = (() => {

  const $ = id => document.getElementById(id);

  let _activeCustomerId = null;

  // ─── Render Customer List ────────────────────────────────────────

  function renderKhataList() {
    const listEl = $('khata-list');
    const emptyEl = $('khata-empty');
    if (!listEl) return;

    const customers = Storage.getAllKhata();
    listEl.innerHTML = '';

    if (customers.length === 0) {
      emptyEl.style.display = 'block';
      return;
    }

    emptyEl.style.display = 'none';
    const curr = Storage.getSettings().currency || '₹';

    customers.forEach(c => {
      const balance    = c.balance || 0;
      const isPositive = balance > 0;   // baki — they owe you
      const isNegative = balance < 0;   // jama — you owe them

      const card = document.createElement('div');
      card.className = 'khata-card';
      card.setAttribute('data-id', c.id);
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `${c.name} — balance ${curr}${Math.abs(balance).toFixed(2)}`);

      card.innerHTML = `
        <div class="khata-card-main">
          <div class="khata-avatar">${c.name.charAt(0).toUpperCase()}</div>
          <div class="khata-info">
            <span class="khata-name">${_esc(c.name)}</span>
            ${c.phone ? `<span class="khata-phone">📞 ${_esc(c.phone)}</span>` : ''}
          </div>
        </div>
        <div class="khata-balance-wrap">
          <span class="khata-balance ${isPositive ? 'baki' : isNegative ? 'jama' : 'clear'}">
            ${isPositive ? 'Baki' : isNegative ? 'Jama' : 'Clear'}
            ${curr}${Math.abs(balance).toFixed(2)}
          </span>
          <button class="khata-delete-btn" data-id="${c.id}" aria-label="Delete ${_esc(c.name)}">🗑</button>
        </div>
      `;

      // Open detail modal on click
      card.addEventListener('click', e => {
        if (e.target.classList.contains('khata-delete-btn')) return;
        openDetailModal(c.id);
      });
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') openDetailModal(c.id);
      });

      listEl.appendChild(card);
    });

    // Delete buttons
    listEl.querySelectorAll('.khata-delete-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        confirmDeleteCustomer(btn.dataset.id);
      });
    });

    // Also refresh the billing dropdown
    refreshCustomerSelect();
  }

  // ─── Add Customer ────────────────────────────────────────────────

  function addCustomer() {
    const nameInput  = $('new-customer-name');
    const phoneInput = $('new-customer-phone');
    const name  = nameInput.value.trim();
    const phone = phoneInput.value.trim();

    if (!name) { _toast('Enter customer name', 'error'); return; }

    const result = Storage.addKhataCustomer(name, phone);

    if (result.error) {
      _toast(`Already exists: ${result.existing.name}`, 'error');
      return;
    }

    nameInput.value  = '';
    phoneInput.value = '';
    _toast(`${name} added to Khata ✓`);
    renderKhataList();
  }

  function confirmDeleteCustomer(id) {
    const c = Storage.getKhataById(id);
    if (!c) return;
    if (confirm(`Delete "${c.name}" from Khata? All their transaction history will be lost.`)) {
      Storage.deleteKhataCustomer(id);
      _toast(`${c.name} removed`);
      renderKhataList();
    }
  }

  // ─── Detail Modal ────────────────────────────────────────────────

  function openDetailModal(customerId) {
    _activeCustomerId = customerId;
    const c = Storage.getKhataById(customerId);
    if (!c) return;

    $('khata-modal-title').textContent = `${c.name} — Ledger`;
    _renderLedger(c);

    const modal = $('khata-detail-modal');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    $('settle-amount').value = '';
    $('settle-amount').focus();
  }

  function closeDetailModal() {
    _activeCustomerId = null;
    const modal = $('khata-detail-modal');
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  function _renderLedger(customer) {
    const body = $('khata-modal-body');
    const curr = Storage.getSettings().currency || '₹';
    const txns  = (customer.transactions || []).slice().reverse(); // newest first

    const balance    = customer.balance || 0;
    const isPositive = balance > 0;

    let html = `
      <div class="ledger-balance-summary ${isPositive ? 'baki' : balance < 0 ? 'jama' : 'clear'}">
        <span class="lbs-label">${isPositive ? '🔴 Baki (owes you)' : balance < 0 ? '🟢 Jama (advance)' : '✅ All Clear'}</span>
        <span class="lbs-amount">${curr}${Math.abs(balance).toFixed(2)}</span>
      </div>
    `;

    if (txns.length === 0) {
      html += `<p class="ledger-empty">No transactions yet.</p>`;
    } else {
      html += `<div class="ledger-entries">`;
      txns.forEach(tx => {
        const date  = new Date(tx.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' });
        const time  = new Date(tx.date).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
        const typeLabel = { baki:'Baki', jama:'Jama', bill:'Bill', settle:'Settled' }[tx.type] || tx.type;
        const cls = (tx.type === 'baki' || tx.type === 'bill') ? 'tx-baki' : 'tx-jama';

        html += `
          <div class="ledger-entry ${cls}">
            <div class="tx-left">
              <span class="tx-type">${typeLabel}</span>
              <span class="tx-note">${_esc(tx.note || '')}</span>
              <span class="tx-date">${date} ${time}</span>
            </div>
            <span class="tx-amount">${curr}${tx.amount.toFixed(2)}</span>
          </div>
        `;
      });
      html += `</div>`;
    }

    body.innerHTML = html;
  }

  // ─── Settle (Baki / Jama) ────────────────────────────────────────

  function addBaki() {
    _settle('baki');
  }

  function addJama() {
    _settle('jama');
  }

  function _settle(type) {
    if (!_activeCustomerId) return;
    const amtInput = $('settle-amount');
    const amt = parseFloat(amtInput.value);

    if (isNaN(amt) || amt <= 0) {
      _toast('Enter a valid amount', 'error'); return;
    }

    const label = type === 'baki' ? 'Baki added' : 'Jama added';
    Storage.addKhataTransaction(_activeCustomerId, type, amt, label);
    amtInput.value = '';

    // Re-render ledger with fresh data
    const updated = Storage.getKhataById(_activeCustomerId);
    _renderLedger(updated);
    renderKhataList();
    _toast(`${curr()}${amt.toFixed(2)} ${type} recorded ✓`);
  }

  function curr() {
    return Storage.getSettings().currency || '₹';
  }

  // ─── Billing Integration ─────────────────────────────────────────

  /** Refresh the dropdown in the billing tab */
  function refreshCustomerSelect() {
    const select = $('khata-customer-select');
    if (!select) return;

    const customers = Storage.getAllKhata();
    const curr2 = Storage.getSettings().currency || '₹';

    // Keep placeholder
    select.innerHTML = '<option value="">-- Select Customer --</option>';
    customers.forEach(c => {
      const balance = c.balance || 0;
      const balLabel = balance > 0
        ? ` (Baki ${curr2}${balance.toFixed(2)})`
        : balance < 0
          ? ` (Jama ${curr2}${Math.abs(balance).toFixed(2)})`
          : '';
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name}${balLabel}`;
      select.appendChild(opt);
    });
  }

  /**
   * Called by bill-print.js after a bill is generated for a khata customer.
   * Records the bill amount as 'bill' type transaction.
   */
  function recordBillTransaction(customerId, amount, billId) {
    return Storage.addKhataTransaction(
      customerId, 'bill', amount,
      `Bill #${billId}`, billId
    );
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
    $('add-customer-btn')?.addEventListener('click', addCustomer);

    // Enter key on name input
    $('new-customer-name')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') $('new-customer-phone')?.focus();
    });
    $('new-customer-phone')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addCustomer();
    });

    // Modal close
    $('khata-modal-close')?.addEventListener('click', closeDetailModal);
    $('khata-modal-backdrop')?.addEventListener('click', closeDetailModal);

    // Settle buttons
    $('settle-baki-btn')?.addEventListener('click', addBaki);
    $('settle-jama-btn')?.addEventListener('click', addJama);

    renderKhataList();
  }

  // ─── Public API ──────────────────────────────────────────────────
  return {
    init,
    renderKhataList,
    refreshCustomerSelect,
    recordBillTransaction,
    openDetailModal,
    closeDetailModal,
  };

})();
