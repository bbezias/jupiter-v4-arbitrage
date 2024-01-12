import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import fetch from "isomorphic-fetch";
import dotenv from "dotenv";
import JSBI from "jsbi";
import bs58 from "bs58";
import { Jupiter, RouteInfo, TOKEN_LIST_URL } from "@jup-ag/core";
import Decimal from "decimal.js";
import { MongoClient } from "mongodb";
import express from "express";
import client from "prom-client";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

let config = dotenv.config().parsed;

console.log("Arbritrager Started");
console.log("Config", config);

interface Token {
  chainId: number; // 101,
  address: string; // '8f9s1sUmzUbVZMoMh6bufMueYH1u4BJSM57RCEvuVmFp',
  symbol: string; // 'TRUE',
  name: string; // 'TrueSight',
  decimals: number; // 9,
  logoURI: string; // 'https://i.ibb.co/pKTWrwP/true.jpg',
  tags: string[]; // [ 'utility-token', 'capital-token' ]
}

const ENV = "mainnet-beta";
const USER_PRIVATE_KEY = bs58.decode(config!.WALLET_PRIVATE_KEY);
const USER_KEYPAIR = Keypair.fromSecretKey(USER_PRIVATE_KEY);
let tokens: Token[] = [];
// const connection = new Connection(process.env.RPC_ENDPOINT || "");
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT || "", {
  confirmTransactionInitialTimeout: 20000,
  commitment: "processed",
});
function unixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

interface TokenParameter {
  key: string;
  ccy: string;
  amount: number;
  enabled: boolean;
  token: Token;
}

interface ArbSettings {
  threshold: number;
  priorityFee: number;
  slippagePct: number;
  token: string;
  amount: number;
}

let arbSettings: ArbSettings = {
  threshold: 0,
  priorityFee: 0,
  slippagePct: 0,
  token: "So11111111111111111111111111111111111111112",
  amount: 0.1,
};
let nativeSOLBalance = 0;
let tokenWhitelist: TokenParameter[] = [];

const Registry = client.Registry;
const register = new Registry();

register.setDefaultLabels({
  bot: "arb-jup-v4",
});

// Counter
const attemptsMetrics = new client.Counter({
  name: "attempts_count",
  help: "Total number of attemps",
  labelNames: ["outcome", "ccy", "size", "threshold"],
});

// Balance
const balanceMetrics = new client.Gauge({
  name: "balance",
  help: "Balance",
  labelNames: ["token_balance"],
});

// Balance
const spreadMetrics = new client.Gauge({
  name: "spread",
  help: "Spread between in and out",
  labelNames: ["ccy"],
});

// Register the metrics
register.registerMetric(attemptsMetrics);
register.registerMetric(balanceMetrics);
register.registerMetric(spreadMetrics);

const app = express();

// Function to get data from MongoDB
async function getWhiteList() {
  const client = new MongoClient(config!.MONGODB_URL);

  try {
    // Connect to the MongoDB client
    await client.connect();
    // Get the database and collection
    const db = client.db("arb");
    const collection = db.collection("settings");

    // Query the collection for the specific document
    const query: any = { _id: "arb-v4-token-whitelist" };
    const res = await collection.findOne(query);

    if (res) {
      const data = res.data;
      for (const r of data) {
        if (!tokenWhitelist.some((item) => item.key === r.key)) {
          if (r.enabled) {
            console.log(`New token found ${r.ccy}: ${r.amount}`);
          }
        }
      }
      tokenWhitelist = data.filter((item: TokenParameter) => item.enabled);

      for (const t of tokenWhitelist) {
        t.token = tokens.find((token) => token.address === t.key) as Token;
      }
    }
  } catch (error) {
    console.error("Error accessing MongoDB:", error);
    throw error;
  } finally {
    // Ensure that the client will close when you finish/error
    await client.close();
  }
}

async function getSettings() {
  const client = new MongoClient(config!.MONGODB_URL);

  try {
    // Connect to the MongoDB client
    await client.connect();

    // Get the database and collection
    const db = client.db("arb");
    const collection = db.collection("settings");

    // Query the collection for the specific document
    const query: any = { _id: "arb-v4-settings" };
    const res = await collection.findOne(query);

    if (res) {
      const data = res.data;
      const s = arbSettings as any;
      Object.keys(data).forEach((key) => {
        if (!s[key] || s[key] !== data[key]) {
          console.log(`Settings ${key} changed from ${s[key]} to ${data[key]}`);
        }
      });
      arbSettings = data;
    }
  } catch (error) {
    console.error("Error accessing MongoDB:", error);
    throw error;
  } finally {
    // Ensure that the client will close when you finish/error
    await client.close();
  }
}

// Function to get data from MongoDB
async function setSettingsFromMongo() {
  await Promise.all([getWhiteList(), getSettings()]);
}

async function updateBalance() {
  nativeSOLBalance = await connection.getBalance(USER_KEYPAIR.publicKey);
  balanceMetrics.labels("nativeSol").set(nativeSOLBalance);

  for (const token of tokenWhitelist) {
    const tokenInAccounts = await connection.getParsedTokenAccountsByOwner(
      USER_KEYPAIR.publicKey,
      {
        programId: TOKEN_PROGRAM_ID,
        mint: new PublicKey(token.key),
      }
    );

    let totalBalance = 0;
    for (const account of tokenInAccounts.value) {
      const balance = +account.account.data.parsed.info.tokenAmount.amount;
      totalBalance += balance;
    }

    balanceMetrics.labels(token.ccy).set(totalBalance);
  }
}

async function getRoutes({
  jupiter,
  inputToken,
  outputToken,
  inputAmount,
  slippageBps,
}: {
  jupiter: Jupiter;
  inputToken?: Token;
  outputToken?: Token;
  inputAmount: number;
  slippageBps: number;
}) {
  try {
    if (!inputToken || !outputToken) {
      return null;
    }

    //  console.log( `Getting routes for ${inputAmount} ${inputToken.symbol} -> ${outputToken.symbol}...`);
    const inputAmountInSmallestUnits = inputToken
      ? Math.round(inputAmount * 10 ** inputToken.decimals)
      : 0;

    const routes =
      inputToken && outputToken
        ? await jupiter.computeRoutes({
            inputMint: new PublicKey(inputToken.address),
            outputMint: new PublicKey(outputToken.address),
            amount: JSBI.BigInt(inputAmountInSmallestUnits), // raw input amount of tokens
            slippageBps,
            forceFetch: true,
          })
        : null;

    if (routes && routes.routesInfos) {
      //   console.log("Possible number of routes:", routes.routesInfos.length);
      console.log(
        "Best quote: ",
        new Decimal(routes.routesInfos[0].outAmount.toString())
          .div(10 ** outputToken.decimals)
          .toString(),
        `(${outputToken.symbol})`,
        routes.routesInfos.length
      );
      return routes.routesInfos[0];
    } else {
      return null;
    }
  } catch (error) {
    console.log(error);
  }
}

async function executeSwap({
  jupiter,
  routeInfo,
  tokenData,
}: {
  jupiter: Jupiter;
  routeInfo: RouteInfo;
  tokenData: TokenParameter;
}) {
  try {
    console.log("try to create tx", unixTimestamp());
    // Prepare execute exchange
    const { execute } = await jupiter.exchange({
      routeInfo,
      wrapUnwrapSOL: false,
      computeUnitPriceMicroLamports: arbSettings.priorityFee,
    });

    console.log("tx " + unixTimestamp(), execute);

    // Execute swap
    const swapResult: any = await execute(); // Force any to ignore TS misidentifying SwapResult type
    console.log("tx created", unixTimestamp());

    if (swapResult.error) {
      if (swapResult.error.code === 6001) {
        attemptsMetrics
          .labels(
            "slippage",
            tokenData.ccy,
            tokenData.amount.toString(),
            arbSettings.threshold.toFixed(0)
          )
          .inc();
        console.log(
          tokenData.ccy,
          "Slippage",
          `https://solscan.io/tx/${swapResult.error.txid}`
        );
      } else {
        attemptsMetrics
          .labels(
            "other",
            tokenData.ccy,
            tokenData.amount.toString(),
            arbSettings.threshold.toFixed(0)
          )
          .inc();
        console.log(
          tokenData.ccy,
          "Other",
          `https://solscan.io/tx/${swapResult.error.txid}`
        );
      }
    } else {
      console.log(`https://solscan.io/tx/${swapResult.txid}`);
      console.log(
        `inputAddress=${swapResult.inputAddress.toString()} outputAddress=${swapResult.outputAddress.toString()}`
      );
      console.log(
        `inputAmount=${swapResult.inputAmount} outputAmount=${swapResult.outputAmount}`
      );
      attemptsMetrics
        .labels(
          "success",
          tokenData.ccy,
          tokenData.amount.toString(),
          arbSettings.threshold.toFixed(0)
        )
        .inc();
    }
  } catch (error) {
    throw error;
  }
}

async function main() {
  try {
    let currentIndex = 0;

    if (tokenWhitelist.length === 0) {
      console.log("No token whitelist found");
      return;
    }

    const jupiter = await Jupiter.load({
      connection,
      cluster: ENV,
      user: USER_KEYPAIR,
      wrapUnwrapSOL: false,
      usePreloadedAddressLookupTableCache: true,
      restrictIntermediateTokens: true,
      //  shouldLoadSerumOpenOrders: false,
    });
    console.log("Connected", unixTimestamp());

    while (true) {
      try {
        const tokenParams = tokenWhitelist[currentIndex];
        const best = await getRoutes({
          jupiter,
          inputToken: tokenParams.token,
          outputToken: tokenParams.token,
          inputAmount: tokenParams.amount, // 1 unit in UI
          slippageBps: arbSettings.slippagePct * 100, // 1% slippage
        });

        if (best) {
          let result = JSBI.LT(
            arbSettings.threshold,
            JSBI.subtract(best.otherAmountThreshold, best.inAmount)
          );
          if (result)
            executeSwap({
              jupiter,
              routeInfo: best!,
              tokenData: tokenParams,
            }).catch((e) => console.log(e));

          const value = JSBI.subtract(best.otherAmountThreshold, best.inAmount);

          console.log(
            tokenParams.ccy,
            "Spread",
            value.toString()
          );
          spreadMetrics.labels(tokenParams.ccy).set(JSBI.toNumber(value));
        } else {
          console.log(tokenParams.ccy, tokenParams.token, "No route found");
        }
      } catch (e) {
        console.log(`Unchaught error`);
        console.log(e);
        await new Promise((resolve) => setTimeout(resolve, 10000));
      } finally {
        currentIndex = (currentIndex + 1) % tokenWhitelist.length;
      }
    }
  } catch (e) {
    console.log({ e });
  }
}

async function runBot() {
  tokens = await (await fetch(TOKEN_LIST_URL[ENV])).json(); // Fetch token list from Jupiter API
  await setSettingsFromMongo();
  await updateBalance();
  setInterval(updateBalance, 60 * 1000);
  setInterval(setSettingsFromMongo, 30 * 1000);
  main();
}

runBot();

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.listen(config?.PORT, () => {
  console.log("Metrics server is running on port " + config?.PORT);
});
