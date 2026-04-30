'use strict';

/**
 * bill-print.js
 * Bill generation, profit breakdown, print, WhatsApp share, bill history.
 * Depends on: storage.js, billing.js, khata.js
 */

const BillPrint = (() => {

  const $ = id => document.getElementById(id);

  // ─── Generate Bill ───────────────────────────────────────────────

  /**
   * Called by billing.js "Generate Bill" button.
   * Pulls data from Billing module, saves to Storage, renders receipt,
   * optionally records to Khata, then switches to Bills tab.
   */
  function generateBill() {
    const cart      = Billing.getCart();
    const subtotal  = Billing.getSubtotal();
    const discount  = Billing.getDiscount();
    const total     = Billing.getTotal();
    const profit    = Billing.getTotalProfit();
    const settings  = Storage.getSettings();
    const curr      = settings.currency || '₹';

    if (cart.length === 0) {
      _toast('Cart is empty', 'error');
      return;
    }

    // Khata customer (optional)
    const khataCustomerId = Billing.getSelectedKhataCustomer();
    let khataCustomerName = null;
    if (khataCustomerId) {
      const c = Storage.getKhataById(khataCustomerId);
      khataCustomerName = c ? c.name : null;
    }

    // Determine payment mode
    const paymentMode = khataCustomerId ? 'baki' : 'cash';

    // Save bill to history
    const savedBill = Storage.saveBill({
      items            : cart,
      subtotal,
      discount,
      total,
      totalProfit      : profit,
      khataCustomerId,
      khataCustomerName,
      paymentMode,
    });

    // Deduct stock for known products
    const stockItems = cart
      .filter(i => i.productId)
      .map(i => ({ productId: i.productId, qty: i.qty }));
    if (stockItems.length) Storage.deductStock(stockItems);

    // Record in khata ledger if applicable
    if (khataCustomerId && khataCustomerName) {
      Khata.recordBillTransaction(khataCustomerId, total, savedBill.billId);
    }

    // Render the receipt on Bills tab
    _renderReceipt(savedBill, settings);

    // Switch to Bills tab
    if (typeof App !== 'undefined') App.switchTab('bills');

    // Show bill actions
    $('bill-actions')?.classList.remove('hidden');

    // Refresh bill history list
    renderBillHistory();

    _toast(`Bill #${savedBill.billNumber} generated ✓`);
  }

  // ─── Render Receipt ──────────────────────────────────────────────

  function _renderReceipt(bill, settings) {
    const curr = settings.currency || '₹';

    // Shop header
    if ($('receipt-shop-name')) $('receipt-shop-name').textContent = settings.shopName || 'Smart Cashier';

    // Meta line: bill number, date, phone, address
    const date = new Date(bill.generatedAt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const metaParts = [`Bill #${bill.billNumber}`, date];
    if (settings.shopPhone)   metaParts.push(`📞 ${settings.shopPhone}`);
    if (settings.shopAddress) metaParts.push(settings.shopAddress);
    if ($('receipt-meta')) $('receipt-meta').innerHTML = metaParts.join(' &nbsp;|&nbsp; ');

    // Items table body
    const tbody = $('receipt-body');
    if (tbody) {
      tbody.innerHTML = '';
      bill.items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${_esc(item.name)}<small class="rx-unit">${_esc(item.unit || '')}</small></td>
          <td class="rx-num">${item.qty}</td>
          <td class="rx-num">${curr}${item.sellPrice.toFixed(2)}</td>
          <td class="rx-num">${curr}${item.lineTotal.toFixed(2)}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    // Totals
    const totalsEl = $('receipt-totals');
    if (totalsEl) {
      let html = `
        <div class="rx-total-row"><span>Subtotal</span><span>${curr}${bill.subtotal.toFixed(2)}</span></div>
      `;
      if (bill.discount > 0) {
        html += `<div class="rx-total-row discount"><span>Discount</span><span>- ${curr}${bill.discount.toFixed(2)}</span></div>`;
      }
      html += `<div class="rx-total-row grand-total"><span>Total</span><span>${curr}${bill.total.toFixed(2)}</span></div>`;
      totalsEl.innerHTML = html;
    }

    // Profit breakdown (internal — not printed)
    const profitEl = $('profit-details');
    if (profitEl) {
      const margin = bill.subtotal > 0
        ? ((bill.totalProfit / bill.subtotal) * 100).toFixed(1)
        : '0.0';

      let html = '';
      bill.items.forEach(item => {
        const itemProfit = item.lineProfit || 0;
        html += `
          <div class="profit-row">
            <span class="pr-name">${_esc(item.name)} × ${item.qty}</span>
            <span class="pr-amt ${itemProfit >= 0 ? 'pos' : 'neg'}">${curr}${itemProfit.toFixed(2)}</span>
          </div>
        `;
      });
      if (bill.discount > 0) {
        html += `<div class="profit-row"><span class="pr-name">- Discount</span><span class="pr-amt neg">- ${curr}${bill.discount.toFixed(2)}</span></div>`;
      }
      html += `
        <div class="profit-summary">
          <span>Net Profit</span>
          <span class="${bill.totalProfit >= 0 ? 'profit-pos' : 'profit-neg'}">${curr}${bill.totalProfit.toFixed(2)} (${margin}%)</span>
        </div>
      `;
      profitEl.innerHTML = html;
    }

    // Khata info
    const khataInfoEl = $('receipt-khata-info');
    if (khataInfoEl) {
      if (bill.khataCustomerName) {
        const curr2 = Storage.getSettings().currency || '₹';
        const c = bill.khataCustomerId ? Storage.getKhataById(bill.khataCustomerId) : null;
        const newBalance = c ? c.balance : null;
        khataInfoEl.innerHTML = `
          <div class="rx-khata-row">
            <span>📒 Khata: <strong>${_esc(bill.khataCustomerName)}</strong></span>
            <span class="rx-khata-mode">Added to Baki</span>
          </div>
          ${newBalance !== null
            ? `<div class="rx-khata-row"><span>Updated Balance</span><span class="${newBalance > 0 ? 'baki' : 'jama'}">${newBalance > 0 ? 'Baki' : 'Jama'} ${curr2}${Math.abs(newBalance).toFixed(2)}</span></div>`
            : ''}
        `;
        khataInfoEl.classList.remove('hidden');
      } else {
        khataInfoEl.innerHTML = '';
        khataInfoEl.classList.add('hidden');
      }
    }

    // Store the active bill so Print/WhatsApp can access it
    _activeBill = bill;
  }

  // ─── Active Bill (for print/share) ───────────────────────────────

  let _activeBill = null;

  // ─── Print ───────────────────────────────────────────────────────

  function printBill() {
    if (!_activeBill) {
      _toast('No bill to print', 'error');
      return;
    }

    // Hide profit section and khata balance before printing
    const profitSection = $('profit-section');
    if (profitSection) profitSection.style.display = 'none';

    window.print();

    // Restore after print dialog
    setTimeout(() => {
      if (profitSection) profitSection.style.display = '';
    }, 1000);
  }

  // ─── WhatsApp Share ──────────────────────────────────────────────

  function shareWhatsApp() {
    if (!_activeBill) {
      _toast('No bill to share', 'error');
      return;
    }

    const settings = Storage.getSettings();
    const curr = settings.currency || '₹';
    const date = new Date(_activeBill.generatedAt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    let msg = `*${settings.shopName || 'Smart Cashier'}*\n`;
    if (settings.shopAddress) msg += `${settings.shopAddress}\n`;
    if (settings.shopPhone)   msg += `📞 ${settings.shopPhone}\n`;
    msg += `\nBill #${_activeBill.billNumber} | ${date}\n`;
    msg += `${'─'.repeat(30)}\n`;

    _activeBill.items.forEach(item => {
      msg += `${item.name} × ${item.qty} = ${curr}${item.lineTotal.toFixed(2)}\n`;
    });

    msg += `${'─'.repeat(30)}\n`;
    if (_activeBill.discount > 0) {
      msg += `Subtotal: ${curr}${_activeBill.subtotal.toFixed(2)}\n`;
      msg += `Discount: -${curr}${_activeBill.discount.toFixed(2)}\n`;
    }
    msg += `*Total: ${curr}${_activeBill.total.toFixed(2)}*\n`;

    if (_activeBill.khataCustomerName) {
      msg += `\n📒 Khata: ${_activeBill.khataCustomerName} — added to baki\n`;
    }

    msg += `\nThank you! 🙏`;

    const encoded = encodeURIComponent(msg);
    window.open(`https://wa.me/?text=${encoded}`, '_blank');
  }

  // ─── Bill History ────────────────────────────────────────────────

  function renderBillHistory() {
    const listEl  = $('bills-history-list');
    const emptyEl = $('bills-history-empty');
    if (!listEl) return;

    const bills = Storage.getAllBills();
    const curr  = Storage.getSettings().currency || '₹';
    listEl.innerHTML = '';

    if (bills.length === 0) {
      emptyEl.style.display = 'block';
      return;
    }

    emptyEl.style.display = 'none';

    bills.forEach(bill => {
      const date = new Date(bill.generatedAt).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });

      const card = document.createElement('div');
      card.className = 'history-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Bill #${bill.billNumber} — ${curr}${bill.total.toFixed(2)}`);

      card.innerHTML = `
        <div class="hc-top">
          <span class="hc-bill-num">#${bill.billNumber}</span>
          <span class="hc-date">${date}</span>
        </div>
        <div class="hc-mid">
          <span class="hc-items">${bill.items.length} item${bill.items.length !== 1 ? 's' : ''}</span>
          ${bill.khataCustomerName ? `<span class="hc-khata">📒 ${_esc(bill.khataCustomerName)}</span>` : ''}
        </div>
        <div class="hc-bot">
          <span class="hc-total">${curr}${bill.total.toFixed(2)}</span>
          <span class="hc-profit ${bill.totalProfit >= 0 ? 'pos' : 'neg'}">
            Profit: ${curr}${bill.totalProfit.toFixed(2)}
          </span>
        </div>
      `;

      card.addEventListener('click', () => _openHistoryBill(bill));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') _openHistoryBill(bill);
      });

      listEl.appendChild(card);
    });
  }

  function _openHistoryBill(bill) {
    const settings = Storage.getSettings();
    _renderReceipt(bill, settings);
    $('bill-actions')?.classList.remove('hidden');
    // Scroll to receipt
    $('bill-receipt')?.scrollIntoView({ behavior: 'smooth' });
  }

  function clearHistory() {
    if (!confirm('Delete all bill history? This cannot be undone.')) return;
    Storage.clearAllBills();
    _activeBill = null;
    $('bill-actions')?.classList.add('hidden');
    $('receipt-body') && ($('receipt-body').innerHTML = '');
    $('receipt-totals') && ($('receipt-totals').innerHTML = '');
    $('profit-details') && ($('profit-details').innerHTML = '');
    renderBillHistory();
    _toast('Bill history cleared');
  }

  // ─── New Bill (go back to billing) ───────────────────────────────

  function newBill() {
    Billing.clearCart();
    if (typeof App !== 'undefined') App.switchTab('billing');
    _activeBill = null;
    $('bill-actions')?.classList.add('hidden');
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
    $('bill-print-btn')?.addEventListener('click', printBill);
    $('bill-whatsapp-btn')?.addEventListener('click', shareWhatsApp);
    $('bill-new-btn')?.addEventListener('click', newBill);
    $('clear-history-btn')?.addEventListener('click', clearHistory);

    renderBillHistory();
  }

  // ─── Public API ──────────────────────────────────────────────────
  return {
    init,
    generateBill,
    renderBillHistory,
    printBill,
    shareWhatsApp,
    newBill,
  };

})();
