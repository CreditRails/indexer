import { NETWORKS, type NetworkName } from "./config.js";
import { accountExists, fetchEffects, fetchFirstOperation, fetchOperations, fetchPayments, fetchTrades, type HorizonPayment } from "./horizon.js";
import { deriveSignals, type WalletSignals } from "./signals.js";
import { detectDefi, fetchBlendPositions, knownBlendPools, type DefiMatch } from "./defi.js";
import { scoreWallet, type ScoreResult } from "./scorer.js";
import { recordScore, getHistory, type ScoreSnapshot } from "./history.js";

export interface ComputeResult {
  signals: WalletSignals;
  result: ScoreResult;
  /** Most recent payments (desc), capped for API/dashboard display — not itself a scoring input beyond what signals already derived. */
  recentPayments: HorizonPayment[];
  /** Real recorded score snapshots for this wallet, up to 180 days back — empty until enough real usage accumulates. Never synthetic. */
  history: ScoreSnapshot[];
  /** Real invoke_host_function calls matched to a known DeFi contract (swaps, deposits, etc.) — these never appear in recentPayments since they're not classic Horizon payments. */
  defiActivity: DefiMatch[];
}

/**
 * Full pipeline for a single wallet on a single network: pulls payments, trades, full
 * operation/effect history, DeFi interactions, and live Blend positions, then scores it.
 * Shared by the CLI and the admin/public HTTP API so both stay in sync.
 */
export async function computeForWallet(wallet: string, networkName: NetworkName): Promise<ComputeResult> {
  const network = NETWORKS[networkName];

  const exists = await accountExists(wallet, network);
  if (!exists) {
    throw Object.assign(new Error(`Account not found on ${networkName} (unfunded or invalid).`), {
      statusCode: 404,
    });
  }

  const [payments, trades, operations, effects, firstOperation] = await Promise.all([
    fetchPayments(wallet, network),
    fetchTrades(wallet, network),
    fetchOperations(wallet, network),
    fetchEffects(wallet, network),
    fetchFirstOperation(wallet, network),
  ]);

  const defi = await detectDefi(operations, network, wallet);
  const blendPositions = await fetchBlendPositions(wallet, network, knownBlendPools(network));

  const signals = deriveSignals(wallet, payments, trades, operations, effects, firstOperation, defi, blendPositions);
  const result = scoreWallet(signals);
  recordScore(network, wallet, result.score, result.tier);
  return {
    signals,
    result,
    recentPayments: payments.slice(0, 25),
    history: getHistory(network, wallet, 180),
    defiActivity: defi.matches.slice(0, 25),
  };
}
