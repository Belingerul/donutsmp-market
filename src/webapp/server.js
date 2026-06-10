const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('../database/db');
const mcBot = require('../minecraft/bot');
const { notifyAdmin } = require('../transactions/manager');

const app = express();
app.use(express.json());

// Never cache the HTML — ensures Telegram WebView always loads the latest app
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const PRICE_SPAWNER = parseFloat(process.env.PRICE_SPAWNER || 0.14);
const MIN_WITHDRAW  = parseFloat(process.env.MIN_WITHDRAW  || 0.1);
const solana = require('../payments/solana');

// ── Telegram WebApp init data verification ─────────────────────────────────
function verifyTelegramData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString).digest('hex');
    return hash === expectedHash;
  } catch { return false; }
}

function getUser(req) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return null;
  if (process.env.NODE_ENV !== 'production' && !verifyTelegramData(initData)) {
    // still parse user for dev
  }
  try {
    const params = new URLSearchParams(initData);
    return JSON.parse(decodeURIComponent(params.get('user')));
  } catch { return null; }
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/api/me', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  db.upsertUser(tgUser.id, tgUser.username);
  const user = db.getUser(tgUser.id);
  if (user?.banned) return res.status(403).json({ error: 'Your account has been banned. Contact support.' });

  res.json({
    telegramId: tgUser.id,
    username: tgUser.username,
    firstName: tgUser.first_name,
    mcUsername: user?.mc_username || null,
    balance: +(user?.balance || 0).toFixed(4),
    totalEarned: +(user?.total_earned || 0).toFixed(4),
    totalTrades: user?.total_trades || 0,
  });
});

app.post('/api/setmc', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const { mcUsername } = req.body;
  const clean = mcUsername?.startsWith('.') ? mcUsername.slice(1) : mcUsername;
  if (!clean || clean.length < 2 || clean.length > 16 || !/^[a-zA-Z0-9_]+$/.test(clean)) {
    return res.status(400).json({ error: 'Invalid Minecraft username (2–16 chars, letters/numbers/underscores, optional leading dot)' });
  }

  db.upsertUser(tgUser.id, tgUser.username);
  try {
    db.setMcUsername(tgUser.id, mcUsername);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sell', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const { quantity } = req.body;
  const qty = parseInt(quantity);
  if (!qty || qty < 1 || qty > 2304) {
    return res.status(400).json({ error: 'Quantity must be 1–2304' });
  }

  db.upsertUser(tgUser.id, tgUser.username);
  const user = db.getUser(tgUser.id);
  if (!user?.mc_username) {
    return res.status(400).json({ error: 'Link your Minecraft username first' });
  }

  const existing = db.getActiveOrder(tgUser.id);
  if (existing) {
    return res.status(400).json({ error: `You already have an active trade (#${existing.id})` });
  }

  if (!mcBot.isReady()) {
    const s = mcBot.getStatus();
    return res.status(503).json({
      error: s.connected ? 'Bot is busy with another trade, try in a moment' : 'Minecraft bot is offline'
    });
  }

  const orderId = db.createOrder(tgUser.id, user.mc_username, qty);

  // Listen for tradeFailed to catch player_offline before the response is sent
  const offlineHandler = ({ orderId: oid, code, reason }) => {
    if (oid !== orderId) return;
    mcBot.off('tradeFailed', offlineHandler);
    if (!res.headersSent) {
      try { db.failOrder(orderId, reason); } catch {}
      if (code === 'player_offline') {
        return res.status(400).json({ error: reason, code: 'player_offline' });
      }
      return res.status(400).json({ error: reason });
    }
  };

  mcBot.once('tradeFailed', offlineHandler);

  try {
    await mcBot.startTrade({ orderId, telegramId: tgUser.id, mcUsername: user.mc_username, quantity: qty });

    // startTrade resolves after sending /tpa — if we haven't failed yet, respond OK
    // Give a short window (3s) so an instant offline reply from the server is caught
    await new Promise(r => setTimeout(r, 3_000));

    if (!res.headersSent) {
      mcBot.off('tradeFailed', offlineHandler);
      res.json({ ok: true, orderId, value: +(qty * PRICE_SPAWNER).toFixed(4) });
    }
  } catch (err) {
    mcBot.off('tradeFailed', offlineHandler);
    if (!res.headersSent) {
      db.failOrder(orderId, err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

app.get('/api/order/:id', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const order = db.getOrder(parseInt(req.params.id));
  if (!order || order.telegram_id !== tgUser.id) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

app.get('/api/orders', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const orders = db.getOrderHistory(tgUser.id, 20);
  res.json(orders);
});

app.get('/api/active-order', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const order = db.getActiveOrder(tgUser.id);
  res.json(order || null);
});

app.post('/api/withdraw', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const { amount, address } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt < MIN_WITHDRAW) {
    return res.status(400).json({ error: `Minimum withdrawal is $${MIN_WITHDRAW}` });
  }

  const addr = address?.trim();
  if (!addr) return res.status(400).json({ error: 'Solana address is required' });
  if (!solana.isValidSolAddress(addr)) {
    return res.status(400).json({ error: 'Invalid Solana wallet address' });
  }

  const user = db.getUser(tgUser.id);
  if (!user || user.balance < amt) {
    return res.status(400).json({ error: `Insufficient balance ($${(user?.balance||0).toFixed(4)} available)` });
  }

  try {
    db.debitBalance(tgUser.id, amt, 'withdrawal_request', null, `SOL withdrawal to ${addr}`);
    const wId = db.createWithdrawal(tgUser.id, amt, 'sol', addr);

    let result;
    try {
      result = await solana.sendSol(addr, amt);
    } catch (sendErr) {
      db.creditBalance(tgUser.id, amt, 'withdrawal_refund', wId, `SOL send failed: ${sendErr.message}`);
      db.updateWithdrawalStatus(wId, 'rejected', sendErr.message);
      notifyAdmin(`❌ SOL withdrawal #${wId} failed (webapp)\n@${tgUser.username || tgUser.id}: $${amt} → ${addr}\nReason: ${sendErr.message}`);
      return res.status(500).json({ error: `SOL transfer failed: ${sendErr.message}` });
    }

    db.updateWithdrawalStatus(wId, 'paid', `txid: ${result.signature}`);
    notifyAdmin(`✅ SOL withdrawal #${wId} sent (webapp)\n@${tgUser.username || tgUser.id}: $${amt} → ${result.solAmount} SOL\nTx: ${result.signature}`);
    res.json({ ok: true, withdrawalId: wId, signature: result.signature, explorerUrl: result.explorerUrl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/withdrawals', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  res.json(db.getWithdrawals(tgUser.id));
});

app.get('/api/bot-status', (req, res) => {
  res.json(mcBot.getStatus());
});

app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

app.get('/api/coin-sales', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  res.json(db.getCoinSaleHistory(tgUser.id, 20));
});

app.get('/api/saved-address', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ address: db.getSavedSolAddress(tgUser.id) });
});

app.post('/api/saved-address', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const addr = req.body.address?.trim();
  if (!addr || !solana.isValidSolAddress(addr)) {
    return res.status(400).json({ error: 'Invalid Solana wallet address' });
  }
  db.setSavedSolAddress(tgUser.id, addr);
  res.json({ ok: true });
});

app.delete('/api/saved-address', (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  db.setSavedSolAddress(tgUser.id, null);
  res.json({ ok: true });
});

app.get('/api/prices', (req, res) => {
  res.json({
    spawner: PRICE_SPAWNER,
    coins1m: parseFloat(process.env.PRICE_1M_COINS || 0.037),
    minWithdraw: MIN_WITHDRAW,
  });
});

// Admin routes
function requireAdmin(req, res, next) {
  const tgUser = getUser(req);
  if (!tgUser || String(tgUser.id) !== String(process.env.ADMIN_TELEGRAM_ID)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

app.get('/api/admin/withdrawals', requireAdmin, (req, res) => {
  res.json(db.getPendingWithdrawals());
});

app.post('/api/admin/withdrawal/:id/paid', requireAdmin, (req, res) => {
  const wId = parseInt(req.params.id);
  const row = db.getDb().prepare('SELECT * FROM withdrawals WHERE id = ?').get(wId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.updateWithdrawalStatus(wId, 'paid', 'Marked paid by admin');
  res.json({ ok: true });
});

app.post('/api/admin/ban/:telegramId', requireAdmin, (req, res) => {
  const { reason } = req.body;
  db.banUser(parseInt(req.params.telegramId), reason || 'Banned by admin');
  res.json({ ok: true });
});

app.post('/api/admin/unban/:telegramId', requireAdmin, (req, res) => {
  db.unbanUser(parseInt(req.params.telegramId));
  res.json({ ok: true });
});

app.post('/api/admin/withdrawal/:id/reject', requireAdmin, (req, res) => {
  const wId = parseInt(req.params.id);
  const { reason } = req.body;
  const row = db.getDb().prepare('SELECT * FROM withdrawals WHERE id = ?').get(wId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.updateWithdrawalStatus(wId, 'rejected', reason || 'Rejected by admin');
  db.creditBalance(row.telegram_id, row.amount, 'withdrawal_refund', wId, `Refunded: ${reason}`);
  res.json({ ok: true });
});

function start(port = 3000) {
  app.listen(port, () => console.log(`✅ Mini App server running on http://localhost:${port}`));
}

module.exports = { start };
