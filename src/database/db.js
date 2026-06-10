const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/market.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
    runMigrations();
  }
  return db;
}

function runMigrations() {
  // Add columns that may not exist in older DBs
  const migrations = [
    "ALTER TABLE users ADD COLUMN total_trades INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN saved_sol_address TEXT",
    "ALTER TABLE orders ADD COLUMN fail_reason TEXT",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch {} // ignore if column already exists
  }
  console.log('[DB] Migrations complete');
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id   INTEGER PRIMARY KEY,
      username      TEXT,
      mc_username   TEXT UNIQUE,        -- one MC account per Telegram user, enforced at DB level
      balance       REAL DEFAULT 0,
      total_earned  REAL DEFAULT 0,
      total_trades  INTEGER DEFAULT 0,
      banned        INTEGER DEFAULT 0,  -- 1 = banned
      created_at    INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id   INTEGER NOT NULL,
      mc_username   TEXT NOT NULL,
      item_type     TEXT NOT NULL DEFAULT 'skeleton_spawner',
      quantity_req  INTEGER NOT NULL,
      quantity_recv INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'pending',
      -- pending → tpa_sent → dropping → counting → homing → depositing → complete → failed
      value_usd     REAL DEFAULT 0,
      created_at    INTEGER DEFAULT (strftime('%s','now')),
      completed_at  INTEGER,
      FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id   INTEGER NOT NULL,
      amount        REAL NOT NULL,
      method        TEXT NOT NULL,
      address       TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      -- pending → processing → paid → rejected
      requested_at  INTEGER DEFAULT (strftime('%s','now')),
      available_at  INTEGER,
      paid_at       INTEGER,
      notes         TEXT,
      FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS coin_sales (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id   INTEGER NOT NULL,
      mc_username   TEXT NOT NULL,
      coins_amount  REAL NOT NULL,
      value_usd     REAL NOT NULL,
      created_at    INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id   INTEGER NOT NULL,
      type          TEXT NOT NULL,
      amount        REAL NOT NULL,
      balance_after REAL NOT NULL,
      ref_id        INTEGER,
      note          TEXT,
      created_at    INTEGER DEFAULT (strftime('%s','now'))
    );

  `);
}

// ── Users ─────────────────────────────────────────────────────────────────────

function upsertUser(telegramId, username) {
  const db = getDb();
  db.prepare(`
    INSERT INTO users (telegram_id, username) VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username
  `).run(telegramId, username || null);
}

function getUser(telegramId) {
  return getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

function setMcUsername(telegramId, mcUsername) {
  const db = getDb();
  // Check if this MC username is already linked to a different account
  // Case-insensitive check — Gudsteven and gudsteven are the same account
  const existing = db.prepare('SELECT telegram_id FROM users WHERE LOWER(mc_username) = LOWER(?) AND telegram_id != ?')
    .get(mcUsername, telegramId);
  if (existing) {
    throw new Error(`${mcUsername} is already linked to another account`);
  }
  db.prepare('UPDATE users SET mc_username = ? WHERE telegram_id = ?').run(mcUsername, telegramId);
}

const EARNING_TYPES = new Set(['spawner_sale', 'coin_sale']);

function creditBalance(telegramId, amount, type, refId, note) {
  const db = getDb();
  const isEarning = EARNING_TYPES.has(type);
  const addCredit = db.transaction(() => {
    if (isEarning) {
      db.prepare('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE telegram_id = ?')
        .run(amount, amount, telegramId);
    } else {
      db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?')
        .run(amount, telegramId);
    }
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(telegramId);
    db.prepare('INSERT INTO transactions (telegram_id, type, amount, balance_after, ref_id, note) VALUES (?,?,?,?,?,?)')
      .run(telegramId, type, amount, user.balance, refId || null, note || null);
    return user.balance;
  });
  return addCredit();
}

function debitBalance(telegramId, amount, type, refId, note) {
  const db = getDb();
  const doDebit = db.transaction(() => {
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(telegramId);
    if (!user || user.balance < amount) throw new Error('Insufficient balance');
    db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(amount, telegramId);
    const updated = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(telegramId);
    db.prepare('INSERT INTO transactions (telegram_id, type, amount, balance_after, ref_id, note) VALUES (?,?,?,?,?,?)')
      .run(telegramId, type, -amount, updated.balance, refId || null, note || null);
    return updated.balance;
  });
  return doDebit();
}

// ── Orders ────────────────────────────────────────────────────────────────────

function createOrder(telegramId, mcUsername, quantity, itemType = 'skeleton_spawner') {
  const result = getDb().prepare(`
    INSERT INTO orders (telegram_id, mc_username, quantity_req, item_type)
    VALUES (?, ?, ?, ?)
  `).run(telegramId, mcUsername, quantity, itemType);
  return result.lastInsertRowid;
}

function updateOrderStatus(orderId, status) {
  getDb().prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
}

function completeOrder(orderId, quantityReceived, valueUsd) {
  getDb().prepare(`
    UPDATE orders SET status = 'complete', quantity_recv = ?, value_usd = ?,
    completed_at = strftime('%s','now') WHERE id = ?
  `).run(quantityReceived, valueUsd, orderId);
}

function failOrder(orderId, reason) {
  getDb().prepare(`UPDATE orders SET status = 'failed', fail_reason = ? WHERE id = ?`).run(reason || null, orderId);
}

function getOrder(orderId) {
  return getDb().prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function getActiveOrder(telegramId) {
  return getDb().prepare(`
    SELECT * FROM orders WHERE telegram_id = ? AND status NOT IN ('complete','failed')
    ORDER BY created_at DESC LIMIT 1
  `).get(telegramId);
}

function getOrderHistory(telegramId, limit = 10) {
  return getDb().prepare(`
    SELECT * FROM orders WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(telegramId, limit);
}

// ── Withdrawals ───────────────────────────────────────────────────────────────

function createWithdrawal(telegramId, amount, method, address) {
  const holdDays = parseInt(process.env.WITHDRAW_HOLD_DAYS || 0);
  const availableAt = Math.floor(Date.now() / 1000) + holdDays * 86400;
  const result = getDb().prepare(`
    INSERT INTO withdrawals (telegram_id, amount, method, address, available_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(telegramId, amount, method, address, availableAt);
  return result.lastInsertRowid;
}

function getPendingWithdrawals() {
  return getDb().prepare(`
    SELECT w.*, u.username FROM withdrawals w
    JOIN users u ON u.telegram_id = w.telegram_id
    WHERE w.status = 'pending' AND w.available_at <= strftime('%s','now')
    ORDER BY w.requested_at ASC
  `).all();
}

function updateWithdrawalStatus(withdrawalId, status, notes) {
  getDb().prepare('UPDATE withdrawals SET status = ?, notes = ? WHERE id = ?')
    .run(status, notes || null, withdrawalId);
  if (status === 'paid') {
    getDb().prepare("UPDATE withdrawals SET paid_at = strftime('%s','now') WHERE id = ?")
      .run(withdrawalId);
  }
}

function getWithdrawals(telegramId) {
  return getDb().prepare(`
    SELECT * FROM withdrawals WHERE telegram_id = ? ORDER BY requested_at DESC LIMIT 20
  `).all(telegramId);
}

function recordCoinSale(telegramId, mcUsername, coinsAmount, valueUsd) {
  const result = getDb().prepare(`
    INSERT INTO coin_sales (telegram_id, mc_username, coins_amount, value_usd)
    VALUES (?, ?, ?, ?)
  `).run(telegramId, mcUsername, coinsAmount, valueUsd);
  return result.lastInsertRowid;
}

function getCoinSaleHistory(telegramId, limit = 20) {
  return getDb().prepare(`
    SELECT * FROM coin_sales WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(telegramId, limit);
}

function getUserByMcUsername(mcUsername) {
  return getDb().prepare('SELECT * FROM users WHERE LOWER(mc_username) = LOWER(?)').get(mcUsername);
}

function banUser(telegramId, reason) {
  getDb().prepare('UPDATE users SET banned = 1 WHERE telegram_id = ?').run(telegramId);
  console.log(`[DB] Banned user ${telegramId}: ${reason}`);
}

function unbanUser(telegramId) {
  getDb().prepare('UPDATE users SET banned = 0 WHERE telegram_id = ?').run(telegramId);
}

function isUserBanned(telegramId) {
  const user = getDb().prepare('SELECT banned FROM users WHERE telegram_id = ?').get(telegramId);
  return user?.banned === 1;
}

function incrementTradeCount(telegramId) {
  getDb().prepare('UPDATE users SET total_trades = total_trades + 1 WHERE telegram_id = ?').run(telegramId);
}

// Fix total_trades for all users based on actual completed orders (run once on startup)
function syncTradeCounts() {
  const db = getDb();
  const users = db.prepare('SELECT telegram_id FROM users').all();
  for (const u of users) {
    const count = db.prepare("SELECT COUNT(*) as c FROM orders WHERE telegram_id = ? AND status = 'complete'").get(u.telegram_id).c;
    db.prepare('UPDATE users SET total_trades = ? WHERE telegram_id = ?').run(count, u.telegram_id);
  }
  console.log('[DB] Trade counts synced');
}

function getSavedSolAddress(telegramId) {
  const row = getDb().prepare('SELECT saved_sol_address FROM users WHERE telegram_id = ?').get(telegramId);
  return row?.saved_sol_address || null;
}

function setSavedSolAddress(telegramId, address) {
  getDb().prepare('UPDATE users SET saved_sol_address = ? WHERE telegram_id = ?').run(address || null, telegramId);
}


function getOrphanedOrders() {
  // Orders stuck in an active state — bot was restarted before they could complete/fail
  return getDb().prepare(`
    SELECT * FROM orders WHERE status NOT IN ('pending', 'complete', 'failed')
  `).all();
}

function getStats() {
  const db = getDb();
  return {
    totalUsers:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    totalTrades:   db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'complete'").get().c,
    totalVolume:   db.prepare("SELECT COALESCE(SUM(value_usd),0) as v FROM orders WHERE status = 'complete'").get().v,
    pendingWithdrawals: db.prepare("SELECT COUNT(*) as c FROM withdrawals WHERE status = 'pending'").get().c,
    totalBalances: db.prepare('SELECT COALESCE(SUM(balance),0) as v FROM users').get().v,
  };
}

// Auto-backup: copy DB file every 6 hours
function startAutoBackup() {
  const fs = require('fs');
  const backupDir = require('path').join(__dirname, '../../data/backups');
  fs.mkdirSync(backupDir, { recursive: true });

  function doBackup() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = require('path').join(backupDir, `market-${ts}.db`);
    try {
      fs.copyFileSync(DB_PATH, dest);
      console.log(`[DB] Backup saved: ${dest}`);
      // Keep only last 24 backups
      const files = fs.readdirSync(backupDir)
        .filter(f => f.endsWith('.db'))
        .sort();
      while (files.length > 24) {
        fs.unlinkSync(require('path').join(backupDir, files.shift()));
      }
    } catch (e) {
      console.error('[DB] Backup failed:', e.message);
    }
  }

  doBackup(); // immediate backup on start
  setInterval(doBackup, 6 * 60 * 60 * 1000); // every 6 hours
}

module.exports = {
  getDb, upsertUser, getUser, setMcUsername,
  creditBalance, debitBalance,
  createOrder, updateOrderStatus, completeOrder, failOrder,
  getOrder, getActiveOrder, getOrderHistory,
  createWithdrawal, getPendingWithdrawals, updateWithdrawalStatus, getWithdrawals,
  banUser, unbanUser, isUserBanned, incrementTradeCount, getStats,
  startAutoBackup,
  recordCoinSale, getCoinSaleHistory, getUserByMcUsername,
  syncTradeCounts,
  getSavedSolAddress, setSavedSolAddress,
  getOrphanedOrders,
};
