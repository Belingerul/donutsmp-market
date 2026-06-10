// ── Force IPv4 DNS — Node v17+ prefers IPv6 which may be unreachable ──────────
require('dns').setDefaultResultOrder('ipv4first');

// ── Global crash prevention ───────────────────────────────────────────────────
// Must be at the very top — catches anything that slips through
process.on('uncaughtException', (err) => {
  console.error('[CRASH PREVENTED] Unhandled exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH PREVENTED] Unhandled rejection:', reason?.message || reason);
});

require('dotenv').config();

const { createBot } = require('./telegram/bot');
const mcBot         = require('./minecraft/bot');
const txManager     = require('./transactions/manager');
const webapp        = require('./webapp/server');

const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'MC_USERNAME'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing required env vars:', missing.join(', '));
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connectTelegram(maxAttempts = 8) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const bot = createBot();
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      bot.launch({ dropPendingUpdates: true });
      console.log(`✅ Telegram bot running (attempt ${attempt})`);
      return bot;
    } catch (err) {
      const wait = Math.min(3000 * attempt, 15000);
      console.error(`⚠️  Telegram attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        console.log(`   Retrying in ${wait / 1000}s…`);
        await sleep(wait);
      }
    }
  }
  return null;
}

async function main() {
  console.log('🚀 Starting DonutSMP Spawner Market...');

  webapp.start(3000);

  const dbModule = require('./database/db');
  dbModule.startAutoBackup();
  dbModule.syncTradeCounts();

  console.log('⏳ Connecting to Telegram…');
  const tgBot = await connectTelegram();

  if (tgBot) {
    txManager.init(tgBot);
  } else {
    console.error('❌ Telegram bot could not connect — webapp is still running, will not send notifications.');
  }

  console.log('⏳ Connecting Minecraft bot...');
  try {
    mcBot.connect();
    console.log('⏳ Minecraft bot connecting — check terminal for Microsoft login link if first run...');
  } catch (err) {
    console.error('❌ Minecraft bot error:', err.message);
  }

  if (tgBot) {
    process.once('SIGINT',  () => { tgBot.stop('SIGINT');  mcBot.bot?.end(); });
    process.once('SIGTERM', () => { tgBot.stop('SIGTERM'); mcBot.bot?.end(); });
  } else {
    process.once('SIGINT',  () => { mcBot.bot?.end(); process.exit(0); });
    process.once('SIGTERM', () => { mcBot.bot?.end(); process.exit(0); });
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
