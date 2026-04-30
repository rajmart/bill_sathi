/**
 * storage.js
 * All localStorage read/write for the Smart Cashier app.
 * Every other JS file uses these functions — never touches localStorage directly.
 *
 * Keys used:
 *   sc_settings      → shop settings object
 *   sc_products      → array of product objects
 *   sc_khata         → array of khata customer objects
 *   sc_bills_history → array of past bill objects
 */

'use strict';

const Storage = (() => {

  // ─── Key Constants ───────────────────────────────────────────────
  const KEYS = {
    SETTINGS     : 'sc_settings',
    PRODUCTS     : 'sc_products',
    KHATA        : 'sc_khata',
    BILLS_HISTORY: 'sc_bills_history',
  };

  // ─── Generic Helpers ─────────────────────────────────────────────

  /** Read and parse a JSON value from localStorage. Returns null on failure. */
  function _get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error(`[Storage] Read error for key "${key}":`, e);
      return null;
    }
  }

  /** Stringify and write a value to localStorage. Returns true on success. */
  function _set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error(`[Storage] Write error for key "${key}":`, e);
      return false;
    }
  }

  /** Remove a key from localStorage. */
  function _remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.error(`[Storage] Remove error for key "${key}":`, e);
      return false;
    }
  }

  // ─── ID Generator ────────────────────────────────────────────────

  /** Generate a simple unique ID: prefix + timestamp + random suffix */
  function generateId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SETTINGS
  // ═══════════════════════════════════════════════════════════════════

  const DEFAULT_SETTINGS = {
    shopName   : 'Smart Cashier',
    shopAddress: '',
    shopPhone  : '',
    voiceLang  : 'hi-IN',
    currency   : '₹',
  };

  function getSettings() {
    const saved = _get(KEYS.SETTINGS);
    return saved ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS };
  }

  function saveSettings(settingsObj) {
    const merged = { ...DEFAULT_SETTINGS, ...settingsObj };
    return _set(KEYS.SETTINGS, merged);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  PRODUCTS
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Product object shape:
   * {
   *   id        : string,
   *   name      : string,
   *   aliases   : string[],   // alternate voice match names
   *   sellPrice : number,
   *   costPrice : number,
   *   unit      : string,     // 'pcs' | 'kg' | 'g' | 'ltr' | 'ml' | 'pkt' | 'dozen'
   *   stock     : number,
   *   createdAt : ISO string,
   *   updatedAt : ISO string,
   * }
   */

  function getAllProducts() {
    return _get(KEYS.PRODUCTS) || [];
  }

  function saveAllProducts(productsArray) {
    return _set(KEYS.PRODUCTS, productsArray);
  }

  function getProductById(id) {
    return getAllProducts().find(p => p.id === id) || null;
  }

  function addProduct(productData) {
    const products = getAllProducts();
    const newProduct = {
      id        : generateId('prod'),
      name      : productData.name.trim(),
      aliases   : Array.isArray(productData.aliases) ? productData.aliases : [],
      sellPrice : parseFloat(productData.sellPrice) || 0,
      costPrice : parseFloat(productData.costPrice) || 0,
      unit      : productData.unit || 'pcs',
      stock     : parseInt(productData.stock) || 0,
      createdAt : new Date().toISOString(),
      updatedAt : new Date().toISOString(),
    };
    products.push(newProduct);
    _set(KEYS.PRODUCTS, products);
    return newProduct;
  }

  function updateProduct(id, updatedData) {
    const products = getAllProducts();
    const index = products.findIndex(p => p.id === id);
    if (index === -1) return null;

    products[index] = {
      ...products[index],
      ...updatedData,
      id       : id,                       // never overwrite id
      updatedAt: new Date().toISOString(),
    };
    _set(KEYS.PRODUCTS, products);
    return products[index];
  }

  function deleteProduct(id) {
    const products = getAllProducts().filter(p => p.id !== id);
    return _set(KEYS.PRODUCTS, products);
  }

  /** Reduce stock after a sale. Pass itemsArray = [{productId, qty}] */
  function deductStock(itemsArray) {
    const products = getAllProducts();
    itemsArray.forEach(({ productId, qty }) => {
      const p = products.find(p => p.id === productId);
      if (p && p.stock > 0) {
        p.stock = Math.max(0, p.stock - qty);
        p.updatedAt = new Date().toISOString();
      }
    });
    return _set(KEYS.PRODUCTS, products);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  KHATA (Customer Ledger)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Khata customer object shape:
   * {
   *   id          : string,
   *   name        : string,
   *   phone       : string,
   *   balance     : number,   // positive = baki (owes you), negative = jama (advance paid)
   *   transactions: [
   *     {
   *       txId     : string,
   *       type     : 'baki' | 'jama' | 'bill' | 'settle',
   *       amount   : number,
   *       note     : string,
   *       billId   : string | null,
   *       date     : ISO string,
   *     }
   *   ],
   *   createdAt   : ISO string,
   * }
   */

  function getAllKhata() {
    return _get(KEYS.KHATA) || [];
  }

  function saveAllKhata(khataArray) {
    return _set(KEYS.KHATA, khataArray);
  }

  function getKhataById(id) {
    return getAllKhata().find(k => k.id === id) || null;
  }

  function addKhataCustomer(name, phone = '') {
    const khata = getAllKhata();

    // Prevent duplicates by name (case-insensitive)
    const exists = khata.find(k => k.name.toLowerCase() === name.trim().toLowerCase());
    if (exists) return { error: 'Customer already exists', existing: exists };

    const newCustomer = {
      id          : generateId('cust'),
      name        : name.trim(),
      phone       : phone.trim(),
      balance     : 0,
      transactions: [],
      createdAt   : new Date().toISOString(),
    };
    khata.push(newCustomer);
    _set(KEYS.KHATA, khata);
    return newCustomer;
  }

  /**
   * Add a transaction to a khata customer and update their balance.
   * type: 'baki' → they owe more (balance += amount)
   * type: 'jama' → they paid in advance (balance -= amount)
   * type: 'bill' → bill was linked to their khata (balance += amount)
   * type: 'settle'→ they settled outstanding amount (balance -= amount)
   */
  function addKhataTransaction(customerId, type, amount, note = '', billId = null) {
    const khata = getAllKhata();
    const customer = khata.find(k => k.id === customerId);
    if (!customer) return null;

    const tx = {
      txId  : generateId('tx'),
      type,
      amount: parseFloat(amount) || 0,
      note,
      billId,
      date  : new Date().toISOString(),
    };

    customer.transactions.push(tx);

    // Update balance
    if (type === 'baki' || type === 'bill') {
      customer.balance += tx.amount;
    } else if (type === 'jama' || type === 'settle') {
      customer.balance -= tx.amount;
    }

    _set(KEYS.KHATA, khata);
    return tx;
  }

  function deleteKhataCustomer(id) {
    const khata = getAllKhata().filter(k => k.id !== id);
    return _set(KEYS.KHATA, khata);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  BILLS HISTORY
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Bill object shape:
   * {
   *   billId      : string,
   *   billNumber  : number,     // auto-incremented display number
   *   items       : [{ productId, name, qty, sellPrice, costPrice, unit, lineTotal, lineProfit }],
   *   subtotal    : number,
   *   discount    : number,
   *   total       : number,
   *   totalProfit : number,
   *   khataCustomerId : string | null,
   *   khataCustomerName: string | null,
   *   paymentMode : string,     // 'cash' | 'upi' | 'baki'
   *   generatedAt : ISO string,
   * }
   */

  function getAllBills() {
    return _get(KEYS.BILLS_HISTORY) || [];
  }

  function getNextBillNumber() {
    const bills = getAllBills();
    if (bills.length === 0) return 1;
    return Math.max(...bills.map(b => b.billNumber || 0)) + 1;
  }

  function saveBill(billData) {
    const bills = getAllBills();
    const newBill = {
      billId           : generateId('bill'),
      billNumber       : getNextBillNumber(),
      items            : billData.items || [],
      subtotal         : parseFloat(billData.subtotal) || 0,
      discount         : parseFloat(billData.discount) || 0,
      total            : parseFloat(billData.total) || 0,
      totalProfit      : parseFloat(billData.totalProfit) || 0,
      khataCustomerId  : billData.khataCustomerId || null,
      khataCustomerName: billData.khataCustomerName || null,
      paymentMode      : billData.paymentMode || 'cash',
      generatedAt      : new Date().toISOString(),
    };
    bills.unshift(newBill); // newest first
    _set(KEYS.BILLS_HISTORY, bills);
    return newBill;
  }

  function getBillById(billId) {
    return getAllBills().find(b => b.billId === billId) || null;
  }

  function clearAllBills() {
    return _remove(KEYS.BILLS_HISTORY);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  EXPORT
  // ═══════════════════════════════════════════════════════════════════

  return {
    // Settings
    getSettings,
    saveSettings,

    // Products
    getAllProducts,
    saveAllProducts,
    getProductById,
    addProduct,
    updateProduct,
    deleteProduct,
    deductStock,

    // Khata
    getAllKhata,
    saveAllKhata,
    getKhataById,
    addKhataCustomer,
    addKhataTransaction,
    deleteKhataCustomer,

    // Bills
    getAllBills,
    getNextBillNumber,
    saveBill,
    getBillById,
    clearAllBills,

    // Utils
    generateId,
  };

})();
