import { NETWORKS, type NetworkName } from "./config.js";
import { accountExists, fetchEffects, fetchFirstOperation, fetchOperations, fetchPayments, fetchTrades } from "./horizon.js";
import { deriveSignals, type WalletSignals } from "./signals.js";
import { detectDefi, fetchBlendPositions, knownBlendPools } from "./defi.js";
import { scoreWallet, type ScoreResult } from "./scorer.js";

export interface ComputeResult {
  signals: WalletSignals;
  result: ScoreResult;
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
  return { signals, result };
}
