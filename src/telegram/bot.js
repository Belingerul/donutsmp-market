const { Telegraf, Markup } = require('telegraf');
const db = require('../database/db');
const mcBot = require('../minecraft/bot');

const PRICE_SPAWNER = parseFloat(process.env.PRICE_SPAWNER  || 0.14);
const PRICE_1M      = parseFloat(process.env.PRICE_1M_COINS || 0.04);

function appBtn(label = '📱 Open Market') {
  const url = process.env.WEBAPP_URL;
  if (!url) return {};
  return Markup.inlineKeyboard([[Markup.button.webApp(label, url)]]);
}

function createBot() {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  // ── Middleware: auto-register users ───────────────────────────────────────
  bot.use(async (ctx, next) => {
    if (ctx.from) db.upsertUser(ctx.from.id, ctx.from.username);
    return next();
  });

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start((ctx) => {
    const name = ctx.from.first_name || ctx.from.username || 'there';
    ctx.reply(
      `👋 Hey ${name}! Welcome to *DonutSMP Market*.\n\n` +
      `Turn your skeleton spawners & Donut Money into real cash — paid *instantly* in Solana.\n\n` +
      `💀 Spawner → *$${PRICE_SPAWNER}*\n` +
      `🪙 1M Donut Money → *$${PRICE_1M}*\n\n` +
      `Tap below to open the market 👇`,
      { parse_mode: 'Markdown', ...appBtn('🛒 Open Market') }
    );
  });

  // ── /status ───────────────────────────────────────────────────────────────
  bot.command('status', (ctx) => {
    const s = mcBot.getStatus();
    const statusText = s.connected
      ? (s.busy ? `🔴 Busy (trade #${s.currentOrder})` : '🟢 Online & ready')
      : '⚫ Offline';
    ctx.replyWithMarkdown(
      `🤖 *Bot Status*\n\n` +
      `MC Bot: ${statusText}\n` +
      `Username: \`${s.username || 'N/A'}\``
    );
  });

  // ── /admin ────────────────────────────────────────────────────────────────
  bot.command('admin', (ctx) => {
    if (String(ctx.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) {
      return ctx.reply('❌ Not authorised.');
    }
    const s = mcBot.getStatus();
    const pending = db.getPendingWithdrawals();
    const stats = db.getStats();

    ctx.replyWithMarkdown(
      `🛠 *Admin Panel*\n\n` +
      `MC: ${s.connected ? '🟢' : '⚫'} \`${s.username || 'disconnected'}\`\n` +
      `Busy: ${s.busy ? `Yes (trade #${s.currentOrder})` : 'No'}\n\n` +
      `📊 *Stats*\n` +
      `Users: *${stats.totalUsers}*\n` +
      `Trades: *${stats.totalTrades}*\n` +
      `Volume: *$${stats.totalVolume.toFixed(2)}*\n` +
      `Balances held: *$${stats.totalBalances.toFixed(2)}*\n\n` +
      `Pending withdrawals ready: *${pending.length}*\n\n` +
      `*Commands:*\n` +
      `/adminwithdrawals — List pending payouts\n` +
      `/markpaid id — Mark withdrawal as paid\n` +
      `/rejectwithdraw id reason — Reject and refund\n` +
      `/ban telegramId reason — Ban user\n` +
      `/unban telegramId — Unban user`
    );
  });

  bot.command('adminwithdrawals', (ctx) => {
    if (String(ctx.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
    const list = db.getPendingWithdrawals();
    if (!list.length) return ctx.reply('No pending withdrawals ready for processing.');
    const lines = list.map(w =>
      `#${w.id} · @${w.username || w.telegram_id} · $${w.amount.toFixed(2)} · ${w.method}\n  → ${w.address}`
    );
    ctx.reply(`Pending ready to pay:\n\n${lines.join('\n\n')}`);
  });

  bot.command('markpaid', (ctx) => {
    if (String(ctx.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
    const args = ctx.message.text.split(/\s+/).slice(1);
    const wId = parseInt(args[0]);
    if (!wId) return ctx.reply('Usage: /markpaid id');
    db.updateWithdrawalStatus(wId, 'paid', 'Marked paid by admin');
    const row = require('better-sqlite3')(require('path').join(__dirname, '../../data/market.db'))
      .prepare('SELECT * FROM withdrawals WHERE id = ?').get(wId);
    if (row) {
      const { notify } = require('../transactions/manager');
      notify(row.telegram_id, `✅ *Withdrawal #${wId} has been paid!*\n\n$${row.amount.toFixed(2)} sent via ${row.method} to \`${row.address}\``);
    }
    ctx.reply(`✅ Withdrawal #${wId} marked as paid.`);
  });

  bot.command('rejectwithdraw', (ctx) => {
    if (String(ctx.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
    const args = ctx.message.text.split(/\s+/).slice(1);
    const wId = parseInt(args[0]);
    const reason = args.slice(1).join(' ') || 'Rejected by admin';
    if (!wId) return ctx.reply('Usage: /rejectwithdraw id reason');
    const row = require('better-sqlite3')(require('path').join(__dirname, '../../data/market.db'))
      .prepare('SELECT * FROM withdrawals WHERE id = ?').get(wId);
    if (row) {
      db.updateWithdrawalStatus(wId, 'rejected', reason);
      db.creditBalance(row.telegram_id, row.amount, 'withdrawal_refund', wId, `Refunded: ${reason}`);
      const { notify } = require('../transactions/manager');
      notify(row.telegram_id, `❌ *Withdrawal #${wId} was rejected*\n\nReason: ${reason}\n\n$${row.amount.toFixed(2)} has been refunded to your balance.`);
    }
    ctx.reply(`✅ Withdrawal #${wId} rejected and refunded.`);
  });

  bot.command('ban', (ctx) => {
    if (String(ctx.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
    const args = ctx.message.text.split(/\s+/).slice(1);
    const targetId = parseInt(args[0]);
    const reason = args.slice(1).join(' ') || 'No reason given';
    if (!targetId) return ctx.reply('Usage: /ban telegramId reason');
    db.banUser(targetId, reason);
    ctx.reply(`✅ User ${targetId} banned: ${reason}`);
  });

  bot.command('unban', (ctx) => {
    if (String(ctx.from.id) !== String(process.env.ADMIN_TELEGRAM_ID)) return;
    const args = ctx.message.text.split(/\s+/).slice(1);
    const targetId = parseInt(args[0]);
    if (!targetId) return ctx.reply('Usage: /unban telegramId');
    db.unbanUser(targetId);
    ctx.reply(`✅ User ${targetId} unbanned`);
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.catch((err, ctx) => {
    console.error('[TG] Error for', ctx.updateType, err.message);
    ctx.reply('Something went wrong. Please try again.').catch(() => {});
  });

  return bot;
}

module.exports = { createBot };
