'use strict';

/**
 * app.js
 * Main application shell — init, tab routing, settings modal,
 * live clock, connection status, toast notifications.
 * Must be loaded LAST (after all other JS files).
 */

const App = (() => {

  const $ = id => document.getElementById(id);

  // ─── Tab Routing ─────────────────────────────────────────────────

  const TABS = ['billing', 'khata', 'products', 'bills'];
  let _activeTab = 'billing';

  function switchTab(tabName) {
    if (!TABS.includes(tabName)) return;
    _activeTab = tabName;

    // Toggle panels
    TABS.forEach(t => {
      const panel = $(`tab-${t}`);
      const btn   = document.querySelector(`[data-tab="${t}"]`);
      if (!panel || !btn) return;

      const isActive = t === tabName;
      panel.classList.toggle('active', isActive);
      panel.classList.toggle('hidden', !isActive);
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });

    // Refresh data when switching to certain tabs
    if (tabName === 'khata'    && typeof Khata    !== 'undefined') Khata.renderKhataList();
    if (tabName === 'products' && typeof Products !== 'undefined') Products.renderProductList();
    if (tabName === 'bills'    && typeof BillPrint !== 'undefined') BillPrint.renderBillHistory();
  }

  function _initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  // ─── Settings Modal ──────────────────────────────────────────────

  function _openSettings() {
    const s = Storage.getSettings();
    $('settings-shop-name').value    = s.shopName    || '';
    $('settings-shop-address').value = s.shopAddress || '';
    $('settings-shop-phone').value   = s.shopPhone   || '';
    $('settings-voice-lang').value   = s.voiceLang   || 'hi-IN';
    $('settings-currency').value     = s.currency    || '₹';
    $('settings-modal')?.classList.remove('hidden');
  }

  function _closeSettings() {
    $('settings-modal')?.classList.add('hidden');
  }

  function _saveSettings() {
    const updated = {
      shopName   : $('settings-shop-name').value.trim()    || 'Smart Cashier',
      shopAddress: $('settings-shop-address').value.trim() || '',
      shopPhone  : $('settings-shop-phone').value.trim()   || '',
      voiceLang  : $('settings-voice-lang').value          || 'hi-IN',
      currency   : $('settings-currency').value            || '₹',
    };

    Storage.saveSettings(updated);

    // Update header shop name
    const shopNameEl = $('shop-name-display');
    if (shopNameEl) shopNameEl.textContent = updated.shopName;

    // Re-render cart to pick up new currency symbol
    if (typeof Billing !== 'undefined') Billing.renderCart();

    _closeSettings();
    showToast('Settings saved ✓');
  }

  function _initSettings() {
    $('settings-btn')?.addEventListener('click', _openSettings);
    $('settings-modal-close')?.addEventListener('click', _closeSettings);
    $('settings-modal-backdrop')?.addEventListener('click', _closeSettings);
    $('settings-save-btn')?.addEventListener('click', _saveSettings);
  }

  // ─── Clock ───────────────────────────────────────────────────────

  function _startClock() {
    function _tick() {
      const el = $('current-date-time');
      if (!el) return;
      const now = new Date();
      el.textContent = now.toLocaleString('en-IN', {
        weekday: 'short',
        day    : '2-digit',
        month  : 'short',
        hour   : '2-digit',
        minute : '2-digit',
      });
    }
    _tick();
    setInterval(_tick, 30_000); // update every 30s
  }

  // ─── Connection Status ───────────────────────────────────────────

  function _initConnectionStatus() {
    const dot = $('status-dot');
    if (!dot) return;

    function update() {
      const online = navigator.onLine;
      dot.style.background = online ? '#4caf50' : '#f44336';
      dot.title = online ? 'Online' : 'Offline — app still works';
    }

    update();
    window.addEventListener('online',  update);
    window.addEventListener('offline', update);
  }

  // ─── Toast Notifications ─────────────────────────────────────────

  /**
   * Show a toast message.
   * @param {string} msg    - Message text
   * @param {string} type   - 'success' | 'error' | 'info'
   * @param {number} duration - ms before auto-dismiss (default 2800)
   */
  function showToast(msg, type = 'success', duration = 2800) {
    const container = $('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.textContent = msg;

    container.appendChild(toast);

    // Trigger entrance animation
    requestAnimationFrame(() => toast.classList.add('toast-show'));

    const dismiss = () => {
      toast.classList.remove('toast-show');
      toast.classList.add('toast-hide');
      setTimeout(() => toast.remove(), 350);
    };

    // Auto-dismiss
    const timer = setTimeout(dismiss, duration);

    // Tap to dismiss early
    toast.addEventListener('click', () => {
      clearTimeout(timer);
      dismiss();
    });
  }

  // ─── Keyboard Shortcuts ──────────────────────────────────────────

  function _initKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
      // Escape closes any open modal
      if (e.key === 'Escape') {
        $('settings-modal')?.classList.add('hidden');
        if (typeof Khata !== 'undefined') Khata.closeDetailModal?.();
        $('confirm-dialog')?.classList.add('hidden');
      }

      // Alt+B / Alt+K / Alt+P / Alt+H to switch tabs
      if (e.altKey) {
        const map = { b: 'billing', k: 'khata', p: 'products', h: 'bills' };
        const tab = map[e.key.toLowerCase()];
        if (tab) { e.preventDefault(); switchTab(tab); }
      }
    });
  }

  // ─── Install (PWA) Banner ────────────────────────────────────────

  let _deferredInstallPrompt = null;

  function _initInstallPrompt() {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      _deferredInstallPrompt = e;
      // Show a subtle install toast once
      showToast('📲 Install as app? Tap here →', 'info', 8000);
      $('toast-container')?.addEventListener('click', () => {
        if (_deferredInstallPrompt) {
          _deferredInstallPrompt.prompt();
          _deferredInstallPrompt = null;
        }
      }, { once: true });
    });
  }

  // ─── Apply Saved Settings on Load ───────────────────────────────

  function _applySavedSettings() {
    const s = Storage.getSettings();
    const shopNameEl = $('shop-name-display');
    if (shopNameEl) shopNameEl.textContent = s.shopName || 'Smart Cashier';
  }

  // ─── Init ────────────────────────────────────────────────────────

  function init() {
    // Apply settings first (shop name etc.)
    _applySavedSettings();

    // Start clock
    _startClock();

    // Connection status indicator
    _initConnectionStatus();

    // Tab nav
    _initTabs();

    // Settings modal
    _initSettings();

    // Keyboard shortcuts
    _initKeyboardShortcuts();

    // PWA install prompt
    _initInstallPrompt();

    // Init all modules
    if (typeof Products  !== 'undefined') Products.init();
    if (typeof Khata     !== 'undefined') Khata.init();
    if (typeof Billing   !== 'undefined') Billing.init();
    if (typeof Voice     !== 'undefined') Voice.init();
    if (typeof BillPrint !== 'undefined') BillPrint.init();

    // Start on billing tab
    switchTab('billing');

    console.log('[App] Smart Cashier ready ✓');
  }

  // ─── Public API ──────────────────────────────────────────────────
  return {
    init,
    switchTab,
    showToast,
  };

})();

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// Wait for DOM to be fully ready before initializing
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', App.init);
} else {
  App.init();
}
