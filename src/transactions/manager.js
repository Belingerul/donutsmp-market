const db    = require('../database/db');
const mcBot = require('../minecraft/bot');

const PRICE_SPAWNER = parseFloat(process.env.PRICE_SPAWNER   || 0.145);
const PRICE_1M      = parseFloat(process.env.PRICE_1M_COINS  || 0.04);

let telegramBot = null;

function init(tgBot) {
  telegramBot = tgBot;

  // ── Trade status updates ──────────────────────────────────────────────────
  mcBot.on('tradeStatus', ({ orderId, status, count }) => {
    const order = db.getOrder(orderId);
    if (!order) return;
    db.updateOrderStatus(orderId, status);
    // Progress is shown in the app — no Telegram messages needed here
  });

  // ── Trade complete ────────────────────────────────────────────────────────
  mcBot.on('tradeComplete', ({ orderId, telegramId, quantity, deposited, killedDuringDeposit }) => {
    const value      = +(quantity * PRICE_SPAWNER).toFixed(4);
    db.completeOrder(orderId, quantity, value);
    db.incrementTradeCount(telegramId);
    const newBalance = db.creditBalance(telegramId, value, 'spawner_sale', orderId, `${quantity}x skeleton spawner sale`);
    const user       = db.getUser(telegramId);

    let msg = `✅ *Trade complete!*\n\n💀 *${quantity}×* skeleton spawner\n💵 Credited: *$${value.toFixed(4)}*\n💰 Balance: *$${newBalance.toFixed(4)}*\n\nOpen the app to withdraw your earnings 👇`;
    if (killedDuringDeposit) msg += `\n\n⚠️ Bot was killed during deposit — amount based on items collected.`;
    else if (!deposited) msg += `\n\n⚠️ Deposit to chest may have failed — check your balance.`;
    notify(telegramId, msg, appBtnMarkup('💳 Withdraw Now'));

    notifyAdmin(
      `✅ Trade #${orderId} · @${user?.username || telegramId}\n` +
      `${quantity}× spawner → $${value.toFixed(4)}` +
      (killedDuringDeposit ? ' ⚠️ killed during deposit' : '') +
      (!deposited ? ' ⚠️ deposit may have failed' : '')
    );
  });

  // ── Trade failed ──────────────────────────────────────────────────────────
  mcBot.on('tradeFailed', ({ orderId, telegramId, reason, code }) => {
    db.failOrder(orderId, reason);
    notify(telegramId, `❌ *Trade #${orderId} cancelled*`, appBtnMarkup('🛒 Open Market'));
    notifyAdmin(`❌ Trade #${orderId} failed: ${reason}`);
  });

  // ── Coin payment ──────────────────────────────────────────────────────────
  mcBot.on('coinPayment', ({ senderName, coinsAmount }) => {
    const user = db.getUserByMcUsername(senderName);
    if (!user) {
      console.log(`[TX] Coin payment from ${senderName} — no linked account`);
      notifyAdmin(`🪙 Coin payment from *${senderName}* (${fmtCoins(coinsAmount)}) — ⚠️ no linked Telegram account found`);
      return;
    }

    if (user.banned) {
      console.log(`[TX] Coin payment from banned user ${senderName} — ignoring`);
      return;
    }

    const valueUsd = +((coinsAmount / 1_000_000) * PRICE_1M).toFixed(6);
    if (valueUsd < 0.0001) {
      console.log(`[TX] Coin payment too small: ${fmtCoins(coinsAmount)} = $${valueUsd}`);
      return;
    }

    const saleId     = db.recordCoinSale(user.telegram_id, senderName, coinsAmount, valueUsd);
    const newBalance = db.creditBalance(user.telegram_id, valueUsd, 'coin_sale', saleId, `${fmtCoins(coinsAmount)} coins sold`);

    notify(user.telegram_id,
      `🪙 *Coins received!*\n\n📊 *${fmtCoins(coinsAmount)}* coins\n💵 Credited: *$${valueUsd.toFixed(6)}*\n💰 Balance: *$${newBalance.toFixed(4)}*\n\nOpen the app to withdraw 👇`,
      appBtnMarkup('💳 Withdraw Now')
    );

    notifyAdmin(`🪙 Coin sale #${saleId}\n👤 @${user.username || user.telegram_id} (${senderName})\n📊 ${fmtCoins(coinsAmount)} → 💵 $${valueUsd.toFixed(6)}`);
    console.log(`[TX] Coin sale: ${senderName} → $${valueUsd} credited to ${user.telegram_id}`);
  });

  // ── Connection events ─────────────────────────────────────────────────────
  mcBot.on('disconnected', (reason) => {
    notifyAdmin(`🔌 MC bot disconnected: ${reason}`);
  });

  mcBot.on('ready', () => {
    notifyAdmin(`🟢 MC bot connected as ${mcBot.bot?.username}`);

    // Fail any orders that were in-flight when the bot was last killed
    const orphaned = db.getOrphanedOrders();
    for (const o of orphaned) {
      db.failOrder(o.id, 'Bot restarted — trade was interrupted');
      notify(o.telegram_id, `❌ *Trade #${o.id} cancelled*`, appBtnMarkup('🛒 Open Market'));
      notifyAdmin(`⚠️ Orphaned trade #${o.id} auto-failed on reconnect`);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCoins(n) {
  if (n >= 1e12) return `${(n/1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3)  return `${(n/1e3).toFixed(2)}K`;
  return n.toString();
}

function appBtnMarkup(label = '📱 Open Market') {
  const url = process.env.WEBAPP_URL;
  if (!url) return {};
  return { reply_markup: { inline_keyboard: [[{ text: label, web_app: { url } }]] } };
}

function notify(telegramId, message, extra = {}) {
  if (!telegramBot) return;
  telegramBot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown', ...extra })
    .catch(e => console.error('[TG notify error]', e.message));
}

function notifyAdmin(message, attempt = 1) {
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminId || !telegramBot) return;
  telegramBot.telegram.sendMessage(adminId, message)
    .catch(e => {
      if (attempt < 4) {
        setTimeout(() => notifyAdmin(message, attempt + 1), 3000 * attempt);
      } else {
        console.error('[TG admin notify error]', e.message);
      }
    });
}

module.exports = { init, notify, notifyAdmin };
