'use strict';

/**
 * storage.js — Bill Sathi
 * Added: product.company field
 */

const Storage = (() => {

  const KEYS = {
    SETTINGS     : 'sc_settings',
    PRODUCTS     : 'sc_products',
    KHATA        : 'sc_khata',
    BILLS_HISTORY: 'sc_bills_history',
  };

  function _get(key) {
    try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; }
    catch (e) { console.error(`[Storage] Read "${key}":`, e); return null; }
  }

  function _set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { console.error(`[Storage] Write "${key}":`, e); return false; }
  }

  function _remove(key) {
    try { localStorage.removeItem(key); return true; }
    catch (e) { console.error(`[Storage] Remove "${key}":`, e); return false; }
  }

  function generateId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  // ─── Settings ────────────────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    shopName: 'Smart Cashier', shopAddress: '', shopPhone: '',
    voiceLang: 'en-IN', currency: '₹',
  };

  function getSettings() {
    const s = _get(KEYS.SETTINGS);
    return s ? { ...DEFAULT_SETTINGS, ...s } : { ...DEFAULT_SETTINGS };
  }

  function saveSettings(obj) {
    return _set(KEYS.SETTINGS, { ...DEFAULT_SETTINGS, ...obj });
  }

  // ─── Products ────────────────────────────────────────────────────
  // Shape: { id, name, company, aliases[], sellPrice, costPrice, unit, stock, createdAt, updatedAt }

  function getAllProducts() { return _get(KEYS.PRODUCTS) || []; }
  function saveAllProducts(arr) { return _set(KEYS.PRODUCTS, arr); }
  function getProductById(id) { return getAllProducts().find(p => p.id === id) || null; }

  /** Return all distinct company names (non-empty), sorted A-Z */
  function getAllCompanies() {
    const names = getAllProducts()
      .map(p => (p.company || '').trim())
      .filter(Boolean);
    return [...new Set(names)].sort();
  }

  function addProduct(data) {
    const products = getAllProducts();
    const p = {
      id        : generateId('prod'),
      name      : data.name.trim(),
      company   : (data.company || '').trim(),
      aliases   : Array.isArray(data.aliases) ? data.aliases : [],
      sellPrice : parseFloat(data.sellPrice) || 0,
      costPrice : parseFloat(data.costPrice) || 0,
      unit      : data.unit || 'pcs',
      stock     : parseInt(data.stock) || 0,
      createdAt : new Date().toISOString(),
      updatedAt : new Date().toISOString(),
    };
    products.push(p);
    _set(KEYS.PRODUCTS, products);
    return p;
  }

  function updateProduct(id, data) {
    const products = getAllProducts();
    const i = products.findIndex(p => p.id === id);
    if (i === -1) return null;
    products[i] = { ...products[i], ...data, id, updatedAt: new Date().toISOString() };
    _set(KEYS.PRODUCTS, products);
    return products[i];
  }

  function deleteProduct(id) {
    return _set(KEYS.PRODUCTS, getAllProducts().filter(p => p.id !== id));
  }

  function deductStock(itemsArray) {
    const products = getAllProducts();
    itemsArray.forEach(({ productId, qty }) => {
      const p = products.find(p => p.id === productId);
      if (p && p.stock > 0) { p.stock = Math.max(0, p.stock - qty); p.updatedAt = new Date().toISOString(); }
    });
    return _set(KEYS.PRODUCTS, products);
  }

  // ─── Khata ───────────────────────────────────────────────────────
  function getAllKhata() { return _get(KEYS.KHATA) || []; }
  function saveAllKhata(arr) { return _set(KEYS.KHATA, arr); }
  function getKhataById(id) { return getAllKhata().find(k => k.id === id) || null; }

  function addKhataCustomer(name, phone = '') {
    const khata = getAllKhata();
    const exists = khata.find(k => k.name.toLowerCase() === name.trim().toLowerCase());
    if (exists) return { error: 'Customer already exists', existing: exists };
    const c = {
      id: generateId('cust'), name: name.trim(), phone: phone.trim(),
      balance: 0, transactions: [], createdAt: new Date().toISOString(),
    };
    khata.push(c);
    _set(KEYS.KHATA, khata);
    return c;
  }

  function addKhataTransaction(customerId, type, amount, note = '', billId = null) {
    const khata = getAllKhata();
    const c = khata.find(k => k.id === customerId);
    if (!c) return null;
    const tx = { txId: generateId('tx'), type, amount: parseFloat(amount) || 0, note, billId, date: new Date().toISOString() };
    c.transactions.push(tx);
    if (type === 'baki' || type === 'bill') c.balance += tx.amount;
    else if (type === 'jama' || type === 'settle') c.balance -= tx.amount;
    _set(KEYS.KHATA, khata);
    return tx;
  }

  function deleteKhataCustomer(id) {
    return _set(KEYS.KHATA, getAllKhata().filter(k => k.id !== id));
  }

  // ─── Bills ───────────────────────────────────────────────────────
  function getAllBills() { return _get(KEYS.BILLS_HISTORY) || []; }

  function getNextBillNumber() {
    const bills = getAllBills();
    return bills.length === 0 ? 1 : Math.max(...bills.map(b => b.billNumber || 0)) + 1;
  }

  function saveBill(data) {
    const bills = getAllBills();
    const bill = {
      billId           : generateId('bill'),
      billNumber       : getNextBillNumber(),
      items            : data.items || [],
      subtotal         : parseFloat(data.subtotal) || 0,
      discount         : parseFloat(data.discount) || 0,
      total            : parseFloat(data.total) || 0,
      totalProfit      : parseFloat(data.totalProfit) || 0,
      khataCustomerId  : data.khataCustomerId || null,
      khataCustomerName: data.khataCustomerName || null,
      paymentMode      : data.paymentMode || 'cash',
      generatedAt      : new Date().toISOString(),
    };
    bills.unshift(bill);
    _set(KEYS.BILLS_HISTORY, bills);
    return bill;
  }

  function getBillById(id) { return getAllBills().find(b => b.billId === id) || null; }
  function clearAllBills() { return _remove(KEYS.BILLS_HISTORY); }

  return {
    getSettings, saveSettings,
    getAllProducts, saveAllProducts, getProductById, getAllCompanies,
    addProduct, updateProduct, deleteProduct, deductStock,
    getAllKhata, saveAllKhata, getKhataById, addKhataCustomer,
    addKhataTransaction, deleteKhataCustomer,
    getAllBills, getNextBillNumber, saveBill, getBillById, clearAllBills,
    generateId,
  };
})();
