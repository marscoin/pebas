//  pebas
//  Public endpoint for the Marscoin blockchain as an api service.
//
//! @author Kenneth Shortrede https://github.com/kshortrede
//! @author Sebastian Fabara https://github.com/sfabara


import { createRequire } from "module";
import fetch from "node-fetch";
import { Marscoin } from "./networks.js";

//Allow both imports and requires
const require = createRequire(import.meta.url);

const express = require("express");
//const jwt = require('njwt');
const app = express();
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const util = require("util");
const { request, response } = require("express");

//Security
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cryptojs = require("crypto-js");
const crypto = require("crypto");

//Bitcoin
const bitcoinController = require("bitcoinjs-lib");
// const bip44 = require("bip44");

const coinSelect = require("coinselect");
const ElectrumClient = require("electrum-client");

// HD wallet discovery - use bip32 v4 with tiny-secp256k1 (pure JS, no OpenSSL)
let bip32HD;
try {
  const tinysecp = require("tiny-secp256k1");
  const { BIP32Factory } = require("bip32");
  bip32HD = BIP32Factory(tinysecp);
  // Smoke test
  const testNode = bip32HD.fromBase58("tpubDDDjG8FYXe3UrKsCJeq5E4KBiEQ4KP8XjGbK79hmKBebFqH8p6Fzyu2zS1XVeXyczZ1Py4nvSAfKRpS2YGGbLvshozR8BqZwukgQdyFtcEM", Marscoin.mainnet);
  testNode.derive(0).derive(0);
  console.log("✅ bip32HD initialized and smoke-tested OK");
} catch(e) {
  console.error("❌ bip32HD init failed:", e.message);
  console.error("   HD discovery endpoints will not work");
  bip32HD = null;
}
const peers = require("electrum-host-parse")
  .getDefaultPeers("BitcoinSegwit")
  .filter((v) => v.ssl);
const getRandomPeer = () => peers[(peers.length * Math.random()) | 0];

//app.use(bodyParser.urlencoded({extended: true}));
app.use(cors({ origin: "*", methods: ['GET','POST','DELETE','UPDATE','PUT','PATCH']}));
app.use(express.json());
app.use(cookieParser());

app.listen(3001, () => {
  console.log("Running on port 3001 🚀");
});

// Electrum Clients Connection
const marsecl = new ElectrumClient("50002", "147.182.177.23", "ssl");

async function connectElectrumClient(client, maxRetries = 5, delay = 1000) {
  let retries = 0;

  async function attemptConnection() {
    try {
      await client.connect();
      console.log("Successfully connected to Mars Electrum server.");

      client.on('close', () => {
        console.log("Connection to Mars Electrum server lost. Attempting to reconnect...");
        setTimeout(reconnect, delay);
      });
    } catch (error) {
      if (retries < maxRetries) {
        retries++;
        console.log(`Connection failed, retrying... (${retries}/${maxRetries})`);
        setTimeout(attemptConnection, retries * delay);
      } else {
        console.log("Failed to connect to Mars Electrum server after several attempts.");
        throw error;
      }
    }
  }

  async function reconnect() {
    retries = 0; // Reset retry counter for a fresh start
    attemptConnection();
  }

  await attemptConnection();
}

const mainMARS = async () => {
  try {
    await connectElectrumClient(marsecl);
  } catch (e) {
    console.error("Error connecting to MARS electrum:", e);
  }
};

mainMARS();



setInterval(async function () {
  try {
    await marsecl.server_ping();
    // console.log("Server's Active");
  } catch (Exception) {
    console.log(Exception);
  }
}, 5000);



// Desc: Adding MARSCOIN Electrum X functionality

//    Parameters:
//    SenderAddress
//    ReceiverAddress
//    Amount
//
// Takes in address and amount to spend and returns rawtx
app.get("/api/mars/utxo/", async (req, res) => {
  const sender_address = req.query.sender_address;
  const receiver_address = req.query.receiver_address;
  const amount = req.query.amount;

  if (!sender_address) {
    const err = new Error("Required query params missing");
    err.status = 400;
    res.send("Required: SENDER_ADDRESS parameter missing");
    return;
  } else if (!amount) {
    const err = new Error("Required query params missing");
    err.status = 400;
    res.send("Required: AMOUNT parameter missing");
    return;
  }


  try {

    const list_unspent = await marsGetUtxosByAddress(sender_address);

    const rawtx = await getTxHash(list_unspent, amount, receiver_address);

    console.log(rawtx)
    res.send(rawtx);

    return rawtx;
  } catch (error) {
    console.error(error);
  }
});

//    Parameters:
//    txhash
//
// Takes in txhash and broadcasts transaction
app.all("/api/mars/broadcast/", async (req, res) => {
  let txhash = req.param("txhash");
  if (!txhash) {
    console.log(req.param)
    const err = new Error("Required query params missing");
    err.status = 400;
    res.send("Required: TXHASH parameter missing");
    console.log("Required: TXHASH parameter missing");
    return;
  }

  try {
    const broadcast = await broadcastTx(txhash);
    const result = { tx_hash: broadcast };
    console.log(result);
    res.send(result);
    return;
  } catch (error) {
    console.error(error);
  }

  return;
});

app.get("/api/mars/txdetails/", async (req, res) => {
  let txid = req.query.txid;
  if (!txid) {
    console.log(req.query)
    const err = new Error("Required query params missing");
    err.status = 400;
    res.send("Required: TXID parameter missing");
    console.log("Required: TXID parameter missing");
    return;
  }

  try {
    const txdetails = await checkDetails(txid);
    console.log(txdetails);
    const result = {txid: txid, confirmations: txdetails.confirmations, blocktime: txdetails.blocktime}
    console.log(result);
    res.send(result);
  } catch (error) {
    console.error(error);
  }

  return;
});

app.get("/api/mars/balance/", async (req, res) => {
  const address = req.query.address;

  if (!address) {
    return res.status(400).send("Required: ADDRESS parameter is missing");
  }

  try {
    const balance = await getBalanceByAddress(address);
    res.json({ address: address, balance: balance });
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

// =====================================================================
// Transaction History - get tx history for an address via Electrum
// Returns format compatible with the explorer /api/txs/ response
// =====================================================================
app.get("/api/mars/txhistory/", async (req, res) => {
  const address = req.query.address;
  if (!address) {
    return res.status(400).json({ error: "Required: address parameter" });
  }

  try {
    const scriptHash = adddressToScriptHash(address);
    // Get transaction history (list of tx hashes + heights)
    const history = await marsecl.blockchainScripthash_getHistory(scriptHash);

    if (!history || history.length === 0) {
      return res.json({ totalItems: 0, txs: [] });
    }

    // Fetch full transaction details for each tx (limit to last 50)
    const recent = history.slice(-50);
    const txs = [];
    for (const item of recent) {
      try {
        const rawTx = await marsecl.blockchainTransaction_get(item.tx_hash, true);
        if (rawTx) {
          // Add fee calculation
          let totalIn = 0, totalOut = 0;
          if (rawTx.vin) {
            for (const vin of rawTx.vin) {
              if (vin.value) totalIn += vin.value;
            }
          }
          if (rawTx.vout) {
            for (const vout of rawTx.vout) {
              totalOut += parseFloat(vout.value || 0);
            }
          }
          rawTx.fees = Math.max(0, totalIn - totalOut);
          txs.push(rawTx);
        }
      } catch (txErr) {
        console.error("Error fetching tx", item.tx_hash, txErr.message);
      }
    }

    res.json({ totalItems: txs.length, txs: txs });
  } catch (error) {
    console.error("txhistory error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// =====================================================================
// HD Wallet Discovery - scan BIP44 derivation paths for all balances
// Takes xpub (extended public key) - no private key needed
// =====================================================================
app.get("/api/mars/discover/", async (req, res) => {
  const xpub = req.query.xpub;
  const gapLimit = parseInt(req.query.gap_limit) || 20;

  if (!xpub) {
    return res.status(400).json({ error: "Required: XPUB parameter is missing" });
  }

  try {
    console.log("HD Discovery: parsing xpub...");
    const hdNode = bip32HD.fromBase58(xpub, Marscoin.mainnet);
    console.log("HD Discovery: xpub parsed OK");

    const discovered = [];
    let totalBalance = 0;
    let totalReceived = 0;

    // Scan both chains: 0 = receiving, 1 = change
    for (let chain = 0; chain <= 1; chain++) {
      const chainNode = hdNode.derive(chain);
      let consecutiveEmpty = 0;

      for (let index = 0; consecutiveEmpty < gapLimit; index++) {
        const childNode = chainNode.derive(index);
        const address = pubkeyToAddressPure(childNode.publicKey, Marscoin.mainnet.pubKeyHash);

        try {
          const scriptHash = addressToScriptHashPure(address);
          console.log(`HD Discovery: checking ${chain}/${index} ${address} hash=${scriptHash.substring(0,8)}...`);
          const listUnspent = await marsecl.blockchainScripthash_listunspent(scriptHash);
          const balance = listUnspent.reduce((acc, utxo) => acc + utxo.value, 0);
          const balanceMars = zubrinToMars(balance);

          // Also check transaction history to detect used-but-empty addresses
          const history = await marsecl.blockchainScripthash_getHistory(scriptHash);

          if (balance > 0 || history.length > 0) {
            discovered.push({
              address,
              balance: balanceMars,
              chain: chain === 0 ? "receiving" : "change",
              index,
              path: `m/44'/2'/0'/${chain}/${index}`,
              txCount: history.length,
              utxoCount: listUnspent.length,
            });
            totalBalance += balanceMars;
            consecutiveEmpty = 0;
          } else {
            consecutiveEmpty++;
          }
        } catch (addrErr) {
          console.warn(`Failed to check ${address}:`, addrErr.message);
          consecutiveEmpty++;
        }
      }
    }

    // Get total received for the primary address
    if (discovered.length > 0) {
      try {
        const primaryScript = adddressToScriptHash(discovered[0].address);
        const primaryBalance = await marsecl.blockchainScripthash_getBalance(primaryScript);
        totalReceived = zubrinToMars((primaryBalance.confirmed || 0) + (primaryBalance.unconfirmed || 0));
      } catch (e) { /* ignore */ }
    }

    res.json({
      totalBalance,
      totalReceived,
      addressCount: discovered.length,
      addresses: discovered,
      gapLimit,
    });

    console.log(`HD Discovery for ${xpub.substring(0, 20)}...: ${discovered.length} addresses, ${totalBalance} MARS`);
  } catch (error) {
    console.error("HD Discovery error:", error);
    res.status(500).json({ error: "HD discovery failed: " + error.message });
  }
});

// =====================================================================
// Multi-address UTXO - get UTXOs for all HD wallet addresses at once
// Used for sending from HD wallets with funds spread across addresses
// =====================================================================
app.get("/api/mars/utxo-multi/", async (req, res) => {
  const xpub = req.query.xpub;
  const receiver_address = req.query.receiver_address;
  const amount = req.query.amount;

  if (!xpub || !amount) {
    return res.status(400).json({ error: "Required: XPUB, AMOUNT parameters" });
  }

  try {
    const hdNode = bip32HD.fromBase58(xpub, Marscoin.mainnet);

    // First discover all addresses with UTXOs
    let allUtxos = [];
    const GAP_LIMIT = 20;

    for (let chain = 0; chain <= 1; chain++) {
      const chainNode = hdNode.derive(chain);
      let consecutiveEmpty = 0;

      for (let index = 0; consecutiveEmpty < GAP_LIMIT; index++) {
        const childNode = chainNode.derive(index);
        const address = pubkeyToAddressPure(childNode.publicKey, Marscoin.mainnet.pubKeyHash);

        try {
          const scriptHash = addressToScriptHashPure(address);
          const listUnspent = await marsecl.blockchainScripthash_listunspent(scriptHash);

          if (listUnspent.length > 0) {
            for (const utxo of listUnspent) {
              const rawtx = await getRawTx(utxo.tx_hash);
              allUtxos.push({
                txId: utxo.tx_hash,
                vout: utxo.tx_pos,
                value: utxo.value,
                rawTx: rawtx,
                nonWitnessUtxo: Buffer.from(rawtx, "hex"),
                index: utxo.tx_pos,
                address,
                derivationPath: { chain, index },
              });
            }
            consecutiveEmpty = 0;
          } else {
            const history = await marsecl.blockchainScripthash_getHistory(scriptHash);
            if (history.length === 0) consecutiveEmpty++;
            else consecutiveEmpty = 0;
          }
        } catch (e) {
          consecutiveEmpty++;
        }
      }
    }

    // Use coinselect to pick optimal UTXOs
    const targets = [{ address: receiver_address || allUtxos[0]?.address, value: Math.round(marsToZubrins(amount)) }];
    const fee_rate = 10000; // ~0.02 MARS per tx - support the miners!
    let { inputs, outputs, fee } = coinSelect(allUtxos, targets, fee_rate);

    if (!inputs || !outputs) {
      return res.status(400).json({ error: "Insufficient funds across all addresses" });
    }

    res.json({ inputs, outputs, fee });
  } catch (error) {
    console.error("Multi-UTXO error:", error);
    res.status(500).json({ error: "Multi-UTXO failed: " + error.message });
  }
});

// =====================================================================
// =====================================================================
// =========================== Core Functions ==========================

// Batch get UTXO List given address
const marsGetUtxosByAddress = async (address) => {
  if (!marsecl) throw new Error("Electrum client is not connected...");

  console.log("Grabbing list unspent for address:", address);
  const scriptHash = adddressToScriptHash(address);

  let list_unspent = await marsecl.blockchainScripthash_listunspent(scriptHash);
  console.log("List unspent for", address, ":", list_unspent);

  return list_unspent;
};

// Given a txid return raw tx
const getTxHash = async (list_unspent, amount, receiver_address) => {
  // error handler
  if (!marsecl) throw new Error("Electrum client is not connected...");
  amount = Math.round(marsToZubrins(amount));

  const targets = [
    {
      address: receiver_address,
      value: amount,
    },
  ];
  const fee_rate = 1550;

  // loop through utxo's and format
  let formattedUtxos = [];
  for (const index in list_unspent) {
    let utxo = list_unspent[index];

    let rawtx = await getRawTx(utxo.tx_hash);
    const prop = {
      txId: utxo.tx_hash,
      vout: utxo.tx_pos,
      value: utxo.value,
      rawTx: rawtx,
      nonWitnessUtxo: Buffer.from(rawtx, "hex"),
      index: utxo.tx_pos,
    };

    formattedUtxos.push(prop);
  }
  //console.log("Amount: ", amount);
  //console.log("Format UTXO: ", formattedUtxos);

  let { inputs, outputs, fee } = coinSelect(formattedUtxos, targets, fee_rate);
  //console.log(inputs, "\n\n", outputs);

  // .inputs and .outputs will be undefined if no solution was found
  if (!inputs || !outputs) return "Empty";

  const result = {
    inputs: inputs,
    outputs: outputs,
    fee: fee
  };
  // throw in tx id to get raw tx

  return result;
};

const getRawTx = async (tx) => {
  const raw = await marsecl.blockchainTransaction_get(tx, false);

  return raw;
};

const broadcastTx = async (hex) => {
  if (!marsecl) throw new Error("Electrum client is not connected...");

  const broadcast = await marsecl.blockchainTransaction_broadcast(hex);

  return broadcast;
};

const checkDetails = async (hex) => {

  if (!marsecl) throw new Error("Electrum client is not connected...");

  const confirmations = await marsecl.blockchainTransaction_get(hex, true);

  return confirmations;


};

const getBalanceByAddress = async (address) => {
  const utxos = await marsGetUtxosByAddress(address);
  const balance = utxos.reduce((acc, utxo) => acc + utxo.value, 0);
  return zubrinToMars(balance);
};

// =====================================================================
// =====================================================================
// =========================== Helper Functions ========================

const marsToZubrins = (MARS) => {
  return MARS * 100000000;
};
const zubrinToMars = (ZUBRIN) => {
  return ZUBRIN / 100000000;
};

// Pure JS crypto utilities for HD discovery (no OpenSSL dependency)
const nobleHash = require("@noble/hashes/sha256");
const nobleRipemd = require("@noble/hashes/ripemd160");
const bs58checkLib = require("bs58check");

// Pure JS hash160 (sha256 + ripemd160)
const hash160Pure = (buffer) => {
  const sha = nobleHash.sha256(Uint8Array.from(buffer));
  return Buffer.from(nobleRipemd.ripemd160(sha));
};

// Pure JS p2pkh address from public key
const pubkeyToAddressPure = (pubkey, versionByte = 0x32) => {
  const h160 = hash160Pure(pubkey);
  const payload = Buffer.concat([Buffer.from([versionByte]), h160]);
  return bs58checkLib.encode(payload);
};

// Pure JS address to script hash for Electrum
const addressToScriptHashPure = (address) => {
  const decoded = bs58checkLib.decode(address);
  const pubKeyHash = decoded.slice(1);
  const script = Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    pubKeyHash,
    Buffer.from([0x88, 0xac]),
  ]);
  const hash = nobleHash.sha256(Uint8Array.from(script));
  return Buffer.from(hash).reverse().toString("hex");
};

// Given address return script hash
const adddressToScriptHash = (address) => {
  const script = bitcoinController.address.toOutputScript(
    address,
    Marscoin.mainnet
  );
  const hash = bitcoinController.crypto.sha256(script);
  const reversedHash = Buffer(hash.reverse()).toString("hex");

  return reversedHash;
};

// ==========================================================================================================================
// ==========================================================================================================================
// ==========================================================================================================================
