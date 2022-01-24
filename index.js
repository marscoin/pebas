//  pebas
//  Public endpoint for the Marscoin blockchain as an api service.
//
//! @author Kenneth Shortrede https://github.com/kshortrede
//! @author Sebastian Fabara https://github.com/sfabara

 
import { createRequire } from "module";
import fetch from "node-fetch";
import { MarscoinMainnet } from "./networks.js";

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
const XMLHttpRequest = require("xhr2");

//Security
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cryptojs = require("crypto-js");
const crypto = require("crypto");

//Bitcoin
const bitcoinController = require("bitcoinjs-lib");
const { ECPair } = require("ecpair");
const bip32 = require("bip32");
const bip39 = require("bip39");
// const bip44 = require("bip44");
const bip84 = require("bip84");
const reverse = require("buffer-reverse");

const satoshiPerBTC = 100000000;
const coinSelect = require("coinselect");
const ElectrumClient = require("electrum-client");
const peers = require("electrum-host-parse")
  .getDefaultPeers("BitcoinSegwit")
  .filter((v) => v.ssl);
const getRandomPeer = () => peers[(peers.length * Math.random()) | 0];

//app.use(bodyParser.urlencoded({extended: true}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.listen(3001, () => {
  console.log("Running on port 3001 🚀");
});


//Electrum Clients Connection
const marsecl = new ElectrumClient("50002", "147.182.177.23", "ssl"); //147.182.177.23

(() => {
  marsecl.connect();
})();

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

setInterval(async function () {
  try {
    await marsecl.server_ping();
    // console.log("Server's Active");
  } catch (Exception) {
    console.log(Exception);
  }
}, 5000);


// ==========================================================================================================================
// ==========================================================================================================================
// ==========================================================================================================================

// Desc: Adding MARSCOIN Electrum X functionality

// MARS Electrum config
// const marsecl = new ElectrumClient("50002", "147.182.177.23", "ssl");  //147.182.177.23

// const mainMARS = async () => {
//   console.log("Running MARS electrum...")
//   await marsecl.connect()
// }

// mainMARS()

const Marscoin = {
  mainnet: {
    messagePrefix: "\x19Marscoin Signed Message:\n",
    bech32: "M",
    bip44: 2,
    bip32: {
      public: 0x043587cf,
      private: 0x04358394,
    },
    pubKeyHash: 0x32,
    scriptHash: 0x32,
    wif: 0x80,
  },
};

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

  // console.log("sender_address: ", sender_address)
  // console.log("receiver_address: ",receiver_address)
  // console.log("amount: ",amount)

  try {

    const list_unspent = await marsGetUtxosByAddress(sender_address);

    const rawtx = await getTxHash(list_unspent, amount, receiver_address);
    res.send("shoot");

    return rawtx;
  } catch (error) {
    console.error(error);
  }
});

//    Parameters:
//    txhash
//
// Takes in txhash and broadcasts transaction
app.get("/api/mars/broadcast/", async (req, res) => {
  const txhash = req.query.txhash;

  if (!txhash) {
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

// =====================================================================
// =====================================================================
// =========================== Core Functions ==========================

// Batch get UTXO List given address
const marsGetUtxosByAddress = async (sender_address) => {
  //const batchsize = batchsize || 100;
  if (!marsecl) throw new Error("Electrum client is not connected...");

  console.log("Grabbing list unspent...");
  const scriptHash = adddressToScriptHash(sender_address);

  let list_unspent = await marsecl.blockchainScripthash_listunspent(scriptHash);

  return list_unspent;
};

// Given a txid return raw tx
const getTxHash = async (list_unspent, amount, receiver_address) => {
  // error handler
  if (!marsecl) throw new Error("Electrum client is not connected...");
  console.log("Amount 1: ", amount);
  amount = Math.round(marsToZubrins(amount));

  const targets = [
    {
      address: receiver_address,
      value: amount,
    },
  ];
  const fee_rate = 55;

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
      hash: utxo.hash,
      index: utxo.tx_pos,
    };

    formattedUtxos.push(prop);
  }
  console.log("Amount: ", amount);
  console.log("Format UTXO: ", formattedUtxos);

  let { inputs, outputs, fee } = coinSelect(formattedUtxos, targets, fee_rate);
  console.log(inputs, "\n\n", outputs);

  // .inputs and .outputs will be undefined if no solution was found
  if (!inputs || !outputs) return "Empty";

  const result = {
    inputs: inputs,
    outputs: outputs,
  };
  // throw in tx id to get raw tx
  //const raw = await marsecl.blockchainTransaction_get(tx)

  return result;
};

const getRawTx = async (tx) => {
  const raw = await marsecl.blockchainTransaction_get(tx);

  return raw;
};

const broadcastTx = async (hex) => {
  if (!marsecl) throw new Error("Electrum client is not connected...");

  const broadcast = await marsecl.blockchainTransaction_broadcast(hex);

  return broadcast;
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
