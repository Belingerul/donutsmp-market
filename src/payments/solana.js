const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    https.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('SOL price fetch timeout')));
  });
}

async function getSolPrice() {
  const sources = [
    async () => {
      const d = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
      const p = parseFloat(d?.price);
      if (!p) throw new Error('Binance parse failed');
      return p;
    },
    async () => {
      const d = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const p = d?.solana?.usd;
      if (!p) throw new Error('CoinGecko parse failed');
      return p;
    },
    async () => {
      const d = await fetchJson('https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d');
      const p = parseFloat(d?.parsed?.[0]?.price?.price) * Math.pow(10, d?.parsed?.[0]?.price?.expo ?? 0);
      if (!p) throw new Error('Pyth parse failed');
      return p;
    },
  ];

  for (const source of sources) {
    try {
      return await source();
    } catch (_) {}
  }
  throw new Error('Could not fetch SOL price from any source');
}

function getKeypair() {
  const raw = process.env.SOLANA_PRIVATE_KEY;
  if (!raw) throw new Error('SOLANA_PRIVATE_KEY not configured');

  // JSON byte array: [1,2,...,64]
  if (raw.trim().startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }

  // base58 (Phantom / Solana CLI export) — bs58 v6 wraps under .default
  try {
    const bs58mod = require('bs58');
    const decode = bs58mod.default?.decode ?? bs58mod.decode;
    const bytes = decode(raw);
    return Keypair.fromSecretKey(bytes);
  } catch (_) {}

  // base64 fallback
  return Keypair.fromSecretKey(Buffer.from(raw, 'base64'));
}

function isValidSolAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// Sends USD-denominated amount as native SOL to `toAddress`.
// Returns { signature, solAmount, solPrice, explorerUrl }
async function sendSol(toAddress, usdAmount) {
  if (!isValidSolAddress(toAddress)) {
    throw new Error('Invalid Solana wallet address');
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = getKeypair();

  const solPrice = await getSolPrice();
  const solAmount = usdAmount / solPrice;
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  if (lamports < 1000) throw new Error(`Amount too small after conversion ($${usdAmount} = ${solAmount.toFixed(9)} SOL)`);

  const toPubkey = new PublicKey(toAddress);

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey, lamports })
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });

  return {
    signature,
    solAmount: solAmount.toFixed(6),
    solPrice,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
}

module.exports = { sendSol, getSolPrice, isValidSolAddress };
