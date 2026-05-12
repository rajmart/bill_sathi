'use strict';

/**
 * khata.js — Bill Sathi
 * - Two tabs: All | Baki (outstanding) | Jama/Clear (paid)
 * - Transaction history with dates
 * - Baki → red card, Jama/Clear → green/white card
 */

const Khata = (() => {

  const $ = id => document.getElementById(id);
  let _activeCustomerId = null;
  let _khataTab = 'all'; // 'all' | 'baki' | 'clear'

  // ─── Render customer list ─────────────────────────────────────────

  function renderKhataList() {
    const listEl  = $('khata-list');
    const emptyEl = $('khata-empty');
    if (!listEl) return;

    let customers = Storage.getAllKhata();

    // Filter by tab
    if (_khataTab === 'baki')  customers = customers.filter(c => (c.balance || 0) > 0);
    if (_khataTab === 'clear') customers = customers.filter(c => (c.balance || 0) <= 0);

    listEl.innerHTML = '';
    const curr = Storage.getSettings().currency || '₹';

    if (customers.length === 0) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    // Sort: baki customers (highest balance) first
    customers.sort((a, b) => (b.balance || 0) - (a.balance || 0));

    customers.forEach(c => {
      const balance    = c.balance || 0;
      const isBaki     = balance > 0;
      const isJama     = balance < 0;
      const isClear    = balance === 0;

      // Last transaction date
      const txns     = c.transactions || [];
      const lastTx   = txns.length ? txns[txns.length - 1] : null;
      const lastDate = lastTx ? new Date(lastTx.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' }) : null;

      const card = document.createElement('div');
      card.className = `khata-card ${isBaki ? 'kc-baki' : isJama ? 'kc-jama' : 'kc-clear'}`;
      card.setAttribute('data-id', c.id);
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');

      card.innerHTML = `
        <div class="khata-card-main">
          <div class="khata-avatar ${isBaki ? 'av-baki' : isJama ? 'av-jama' : 'av-clear'}">
            ${c.name.charAt(0).toUpperCase()}
          </div>
          <div class="khata-info">
            <span class="khata-name">${_esc(c.name)}</span>
            ${c.phone ? `<span class="khata-phone">📞 ${_esc(c.phone)}</span>` : ''}
            ${lastDate ? `<span class="khata-last-date">Last: ${lastDate}</span>` : ''}
          </div>
        </div>
        <div class="khata-balance-wrap">
          <span class="khata-balance ${isBaki ? 'baki' : isJama ? 'jama' : 'clear'}">
            ${isBaki ? '🔴 Baki' : isJama ? '🟢 Jama' : '✅ Clear'}
            ${curr}${Math.abs(balance).toFixed(2)}
          </span>
          <button class="khata-delete-btn" data-id="${c.id}" aria-label="Delete">🗑</button>
        </div>
      `;

      card.addEventListener('click', e => {
        if (e.target.classList.contains('khata-delete-btn')) return;
        openDetailModal(c.id);
      });
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') openDetailModal(c.id);
      });

      listEl.appendChild(card);
    });

    listEl.querySelectorAll('.khata-delete-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); _confirmDelete(btn.dataset.id); });
    });

    refreshCustomerSelect();
  }

  // ─── Tab switching ────────────────────────────────────────────────

  function _initKhataTabs() {
    ['all','baki','clear'].forEach(tab => {
      $(`khata-tab-${tab}`)?.addEventListener('click', () => {
        _khataTab = tab;
        document.querySelectorAll('.khata-filter-tab').forEach(b => b.classList.remove('active'));
        $(`khata-tab-${tab}`)?.classList.add('active');
        renderKhataList();
      });
    });
  }

  // ─── Add customer ─────────────────────────────────────────────────

  function addCustomer() {
    const nameInput  = $('new-customer-name');
    const phoneInput = $('new-customer-phone');
    const name  = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    if (!name) { _toast('Enter customer name', 'error'); return; }
    const result = Storage.addKhataCustomer(name, phone);
    if (result.error) { _toast(`Already exists: ${result.existing.name}`, 'error'); return; }
    nameInput.value = ''; phoneInput.value = '';
    _toast(`${name} added to Khata ✓`);
    renderKhataList();
  }

  function _confirmDelete(id) {
    const c = Storage.getKhataById(id);
    if (!c) return;
    if (confirm(`Delete "${c.name}"? All history will be lost.`)) {
      Storage.deleteKhataCustomer(id);
      _toast(`${c.name} removed`);
      renderKhataList();
    }
  }

  // ─── Detail Modal ─────────────────────────────────────────────────

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
    const txns = (customer.transactions || []).slice().reverse();
    const balance = customer.balance || 0;
    const isBaki  = balance > 0;

    // Running balance header
    let html = `
      <div class="ledger-balance-summary ${isBaki ? 'baki' : balance < 0 ? 'jama' : 'clear'}">
        <span class="lbs-label">${isBaki ? '🔴 Baki (owes you)' : balance < 0 ? '🟢 Jama (advance)' : '✅ All Clear'}</span>
        <span class="lbs-amount">${curr}${Math.abs(balance).toFixed(2)}</span>
      </div>
    `;

    if (txns.length === 0) {
      html += `<p class="ledger-empty">No transactions yet.</p>`;
    } else {
      html += `<div class="ledger-entries">`;
      txns.forEach(tx => {
        const dateStr = new Date(tx.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' });
        const timeStr = new Date(tx.date).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
        const typeLabel = { baki:'Baki', jama:'Jama', bill:'Bill', settle:'Settled' }[tx.type] || tx.type;
        const cls = (tx.type === 'baki' || tx.type === 'bill') ? 'tx-baki' : 'tx-jama';
        html += `
          <div class="ledger-entry ${cls}">
            <div class="tx-left">
              <span class="tx-type">${typeLabel}</span>
              <span class="tx-note">${_esc(tx.note || '')}</span>
              <span class="tx-date">${dateStr} ${timeStr}</span>
            </div>
            <span class="tx-amount">${curr}${tx.amount.toFixed(2)}</span>
          </div>
        `;
      });
      html += `</div>`;
    }

    body.innerHTML = html;
  }

  // ─── Settle ───────────────────────────────────────────────────────

  function addBaki()  { _settle('baki'); }
  function addJama()  { _settle('jama'); }

  function _settle(type) {
    if (!_activeCustomerId) return;
    const amtInput = $('settle-amount');
    const amt = parseFloat(amtInput.value);
    if (isNaN(amt) || amt <= 0) { _toast('Enter a valid amount', 'error'); return; }
    const label = type === 'baki' ? 'Baki added' : 'Jama added';
    Storage.addKhataTransaction(_activeCustomerId, type, amt, label);
    amtInput.value = '';
    const updated = Storage.getKhataById(_activeCustomerId);
    _renderLedger(updated);
    renderKhataList();
    const curr = Storage.getSettings().currency || '₹';
    _toast(`${curr}${amt.toFixed(2)} ${type} recorded ✓`);
  }

  // ─── Billing integration ──────────────────────────────────────────

  function refreshCustomerSelect() {
    const select = $('khata-customer-select');
    if (!select) return;
    const customers = Storage.getAllKhata();
    const curr2     = Storage.getSettings().currency || '₹';
    select.innerHTML = '<option value="">-- Select Customer --</option>';
    customers.forEach(c => {
      const b = c.balance || 0;
      const balLabel = b > 0 ? ` (Baki ${curr2}${b.toFixed(2)})` : b < 0 ? ` (Jama ${curr2}${Math.abs(b).toFixed(2)})` : '';
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name}${balLabel}`;
      select.appendChild(opt);
    });
  }

  function recordBillTransaction(customerId, amount, billId) {
    return Storage.addKhataTransaction(customerId, 'bill', amount, `Bill #${billId}`, billId);
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  function _esc(str) {
    const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML;
  }

  function _toast(msg, type = 'success') {
    if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type);
    else console.log(`[Toast] ${msg}`);
  }

  // ─── Init ─────────────────────────────────────────────────────────

  function init() {
    $('add-customer-btn')?.addEventListener('click', addCustomer);
    $('new-customer-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('new-customer-phone')?.focus(); });
    $('new-customer-phone')?.addEventListener('keydown', e => { if (e.key === 'Enter') addCustomer(); });
    $('khata-modal-close')?.addEventListener('click', closeDetailModal);
    $('khata-modal-backdrop')?.addEventListener('click', closeDetailModal);
    $('settle-baki-btn')?.addEventListener('click', addBaki);
    $('settle-jama-btn')?.addEventListener('click', addJama);
    _initKhataTabs();
    renderKhataList();
  }

  return { init, renderKhataList, refreshCustomerSelect, recordBillTransaction, openDetailModal, closeDetailModal };
})();
