'use strict';

/**
 * bill-print.js — Bill Sathi
 * - Newest bill on top (already was, kept)
 * - Expandable bill cards (click to expand/collapse)
 * - Profit shown on right side of each card
 * - Khata bills → green card, Baki → red card, paid → neutral/white
 */

const BillPrint = (() => {

  const $ = id => document.getElementById(id);
  let _activeBill = null;

  // ─── Generate Bill ───────────────────────────────────────────────

  function generateBill() {
    const cart     = Billing.getCart();
    const subtotal = Billing.getSubtotal();
    const discount = Billing.getDiscount();
    const total    = Billing.getTotal();
    const profit   = Billing.getTotalProfit();
    const settings = Storage.getSettings();
    const curr     = settings.currency || '₹';

    if (cart.length === 0) { _toast('Cart is empty', 'error'); return; }

    const khataCustomerId = Billing.getSelectedKhataCustomer();
    let khataCustomerName = null;
    if (khataCustomerId) {
      const c = Storage.getKhataById(khataCustomerId);
      khataCustomerName = c ? c.name : null;
    }

    const paymentMode = khataCustomerId ? 'baki' : 'cash';

    const savedBill = Storage.saveBill({
      items: cart, subtotal, discount, total,
      totalProfit: profit, khataCustomerId, khataCustomerName, paymentMode,
    });

    const stockItems = cart.filter(i => i.productId).map(i => ({ productId: i.productId, qty: i.qty }));
    if (stockItems.length) Storage.deductStock(stockItems);

    if (khataCustomerId && khataCustomerName) {
      Khata.recordBillTransaction(khataCustomerId, total, savedBill.billId);
    }

    _renderReceipt(savedBill, settings);
    if (typeof App !== 'undefined') App.switchTab('bills');
    $('bill-actions')?.classList.remove('hidden');
    renderBillHistory();
    _toast(`Bill #${savedBill.billNumber} generated ✓`);
  }

  // ─── Render Receipt (full view) ───────────────────────────────────

  function _renderReceipt(bill, settings) {
    const curr = settings.currency || '₹';
    if ($('receipt-shop-name')) $('receipt-shop-name').textContent = settings.shopName || 'Smart Cashier';

    const date = _fmtDate(bill.generatedAt);
    const metaParts = [`Bill #${bill.billNumber}`, date];
    if (settings.shopPhone)   metaParts.push(`📞 ${settings.shopPhone}`);
    if (settings.shopAddress) metaParts.push(settings.shopAddress);
    if ($('receipt-meta')) $('receipt-meta').innerHTML = metaParts.join(' &nbsp;|&nbsp; ');

    const tbody = $('receipt-body');
    if (tbody) {
      tbody.innerHTML = '';
      bill.items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${_esc(item.name)}<small class="rx-unit">${_esc(item.unit||'')}</small></td>
          <td class="rx-num">${item.qty}</td>
          <td class="rx-num">${curr}${item.sellPrice.toFixed(2)}</td>
          <td class="rx-num">${curr}${item.lineTotal.toFixed(2)}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    const totalsEl = $('receipt-totals');
    if (totalsEl) {
      let html = `<div class="rx-total-row"><span>Subtotal</span><span>${curr}${bill.subtotal.toFixed(2)}</span></div>`;
      if (bill.discount > 0)
        html += `<div class="rx-total-row discount"><span>Discount</span><span>- ${curr}${bill.discount.toFixed(2)}</span></div>`;
      html += `<div class="rx-total-row grand-total"><span>Total</span><span>${curr}${bill.total.toFixed(2)}</span></div>`;
      totalsEl.innerHTML = html;
    }

    const profitEl = $('profit-details');
    if (profitEl) {
      const margin = bill.subtotal > 0 ? ((bill.totalProfit / bill.subtotal) * 100).toFixed(1) : '0.0';
      let html = '';
      bill.items.forEach(item => {
        const ip = item.lineProfit || 0;
        html += `<div class="profit-row">
          <span class="pr-name">${_esc(item.name)} × ${item.qty}</span>
          <span class="pr-amt ${ip >= 0 ? 'pos' : 'neg'}">${curr}${ip.toFixed(2)}</span>
        </div>`;
      });
      if (bill.discount > 0)
        html += `<div class="profit-row"><span class="pr-name">- Discount</span><span class="pr-amt neg">- ${curr}${bill.discount.toFixed(2)}</span></div>`;
      html += `<div class="profit-summary">
        <span>Net Profit</span>
        <span class="${bill.totalProfit >= 0 ? 'profit-pos' : 'profit-neg'}">${curr}${bill.totalProfit.toFixed(2)} (${margin}%)</span>
      </div>`;
      profitEl.innerHTML = html;
    }

    const khataInfoEl = $('receipt-khata-info');
    if (khataInfoEl) {
      if (bill.khataCustomerName) {
        const c = bill.khataCustomerId ? Storage.getKhataById(bill.khataCustomerId) : null;
        const newBal = c ? c.balance : null;
        khataInfoEl.innerHTML = `
          <div class="rx-khata-row">
            <span>📒 Khata: <strong>${_esc(bill.khataCustomerName)}</strong></span>
            <span class="rx-khata-mode">Added to Baki</span>
          </div>
          ${newBal !== null ? `<div class="rx-khata-row"><span>Balance</span>
            <span class="${newBal > 0 ? 'baki' : 'jama'}">${newBal > 0 ? 'Baki' : 'Jama'} ${curr}${Math.abs(newBal).toFixed(2)}</span></div>` : ''}
        `;
        khataInfoEl.classList.remove('hidden');
      } else {
        khataInfoEl.innerHTML = '';
        khataInfoEl.classList.add('hidden');
      }
    }

    _activeBill = bill;
  }

  // ─── Bill History — expandable cards ─────────────────────────────

  function renderBillHistory() {
    const listEl  = $('bills-history-list');
    const emptyEl = $('bills-history-empty');
    if (!listEl) return;

    const bills = Storage.getAllBills();
    const curr  = Storage.getSettings().currency || '₹';
    listEl.innerHTML = '';

    if (bills.length === 0) { emptyEl.style.display = 'block'; return; }
    emptyEl.style.display = 'none';

    bills.forEach(bill => {
      // Determine card color class
      // khata bill that is still outstanding → red (baki)
      // khata bill where customer has paid (balance <= 0) → green (jama/clear)
      // cash bill → default
      let cardColorClass = '';
      if (bill.khataCustomerId) {
        const c = Storage.getKhataById(bill.khataCustomerId);
        if (c) {
          cardColorClass = c.balance > 0 ? 'hc-baki' : 'hc-jama';
        } else {
          cardColorClass = 'hc-baki'; // customer deleted but was baki
        }
      }

      const date   = _fmtDate(bill.generatedAt);
      const margin = bill.subtotal > 0 ? ((bill.totalProfit / bill.subtotal) * 100).toFixed(1) : '0.0';

      const card = document.createElement('div');
      card.className = `history-card ${cardColorClass}`;
      card.setAttribute('data-bill-id', bill.billId);

      // ── Card header (always visible) ──
      const header = document.createElement('div');
      header.className = 'hc-header';
      header.innerHTML = `
        <div class="hc-header-left">
          <span class="hc-bill-num">#${bill.billNumber}</span>
          <span class="hc-date">${date}</span>
          ${bill.khataCustomerName ? `<span class="hc-khata-badge">📒 ${_esc(bill.khataCustomerName)}</span>` : ''}
        </div>
        <div class="hc-header-right">
          <div class="hc-amounts">
            <span class="hc-total">${curr}${bill.total.toFixed(2)}</span>
            <span class="hc-profit ${bill.totalProfit >= 0 ? 'pos' : 'neg'}">
              profit: ${curr}${bill.totalProfit.toFixed(2)} (${margin}%)
            </span>
          </div>
          <span class="hc-chevron">▾</span>
        </div>
      `;

      // ── Expanded body (hidden by default) ──
      const body = document.createElement('div');
      body.className = 'hc-body hidden';

      // Build items list
      let itemsHtml = `<table class="hc-items-table">
        <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Total</th><th>Profit</th></tr></thead>
        <tbody>`;
      bill.items.forEach(item => {
        const ip = item.lineProfit || 0;
        itemsHtml += `<tr>
          <td>${_esc(item.name)} <small>${_esc(item.unit||'')}</small></td>
          <td>${item.qty}</td>
          <td>${curr}${item.sellPrice.toFixed(2)}</td>
          <td>${curr}${item.lineTotal.toFixed(2)}</td>
          <td class="${ip >= 0 ? 'pos' : 'neg'}">${curr}${ip.toFixed(2)}</td>
        </tr>`;
      });
      itemsHtml += `</tbody></table>`;

      // Totals summary
      let totalsHtml = `<div class="hc-totals">`;
      if (bill.discount > 0)
        totalsHtml += `<div class="hc-total-row"><span>Discount</span><span class="neg">- ${curr}${bill.discount.toFixed(2)}</span></div>`;
      totalsHtml += `<div class="hc-total-row grand"><span>Total</span><span>${curr}${bill.total.toFixed(2)}</span></div>`;
      totalsHtml += `<div class="hc-total-row profit-row-summary"><span>Net Profit</span>
        <span class="${bill.totalProfit >= 0 ? 'pos' : 'neg'}">${curr}${bill.totalProfit.toFixed(2)} (${margin}%)</span>
      </div></div>`;

      // Khata status
      let khataHtml = '';
      if (bill.khataCustomerName) {
        const c    = bill.khataCustomerId ? Storage.getKhataById(bill.khataCustomerId) : null;
        const bal  = c ? c.balance : null;
        khataHtml  = `<div class="hc-khata-row">
          <span>📒 ${_esc(bill.khataCustomerName)}</span>
          ${bal !== null
            ? `<span class="${bal > 0 ? 'baki' : 'jama'}">${bal > 0 ? 'Baki' : 'Paid'} ${curr}${Math.abs(bal).toFixed(2)}</span>`
            : ''}
        </div>`;
      }

      // Action buttons inside expanded
      const actionsHtml = `<div class="hc-actions">
        <button class="btn-secondary hc-reprint-btn" data-bill-id="${bill.billId}">🖨 Print</button>
        <button class="btn-success hc-whatsapp-btn"  data-bill-id="${bill.billId}">💬 WhatsApp</button>
      </div>`;

      body.innerHTML = itemsHtml + totalsHtml + khataHtml + actionsHtml;

      // Toggle expand/collapse
      header.addEventListener('click', () => {
        const isOpen = !body.classList.contains('hidden');
        // Close all others
        listEl.querySelectorAll('.hc-body').forEach(b => b.classList.add('hidden'));
        listEl.querySelectorAll('.hc-chevron').forEach(c => c.textContent = '▾');
        if (!isOpen) {
          body.classList.remove('hidden');
          header.querySelector('.hc-chevron').textContent = '▴';
        }
      });

      // Reprint / WhatsApp inside card
      body.querySelector('.hc-reprint-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const b = Storage.getBillById(bill.billId);
        if (b) { _renderReceipt(b, Storage.getSettings()); printBill(); }
      });
      body.querySelector('.hc-whatsapp-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        const b = Storage.getBillById(bill.billId);
        if (b) { _activeBill = b; shareWhatsApp(); }
      });

      card.appendChild(header);
      card.appendChild(body);
      listEl.appendChild(card);
    });
  }

  // ─── Print ───────────────────────────────────────────────────────

  function printBill() {
    if (!_activeBill) { _toast('No bill to print', 'error'); return; }
    const ps = $('profit-section');
    if (ps) ps.style.display = 'none';
    window.print();
    setTimeout(() => { if (ps) ps.style.display = ''; }, 1000);
  }

  // ─── WhatsApp ─────────────────────────────────────────────────────

  function shareWhatsApp() {
    if (!_activeBill) { _toast('No bill to share', 'error'); return; }
    const settings = Storage.getSettings();
    const curr     = settings.currency || '₹';
    const date     = _fmtDate(_activeBill.generatedAt);
    let msg = `*${settings.shopName || 'Smart Cashier'}*\n`;
    if (settings.shopAddress) msg += `${settings.shopAddress}\n`;
    if (settings.shopPhone)   msg += `📞 ${settings.shopPhone}\n`;
    msg += `\nBill #${_activeBill.billNumber} | ${date}\n${'─'.repeat(30)}\n`;
    _activeBill.items.forEach(i => { msg += `${i.name} × ${i.qty} = ${curr}${i.lineTotal.toFixed(2)}\n`; });
    msg += `${'─'.repeat(30)}\n`;
    if (_activeBill.discount > 0) {
      msg += `Subtotal: ${curr}${_activeBill.subtotal.toFixed(2)}\nDiscount: -${curr}${_activeBill.discount.toFixed(2)}\n`;
    }
    msg += `*Total: ${curr}${_activeBill.total.toFixed(2)}*\n`;
    if (_activeBill.khataCustomerName) msg += `\n📒 Khata: ${_activeBill.khataCustomerName} — added to baki\n`;
    msg += `\nThank you! 🙏`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  }

  // ─── New Bill ─────────────────────────────────────────────────────

  function newBill() {
    Billing.clearCart();
    if (typeof App !== 'undefined') App.switchTab('billing');
    _activeBill = null;
    $('bill-actions')?.classList.add('hidden');
  }

  // ─── Clear History ────────────────────────────────────────────────

  function clearHistory() {
    if (!confirm('Delete all bill history? Cannot be undone.')) return;
    Storage.clearAllBills();
    _activeBill = null;
    $('bill-actions')?.classList.add('hidden');
    ['receipt-body','receipt-totals','profit-details'].forEach(id => {
      const el = $(id); if (el) el.innerHTML = '';
    });
    renderBillHistory();
    _toast('Bill history cleared');
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  function _fmtDate(iso) {
    return new Date(iso).toLocaleString('en-IN', {
      day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit',
    });
  }

  function _esc(str) {
    const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML;
  }

  function _toast(msg, type = 'success') {
    if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type);
    else console.log(`[Toast] ${msg}`);
  }

  function init() {
    $('bill-print-btn')?.addEventListener('click', printBill);
    $('bill-whatsapp-btn')?.addEventListener('click', shareWhatsApp);
    $('bill-new-btn')?.addEventListener('click', newBill);
    $('clear-history-btn')?.addEventListener('click', clearHistory);
    renderBillHistory();
  }

  return { init, generateBill, renderBillHistory, printBill, shareWhatsApp, newBill };
})();
