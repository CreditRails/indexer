import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CONTRACT, type NetworkName } from "./config.js";
import { computeForWallet } from "./compute.js";
import { writeScoreOnChain } from "./contract.js";

const PORT = Number(process.env.PORT ?? 4000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
const WALLET_RE = /^G[A-Z2-7]{55}$/;

if (!ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN is not set. Copy indexer/.env.example to indexer/.env and set a value.");
  process.exit(1);
}

function parseNetwork(url: URL): NetworkName | null {
  const raw = url.searchParams.get("network") ?? "testnet";
  return raw === "testnet" || raw === "mainnet" ? raw : null;
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
  const parts = url.pathname.split("/").filter(Boolean); // ["api","score",":wallet"] | [...,"commit"] | ["api","public","score",":wallet"]

  const network = parseNetwork(url);
  if (!network) {
    send(res, 400, { error: "invalid_network", message: "network must be 'testnet' or 'mainnet'." });
    return;
  }

  try {
    // GET /api/public/score/:wallet?network= — unauthenticated, dry-run only. No rate
    // limiting or API-key layer yet: local/dev use, same posture as the rest of the indexer.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "public" && parts[2] === "score" && parts[3]) {
      const wallet = decodeURIComponent(parts[3]);
      if (!WALLET_RE.test(wallet)) {
        send(res, 400, { error: "invalid_wallet", message: "Expected a Stellar G... public key." });
        return;
      }
      const { signals, result, recentPayments } = await computeForWallet(wallet, network);
      send(res, 200, { signals, recentPayments, ...result, network });
      return;
    }

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

    if (isRead) {
      const { signals, result, recentPayments } = await computeForWallet(wallet, network);
      send(res, 200, { signals, recentPayments, ...result, network });
      return;
    }

    if (isCommit) {
      if (network === "mainnet") {
        send(res, 400, { error: "unsupported_network", message: "No credit_score contract deployed on mainnet yet." });
        return;
      }
      const { signals, result, recentPayments } = await computeForWallet(wallet, network);
      const { txUrl } = await writeScoreOnChain(wallet, result.score, result.percentile, CONTRACT[network], network);
      send(res, 200, { signals, recentPayments, ...result, network, txUrl });
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
  console.log(`CreditRails API listening on http://localhost:${PORT}`);
  console.log(`  GET  /api/score/:wallet?network=          (admin, dry run — signals + factors + score)`);
  console.log(`  POST /api/score/:wallet/commit?network=   (admin, writes score on-chain — testnet only)`);
  console.log(`  GET  /api/public/score/:wallet?network=    (public, dry run — no auth yet)`);
});
