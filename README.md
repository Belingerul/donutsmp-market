# DonutSMP Market

A fully automated Minecraft arbitrage bot for DonutSMP. Players place orders through a Telegram Mini App and pay with Solana — the in-game bot then purchases the items from the DonutSMP shop at the cheaper in-game price and delivers them directly to the buyer. The margin between shop cost and sale price is pure profit, fully hands-off.

Built with Node.js, Mineflayer, Telegraf, and the Solana Web3 SDK.

---

## How it works

1. Player opens the **Telegram Mini App** → sees available items and prices
2. They place an order and send **Solana payment** to the bot's wallet
3. Payment is detected on-chain automatically
4. The **in-game Minecraft bot** buys the items from the DonutSMP shop at the low in-game price
5. Bot accepts the player's TPA and delivers the items directly to them
6. Transaction is logged and the profit (sale price minus shop cost) is recorded

Everything from payment detection to purchase and delivery is fully automated.

---

## Stack

| Layer | Tech |
|---|---|
| In-game automation | [Mineflayer](https://github.com/PrismarineJS/mineflayer) + mineflayer-pathfinder |
| Telegram bot + Mini App | [Telegraf](https://telegraf.js.org) |
| Payments | [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/) |
| Database | better-sqlite3 |
| Web server | Express |

---

## Project structure

```
src/
├── index.js              — entry point, boots all services
├── minecraft/bot.js      — in-game bot (TPA, item detection, pathfinding)
├── telegram/bot.js       — Telegram bot commands and order flow
├── webapp/               — Mini App UI served to players
├── payments/solana.js    — on-chain payment detection and verification
├── transactions/         — order state machine
└── database/db.js        — balances, orders, withdrawal ledger
```

---

## Setup

### Requirements

- Node.js 18+
- A dedicated Java Edition Minecraft account for the bot
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Solana wallet (export private key from Phantom)

### Install

```bash
git clone https://github.com/Belingerul/donutsmp-market
cd donutsmp-market
npm install
cp .env.example .env
# Fill in .env with your credentials
npm start
```

### First run — Minecraft login

On first start you'll see a Microsoft device auth prompt:

```
To sign in, open https://www.microsoft.com/link and enter the code XXXX-XXXX
```

Open the link, log in with the bot account's Microsoft credentials. This only happens once — the token is cached.

### Set the bot's home in-game

The bot needs a home location with an ender chest nearby:

1. Log into DonutSMP on the bot account
2. Place an **ender chest** within 4 blocks of your position
3. Run `/sethome 1`

### Connect the Mini App

In [@BotFather](https://t.me/BotFather):  
`/mybots → your bot → Bot Settings → Menu Button → Configure menu button`  
Set the URL to your `WEBAPP_URL` from `.env`.

---

## Configuration

Copy `.env.example` to `.env` and fill in the values:

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `ADMIN_TELEGRAM_ID` | Your Telegram user ID (get from [@userinfobot](https://t.me/userinfobot)) |
| `WEBAPP_URL` | Public URL for the Mini App (ngrok, Cloudflare Tunnel, or VPS) |
| `MC_USERNAME` | Microsoft email for the bot's Minecraft account |
| `MC_SERVER` | Server address |
| `MC_VERSION` | Server Minecraft version |
| `PRICE_SPAWNER` | Spawner price in USD |
| `PRICE_1M_COINS` | Price per 1M in-game coins in USD |
| `SOLANA_PRIVATE_KEY` | Base58 private key from Phantom |
| `SOLANA_RPC_URL` | RPC endpoint (default: mainnet-beta public) |

---

## Running 24/7

For always-on operation, deploy to a cheap VPS (Hetzner or DigitalOcean, ~$4–6/month) and use PM2:

```bash
npm install -g pm2
pm2 start src/index.js --name donutmarket
pm2 save && pm2 startup
```

---

## Common issues

| Problem | Fix |
|---|---|
| `npm install` fails with build error | Ubuntu: `sudo apt install build-essential python3` / Windows: `npm install -g windows-build-tools` |
| Bot connects then immediately drops | Log into the server manually on the bot account at least once first |
| Mini App shows white screen | Confirm `npm start` is running and `WEBAPP_URL` in BotFather matches `.env` exactly |
| Microsoft login code expired | Re-run `npm start` for a fresh code |
