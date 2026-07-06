import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { accountExists, fetchPayments, fetchTrades } from "./horizon.js";
import { deriveSignals } from "./signals.js";
import { scoreWallet } from "./scorer.js";
import { writeScoreOnChain } from "./contract.js";

const PORT = Number(process.env.PORT ?? 4000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
const WALLET_RE = /^G[A-Z2-7]{55}$/;

if (!ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN is not set. Copy indexer/.env.example to indexer/.env and set a value.");
  process.exit(1);
}

async function computeForWallet(wallet: string) {
  const exists = await accountExists(wallet);
  if (!exists) {
    throw Object.assign(new Error("Account not found on testnet (unfunded or invalid)."), {
      statusCode: 404,
    });
  }
  const [payments, trades] = await Promise.all([fetchPayments(wallet), fetchTrades(wallet)]);
  const signals = deriveSignals(wallet, payments, trades);
  const result = scoreWallet(signals);
  return { signals, result };
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(json);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") {
    send(res, 204, null);
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","score",":wallet"] or [...,"commit"]

  if (parts[0] !== "api" || parts[1] !== "score" || !parts[2]) {
    send(res, 404, { error: "not_found" });
    return;
  }

  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    send(res, 401, { error: "unauthorized" });
    return;
  }

  const wallet = decodeURIComponent(parts[2]);
  if (!WALLET_RE.test(wallet)) {
    send(res, 400, { error: "invalid_wallet", message: "Expected a Stellar G... public key." });
    return;
  }

  const isCommit = req.method === "POST" && parts[3] === "commit";
  const isRead = req.method === "GET" && parts.length === 3;

  try {
    if (isRead) {
      const { signals, result } = await computeForWallet(wallet);
      send(res, 200, { wallet, signals, ...result });
      return;
    }

    if (isCommit) {
      const { signals, result } = await computeForWallet(wallet);
      const { txUrl } = await writeScoreOnChain(wallet, result.score, result.percentile);
      send(res, 200, { wallet, signals, ...result, txUrl });
      return;
    }

    send(res, 404, { error: "not_found" });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    send(res, statusCode, { error: "internal_error", message: (err as Error).message });
  }
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    send(res, 500, { error: "internal_error" });
  });
}).listen(PORT, () => {
  console.log(`CreditRails admin API listening on http://localhost:${PORT}`);
  console.log(`  GET  /api/score/:wallet         (dry run — signals + factors + score)`);
  console.log(`  POST /api/score/:wallet/commit  (writes score on-chain)`);
});
