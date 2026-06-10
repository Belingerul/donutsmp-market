const mineflayer = require('mineflayer');
const { EventEmitter } = require('events');

// ── Constants ────────────────────────────────────────────────────────────────

const COMBAT_TAG_MS      = 21_000;
const HOME_RETRY_JITTER  = [5_000, 7_000];
const MAX_HOME_ATTEMPTS  = 5;
const COMBAT_GIVE_UP_MS  = 120_000;

function randBetween(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

class MinecraftBot extends EventEmitter {
  constructor() {
    super();
    this.bot          = null;
    this.connected    = false;
    this.busy         = false;
    this.currentOrder = null;

    this._reconnectTimer     = null;
    this._reconnectAttempts  = 0;
    this._tpaTimer           = null;
    this._dropTimer          = null;

    this._pickedUpSpawners   = 0;
    this._goingHome          = false;
    this._depositing         = false;
    this._depositScheduled   = false;
    this._throwingBack       = false;
    this._isDead             = false;
    this._inventoryPollTimer = null;
    this._lastHealth         = null;

    this._rh = null;
  }

  // ── Connection ───────────────────────────────────────────────────────────────

  connect() {
    // On the very first connect attempt after startup, give Mojang's session
    // server 20 s to clear any lingering session from a previous abrupt kill.
    // Subsequent reconnects use _scheduleReconnect which handles its own delay.
    if (this._reconnectAttempts === 0) {
      const STARTUP_DELAY = parseInt(process.env.MC_STARTUP_DELAY_MS || 20_000);
      if (STARTUP_DELAY > 0) {
        console.log(`[MC] Waiting ${STARTUP_DELAY / 1000}s before first connect (session clearance)…`);
        this._reconnectAttempts = -1; // prevent re-entering this branch on reconnect
        setTimeout(() => this.connect(), STARTUP_DELAY);
        return;
      }
    }

    console.log('[MC] Connecting to', process.env.MC_SERVER);

    this.bot = mineflayer.createBot({
      host    : process.env.MC_SERVER  || 'donutsmp.net',
      port    : parseInt(process.env.MC_PORT || 25565),
      username: process.env.MC_USERNAME,
      version : process.env.MC_VERSION || '1.20.1',
      auth    : 'microsoft',
    });

    this.bot.once('spawn', () => {
      this.connected         = true;
      this._reconnectAttempts = 0; // reset backoff on successful connection
      this._lastHealth = this.bot.health;
      console.log('[MC] Bot spawned as', this.bot.username);

      this.bot.inventory.on('windowUpdate', (slot, oldItem, newItem) => {
        if (this.currentOrder) {
          this._handleItemPickup();
        } else if (newItem && !this._goingHome && !this._depositing) {
          // Item landed in a slot — throw it back if it's junk
          this._throwBackJunk();
        }
      });

      this.emit('ready');
      this._returnHomeAfterSpawn();
    });

    this.bot.on('chat', (username, message) => {
      this._handleChat(username, message);
    });

    this.bot.on('playerCollect', (collector) => {
      if (collector.username !== this.bot.username) return;
      if (this.currentOrder) {
        this._handleItemPickup();
      } else if (!this._goingHome && !this._depositing) {
        this._throwBackJunk();
      }
    });

    this.bot.on('death', () => {
      console.log('[MC] Bot died (death event)');
      this._isDead = false;
      this._onBotDeath();
    });

    this.bot.on('health', () => {
      const hp = this.bot.health;
      this._onHealthChange(hp);
      if (hp <= 0 && !this._isDead) {
        console.log('[MC] Health 0 detected');
        this._onBotDeath();
      } else if (hp > 0) {
        this._isDead = false;
      }
    });

    this.bot.on('message', (jsonMsg) => {
      const text  = jsonMsg.toString();
      const lower = text.toLowerCase();

      if (
        (lower.includes('died') || lower.includes('killed') || lower.includes('slain')) &&
        !this._isDead && this.currentOrder
      ) {
        this._onBotDeath();
      }

      this._handleSystemMessage(text, lower);
    });

    // ── FIX: suppress the error event so it never becomes an unhandled fatal ──
    // The keepalive timeout from mineflayer emits 'error' which Node.js turns
    // into a crash if nothing is listening. We just log it and let the 'end'
    // event handle the reconnect normally.
    this.bot.on('error', (err) => {
      console.error('[MC] Error (suppressed, will reconnect):', err?.message || err);
      // intentionally NOT calling this.emit('error', err)
    });

    this.bot.on('end', (reason) => {
      console.log('[MC] Disconnected:', reason);
      this.connected = false;
      this.emit('disconnected', reason);
      this._scheduleReconnect();
    });

    this.bot.on('kicked', (reason) => {
      console.log('[MC] Kicked:', reason);
      this.connected = false;
      // "Already online" means DonutSMP hasn't expired the previous session yet.
      // Bump the attempt counter so backoff gives ~90s before the next try.
      if (typeof reason === 'string' && reason.toLowerCase().includes('already online')) {
        console.log('[MC] "Already online" kick — waiting 90s for session to expire…');
        this._reconnectAttempts = Math.max(this._reconnectAttempts, 2);
      }
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    // Clear any stale home-run state from the previous session so it doesn't
    // block the home attempt that fires after the next spawn.
    if (this._rh) {
      clearTimeout(this._rh.retryTimer);
      this._rh = null;
      this._goingHome = false;
    }

    // Exponential backoff: 30 s → 60 s → 120 s → 120 s (cap)
    // encryptionLoginError means Mojang rejected the session join — wait longer
    // before hammering their session server again.
    this._reconnectAttempts = Math.max(0, (this._reconnectAttempts || 0)) + 1;
    const BASE = 30_000;
    const delay = Math.min(BASE * Math.pow(2, this._reconnectAttempts - 1), 120_000);
    console.log(`[MC] Reconnecting in ${delay / 1000}s… (attempt ${this._reconnectAttempts})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ── Trade flow ───────────────────────────────────────────────────────────────

  async startTrade(order) {
    if (this.busy)       throw new Error('Bot is currently handling another trade');
    if (!this.connected) throw new Error('Bot is not connected');

    this.busy              = true;
    this.currentOrder      = order;
    this._pickedUpSpawners = 0;

    console.log(`[MC] Starting trade #${order.orderId} with ${order.mcUsername} for ${order.quantity} spawners`);
    this.emit('tradeStatus', { orderId: order.orderId, status: 'tpa_sent' });

    await this._chat(`/tpa ${order.mcUsername}`);

    this._tpaTimer = setTimeout(() => {
      if (this.currentOrder?.orderId === order.orderId) {
        console.log('[MC] TPA timeout — aborting trade');
        this._abortTrade('TPA not accepted in time');
      }
    }, 30_000);
  }

  _handleSystemMessage(text, lower) {
    // ── Coin payments (no active trade needed) ────────────────────────────────
    const coinPayment = this._parseCoinPayment(text);
    if (coinPayment) {
      this.emit('coinPayment', coinPayment);
      return;
    }

    // ── Home arrival / combat block — checked BEFORE currentOrder guard ───────
    if (this._rh && !this._rh.arrived && !this._rh.escaping) {
      if (this._isHomeArrivalMessage(lower)) {
        console.log('[MC] Home arrival confirmed:', text);
        this._onHomeArrival();
        return;
      }
      if (this._isCombatBlockMessage(lower)) {
        console.log('[MC] Combat block on /home:', text);
        this._onHomeCombatBlock();
        return;
      }
    }

    if (!this.currentOrder) return;

    console.log('[MC] System msg:', text);

    // ── Seller offline ────────────────────────────────────────────────────────
    const offlinePhrases = [
      'is not online', 'user is not online', 'player is not online',
      'player not found', 'no player found', 'that player is not online',
      'cannot find player', 'could not find player',
    ];
    if (offlinePhrases.some(p => lower.includes(p))) {
      clearTimeout(this._tpaTimer);
      console.log('[MC] Seller offline — aborting instantly');
      this.emit('tradeFailed', {
        orderId   : this.currentOrder.orderId,
        telegramId: this.currentOrder.telegramId,
        reason    : `${this.currentOrder.mcUsername} is not online on DonutSMP right now.`,
        code      : 'player_offline',
      });
      this._resetTradeState();
      return;
    }

    // ── TPA accepted ──────────────────────────────────────────────────────────
    if (
      lower.includes('accepted this tpa')   ||
      lower.includes('accepted your tpa')   ||
      lower.includes('tpa accepted')        ||
      (lower.includes('teleport') && lower.includes('accept'))
    ) {
      clearTimeout(this._tpaTimer);
      console.log('[MC] TPA accepted — waiting for item drop…');
      this.emit('tradeStatus', { orderId: this.currentOrder.orderId, status: 'dropping' });
      this._startInventoryPoller();

      this._dropTimer = setTimeout(() => {
        if (!this.currentOrder) return;
        clearInterval(this._inventoryPollTimer);
        const got = this._pickedUpSpawners;

        if (got > 0) {
          console.log(`[MC] Drop window ended — got ${got} spawner(s), heading home`);
          this._startReturnHome({ reason: 'trade' });
        } else {
          this.emit('tradeFailed', {
            orderId   : this.currentOrder.orderId,
            telegramId: this.currentOrder.telegramId,
            reason    : 'No items received in time',
          });
          this._resetTradeState();
          this._startReturnHome({ reason: 'abort' });
        }
      }, 120_000);
    }
  }

  _handleChat(username, message) {
    if (username === this.bot.username) return;
    if (!this.currentOrder || username !== this.currentOrder.mcUsername) return;

    const msg = message.toLowerCase();
    if (msg === 'done' || msg === '/done') {
      clearTimeout(this._dropTimer);
      clearInterval(this._inventoryPollTimer);

      if (this._pickedUpSpawners > 0) {
        this._startReturnHome({ reason: 'trade' });
      } else {
        this.emit('tradeFailed', {
          orderId   : this.currentOrder.orderId,
          telegramId: this.currentOrder.telegramId,
          reason    : 'Player said done but no spawners were received',
        });
        this._resetTradeState();
        this._startReturnHome({ reason: 'abort' });
      }
    }
  }

  _handleItemPickup() {
    if (!this.currentOrder) return;

    const allItems = this.bot.inventory.items();
    if (allItems.length) {
      console.log('[MC] Inventory:', allItems.map(i => `${i.name}x${i.count}`).join(', '));
    }

    if (!this._goingHome) this._throwBackJunk();

    const count = this._countSpawnersInInventory();
    if (count !== this._pickedUpSpawners) {
      this._pickedUpSpawners = count;
      console.log(`[MC] Inventory: ${count} spawner(s)`);
      this.emit('tradeStatus', { orderId: this.currentOrder.orderId, status: 'counting', count });

      if (count >= this.currentOrder.quantity) {
        clearTimeout(this._dropTimer);
        clearInterval(this._inventoryPollTimer);
        this._startReturnHome({ reason: 'trade' });
      }
    }
  }

  // ── Unified Return-Home ───────────────────────────────────────────────────────

  _startReturnHome({ reason = 'trade' } = {}) {
    if (this._rh) return;

    this._goingHome = true;
    clearTimeout(this._dropTimer);
    clearInterval(this._inventoryPollTimer);

    this._rh = {
      reason,
      attempts   : 0,
      combatStart: null,
      retryTimer : null,
      arrived    : false,
      escaping   : false,
    };

    console.log(`[MC] Starting return-home sequence (reason: ${reason})`);
    if (this.currentOrder) {
      this.emit('tradeStatus', { orderId: this.currentOrder.orderId, status: 'homing' });
    }

    this._doHomeAttempt();
  }

  _doHomeAttempt() {
    if (!this._rh || this._rh.arrived || this._rh.escaping) return;

    const cmd = process.env.MC_HOME_CMD || '/home 1';
    this._rh.attempts++;

    console.log(`[MC] /home attempt ${this._rh.attempts}/${MAX_HOME_ATTEMPTS}`);
    try { this.bot.chat(cmd); } catch (e) {
      console.warn('[MC] /home chat failed:', e.message);
    }

    const delay = randBetween(...HOME_RETRY_JITTER);
    clearTimeout(this._rh.retryTimer);
    this._rh.retryTimer = setTimeout(() => this._onHomeRetryTick(), delay);
  }

  _onHomeRetryTick() {
    if (!this._rh || this._rh.arrived || this._rh.escaping) return;

    const now       = Date.now();
    const combatAge = this._rh.combatStart ? now - this._rh.combatStart : 0;
    const tooLong   = this._rh.combatStart && combatAge >= COMBAT_GIVE_UP_MS;
    const tooMany   = this._rh.combatStart && this._rh.attempts >= MAX_HOME_ATTEMPTS;

    if (tooLong || tooMany) {
      console.log(`[MC] Giving up after combat (attempts: ${this._rh.attempts}, age: ${Math.round(combatAge / 1000)}s) → escape disconnect`);
      this._doEscapeDisconnect();
      return;
    }

    this._doHomeAttempt();
  }

  _onHomeCombatBlock() {
    if (!this._rh || this._rh.arrived || this._rh.escaping) return;

    const now = Date.now();
    if (!this._rh.combatStart) this._rh.combatStart = now;

    const combatAge = now - this._rh.combatStart;
    console.log(`[MC] /home blocked by combat (age: ${Math.round(combatAge / 1000)}s, attempt ${this._rh.attempts}/${MAX_HOME_ATTEMPTS})`);

    if (combatAge >= COMBAT_GIVE_UP_MS || this._rh.attempts >= MAX_HOME_ATTEMPTS) {
      this._doEscapeDisconnect();
      return;
    }

    clearTimeout(this._rh.retryTimer);
    this._rh.retryTimer = setTimeout(() => {
      console.log('[MC] Combat cooldown elapsed — retrying /home');
      this._doHomeAttempt();
    }, COMBAT_TAG_MS);
  }

  _onHealthChange(newHealth) {
    const prev       = this._lastHealth ?? newHealth;
    this._lastHealth = newHealth;

    if (!this._rh || this._rh.arrived || this._rh.escaping) return;
    if (newHealth >= prev) return;

    const now = Date.now();
    if (!this._rh.combatStart) this._rh.combatStart = now;

    const combatAge = now - this._rh.combatStart;
    console.log(`[MC] Took damage while homing (${prev.toFixed(1)} → ${newHealth.toFixed(1)}), combat age: ${Math.round(combatAge / 1000)}s`);

    if (combatAge >= COMBAT_GIVE_UP_MS || this._rh.attempts >= MAX_HOME_ATTEMPTS) {
      if (!this._rh.escaping) this._doEscapeDisconnect();
      return;
    }

    clearTimeout(this._rh.retryTimer);
    this._rh.retryTimer = setTimeout(() => {
      console.log('[MC] Combat cooldown (health hit) expired — retrying /home');
      this._doHomeAttempt();
    }, COMBAT_TAG_MS);
  }

  _onHomeArrival() {
    if (!this._rh || this._rh.arrived) return;
    this._rh.arrived = true;

    clearTimeout(this._rh.retryTimer);
    console.log('[MC] Arrived home!');

    const reason    = this._rh.reason;
    this._rh        = null;
    this._goingHome = false;

    if (reason === 'trade' && this.currentOrder && !this._depositScheduled) {
      this._depositScheduled = true;
      this.emit('tradeStatus', { orderId: this.currentOrder.orderId, status: 'depositing' });
      setTimeout(() => this._depositToChest(), 1000);
    }
    // 'abort' → nothing more to do
  }

  // ── FIX: mark trade as failed immediately before disconnecting ───────────────
  // When the bot disconnects while combat-tagged, DonutSMP kills the character
  // and drops the inventory. Spawners are lost. We fail the trade NOW rather
  // than hoping to recover them after reconnect.
  _doEscapeDisconnect() {
    if (!this._rh || this._rh.escaping) return;
    this._rh.escaping = true;

    console.log('[MC] ESCAPE: disconnecting to clear combat tag…');

    if (this.currentOrder && this._pickedUpSpawners > 0) {
      // Spawners will be lost when the server kills us — fail the trade now
      console.warn('[MC] Spawners will be lost on disconnect — marking trade as failed');
      this.emit('tradeFailed', {
        orderId   : this.currentOrder.orderId,
        telegramId: this.currentOrder.telegramId,
        reason    : `Trade failed — the seller attacked the bot while it was returning home. Items were lost when the bot was forced to disconnect.`,
      });
      this._resetTradeState();
    } else if (this.currentOrder) {
      // No spawners yet — just emit status, bot will come back and idle
      this.emit('tradeStatus', { orderId: this.currentOrder.orderId, status: 'combat_escape' });
    }

    clearTimeout(this._rh.retryTimer);
    this._rh = null;

    try { this.bot.quit(); } catch {}
    // 'end' → _scheduleReconnect → connect → spawn → _onRespawnAfterEscape
  }

  // Called on every spawn (first connect or reconnect after kick/disconnect).
  // Always navigate home so the bot is in the right place for the next trade.
  _returnHomeAfterSpawn() {
    if (this.busy) return; // mid-trade; the trade flow handles positioning
    console.log('[MC] Post-spawn: navigating home…');
    // Wait 5 s for chunks to load before sending /home
    setTimeout(() => {
      if (!this.busy && !this._rh) this._startReturnHome({ reason: 'abort' });
    }, 5_000);
  }

  // ── Message helpers ───────────────────────────────────────────────────────────

  _isHomeArrivalMessage(lower) {
    return (
      lower.includes('teleporting to your home') ||
      lower.includes('teleported to your home')  ||
      lower.includes('teleporting to home.')     ||
      lower.includes('teleported to home.')      ||
      lower.includes('you teleported to your home')
    );
  }

  _isCombatBlockMessage(lower) {
    return [
      'teleport canceled because you got into combat',
      'cannot do this in combat',
      'cannot teleport while in combat',
      'you cannot teleport in combat',
      'combat tagged',
      'combat tag',
      'tagged for combat',
      'combat mode',
    ].some(p => lower.includes(p));
  }

  _parseCoinPayment(text) {
    const match = text.match(/^(.+?) paid you \$([\d,.]+)([KkMmBbTt]?)\./i);
    if (!match) return null;
    const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
    const coinsAmount = parseFloat(match[2].replace(/,/g, '')) * (multipliers[match[3].toUpperCase()] || 1);
    return { senderName: match[1].trim(), coinsAmount };
  }

  // ── Death ────────────────────────────────────────────────────────────────────

  _onBotDeath() {
    if (this._isDead) return;
    this._isDead = true;

    if (this.currentOrder) {
      if (this._depositing) {
        this.emit('tradeComplete', {
          orderId            : this.currentOrder.orderId,
          telegramId         : this.currentOrder.telegramId,
          quantity           : this._pickedUpSpawners,
          deposited          : false,
          killedDuringDeposit: true,
        });
        this._resetTradeState();
      } else if (this._pickedUpSpawners > 0) {
        this.emit('tradeFailed', {
          orderId   : this.currentOrder.orderId,
          telegramId: this.currentOrder.telegramId,
          reason    : 'Bot was killed after collecting your spawners. Items are lost.',
        });
        this._resetTradeState();
      } else {
        this._abortTrade('Bot was killed before receiving items');
      }
    }

    if (this._rh) {
      clearTimeout(this._rh.retryTimer);
      this._rh = null;
    }

    setTimeout(() => {
      try { this.bot.respawn(); console.log('[MC] Respawning…'); } catch {}
      setTimeout(() => {
        this._isDead    = false;
        this._goingHome = false;
        setTimeout(() => this._startReturnHome({ reason: 'abort' }), 1_500);
      }, 4_000);
    }, 1_500);
  }

  // ── Chest deposit ────────────────────────────────────────────────────────────

  async _depositToChest() {
    if (!this.currentOrder) return;
    if (this._depositing) return;
    this._depositing = true;

    let finalCount = this._countSpawnersInInventory();
    console.log(`[MC] Depositing ${finalCount} spawner(s) to ender chest`);

    if (finalCount === 0) {
      // This should no longer happen (trade is failed at escape time), but kept
      // as a safety net in case of an unexpected code path.
      console.warn('[MC] No spawners in inventory at deposit — items lost, marking failed');
      this.emit('tradeFailed', {
        orderId   : this.currentOrder.orderId,
        telegramId: this.currentOrder.telegramId,
        reason    : `Trade failed — spawners were lost before deposit.`,
      });
      this._resetTradeState();
      return;
    }

    // Wait for a valid position
    let homePos = null;
    for (let waited = 0; waited < 15_000; waited += 500) {
      const p = this.bot.entity?.position;
      if (p && !isNaN(p.x)) { homePos = p.clone(); break; }
      await this._sleep(500);
    }

    if (!homePos) {
      console.warn('[MC] Could not get valid position — skipping deposit');
      this.emit('tradeComplete', {
        orderId   : this.currentOrder.orderId,
        telegramId: this.currentOrder.telegramId,
        quantity  : finalCount,
        deposited : false,
      });
      this._resetTradeState();
      return;
    }

    try { await this.bot.waitForChunksToLoad(); }
    catch { await this._sleep(4_000); }

    let deposited = false;

    try {
      const enderChestId = (
        this.bot.registry.blocksByName['ender_chest']?.id ??
        this.bot.registry.blocksByName['enderchest']?.id
      );
      const chestBlock = enderChestId
        ? this.bot.findBlock({ matching: enderChestId, maxDistance: 16 })
        : null;

      console.log('[MC] Chest:', chestBlock ? chestBlock.position : 'NOT FOUND');

      if (chestBlock) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await this.bot.lookAt(chestBlock.position.offset(0.5, 0.5, 0.5), true);
            await this._sleep(1_500);
            const win             = await this.bot.openBlock(chestBlock);
            await this._sleep(800);
            const actualDeposited = await this._depositToWindow(win);
            await this._sleep(500);
            win.close();
            deposited = true;
            if (actualDeposited > finalCount) finalCount = actualDeposited;
            break;
          } catch (e) {
            console.warn(`[MC] Deposit attempt ${attempt} failed:`, e.message);
            await this._sleep(2_000 * attempt);
          }
        }
      }

      this.emit('tradeComplete', {
        orderId   : this.currentOrder.orderId,
        telegramId: this.currentOrder.telegramId,
        quantity  : finalCount,
        deposited,
      });
    } catch (err) {
      console.error('[MC] Deposit error:', err.message);
      this.emit('tradeComplete', {
        orderId   : this.currentOrder.orderId,
        telegramId: this.currentOrder.telegramId,
        quantity  : finalCount,
        deposited : false,
      });
    } finally {
      this._resetTradeState();
    }
  }

  async _depositToWindow(win) {
    const items = this.bot.inventory.items();
    let total   = 0;
    for (const item of items) {
      if (!this._isSkeletonSpawner(item)) continue;
      try {
        await win.deposit(item.type, null, item.count);
        await this._sleep(400);
        total += item.count;
        console.log(`[MC] Deposited ${item.count}x spawner (total: ${total})`);
      } catch (e) {
        console.warn('[MC] Deposit failed, trying shift-click:', e.message);
        try { await this.bot.clickWindow(item.slot, 0, 1); total += item.count; } catch {}
      }
    }
    return total;
  }

  // ── Inventory helpers ─────────────────────────────────────────────────────────

  _startInventoryPoller() {
    clearInterval(this._inventoryPollTimer);
    this._inventoryPollTimer = setInterval(() => {
      if (!this.currentOrder) { clearInterval(this._inventoryPollTimer); return; }

      const items = this.bot.inventory.items();
      if (items.length) {
        console.log('[MC] Poll:', items.map(i => `${i.name}x${i.count}`).join(', '));
      }
      if (!this._goingHome) this._throwBackJunk();

      const count = this._countSpawnersInInventory();
      if (count > 0 && count !== this._pickedUpSpawners) {
        this._pickedUpSpawners = count;
        this.emit('tradeStatus', { orderId: this.currentOrder.orderId, status: 'counting', count });
        if (count >= this.currentOrder.quantity) {
          clearTimeout(this._dropTimer);
          clearInterval(this._inventoryPollTimer);
          this._startReturnHome({ reason: 'trade' });
        }
      }
    }, 1_000);
  }

  async _throwBackJunk() {
    if (this._throwingBack) return;
    this._throwingBack = true;
    try {
      for (const item of this.bot.inventory.items()) {
        if (this._isSkeletonSpawner(item)) continue;
        try {
          await this.bot.tossStack(item);
          await this._sleep(250);
          console.log(`[MC] Threw back ${item.count}x ${item.name}`);
        } catch (e) {
          console.warn('[MC] Throw-back failed:', e.message);
        }
      }
    } finally {
      this._throwingBack = false;
    }
  }

  _countSpawnersInInventory() {
    return this.bot.inventory.items()
      .filter(i => this._isSkeletonSpawner(i))
      .reduce((n, i) => n + i.count, 0);
  }

  _isSkeletonSpawner(item) {
    if (!item) return false;
    const name = item.name?.toLowerCase() || '';
    if (name !== 'spawner' && name !== 'monster_spawner' && name !== 'mob_spawner') return false;

    if (item.components) {
      const loreComp = item.components.find(c => c.type === 'lore');
      if (loreComp?.data) {
        for (const line of loreComp.data) {
          const extras = line?.value?.extra?.value?.value || [];
          for (const extra of extras) {
            if ((extra?.text?.value || '').toLowerCase() === 'skeleton') return true;
          }
        }
      }
    }
    return false;
  }

  // ── Trade cleanup ─────────────────────────────────────────────────────────────

  _abortTrade(reason) {
    console.log(`[MC] Trade aborted: ${reason}`);
    if (this.currentOrder) {
      this.emit('tradeFailed', {
        orderId   : this.currentOrder.orderId,
        telegramId: this.currentOrder.telegramId,
        reason,
      });
    }
    this._resetTradeState();
  }

  _resetTradeState() {
    clearTimeout(this._tpaTimer);
    clearTimeout(this._dropTimer);
    clearInterval(this._inventoryPollTimer);

    this.currentOrder      = null;
    this.busy              = false;
    this._goingHome        = false;
    this._depositing       = false;
    this._depositScheduled = false;
    this._pickedUpSpawners = 0;
    this._throwingBack     = false;
    this._lastHealth       = this.bot?.health ?? null;
    // NOTE: _pendingEscapeResume intentionally NOT cleared here — survives reconnect
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  _chat(message) {
    return new Promise(resolve => {
      this.bot.chat(message);
      setTimeout(resolve, 500);
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  isReady() { return this.connected && !this.busy; }

  getStatus() {
    return {
      connected   : this.connected,
      busy        : this.busy,
      currentOrder: this.currentOrder?.orderId || null,
      username    : this.bot?.username || null,
      returning   : !!this._rh,
      homeAttempts: this._rh?.attempts || 0,
    };
  }
}

module.exports = new MinecraftBot();
