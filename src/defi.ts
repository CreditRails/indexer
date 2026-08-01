import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Address,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { DEFI_CONTRACTS, type NetworkConfig } from "./config.js";
import type { HorizonOperation } from "./horizon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "data");

export interface DefiMatch {
  contractId: string;
  protocol: "blend" | "soroswap" | "aqua";
  category: "lending" | "amm";
  role: string;
  functionName: string | null;
  at: string;
  transactionHash: string;
}

export interface DefiSignals {
  protocolsTouched: string[];
  interactionCount: number;
  matches: DefiMatch[];
}

export interface BlendPositionSummary {
  poolId: string;
  hasCollateral: boolean;
  hasLiabilities: boolean;
  hasSupply: boolean;
}

/** Discovered-pool cache so repeat `is_pool` RPC lookups aren't needed for wallets already seen. */
function cachePath(network: NetworkConfig): string {
  return join(CACHE_DIR, `pool-registry.${network.name}.json`);
}

function loadPoolCache(network: NetworkConfig): Set<string> {
  const path = cachePath(network);
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as string[];
    return new Set(raw);
  } catch {
    return new Set();
  }
}

function savePoolCache(network: NetworkConfig, pools: Set<string>): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(network), JSON.stringify([...pools], null, 2));
}

/** Decodes an `invoke_host_function` operation's [contract_address, function_name, ...args] parameters. */
export function decodeInvocation(op: HorizonOperation): { contractId: string; functionName: string } | null {
  const params = op.parameters;
  if (!params || params.length < 2) return null;
  try {
    const contractId = scValToNative(xdr.ScVal.fromXDR(params[0].value, "base64")) as string;
    const functionName = scValToNative(xdr.ScVal.fromXDR(params[1].value, "base64")) as string;
    if (typeof contractId !== "string" || !contractId.startsWith("C")) return null;
    return { contractId, functionName };
  } catch {
    return null;
  }
}

/**
 * Free, read-only check against the Blend pool factory: was `contractId` deployed by it?
 * Avoids needing to enumerate/cache every pool up front — works for any pool, old or new,
 * regardless of Soroban RPC event-retention limits.
 */
/** Caps how many *unique* unrecognized contracts get a live `is_pool` check per call, and how many run concurrently. */
const MAX_UNKNOWN_CONTRACTS_CHECKED = 25;
const CLASSIFY_CONCURRENCY = 8;

async function isBlendPool(
  contractId: string,
  network: NetworkConfig,
  account: Awaited<ReturnType<rpc.Server["getAccount"]>>,
  server: rpc.Server
): Promise<boolean> {
  const factoryEntry = Object.entries(DEFI_CONTRACTS[network.name]).find(
    ([, meta]) => meta.protocol === "blend" && meta.role === "poolFactoryV2"
  );
  if (!factoryEntry) return false;
  const [factoryId] = factoryEntry;

  try {
    const contract = new Contract(factoryId);
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: network.passphrase })
      .addOperation(contract.call("is_pool", Address.fromString(contractId).toScVal()))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return false;
    return Boolean(scValToNative(sim.result.retval));
  } catch {
    return false; // network hiccup or unrelated contract — don't fail the whole score for this
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Matches every `invoke_host_function` operation against the known DeFi registry
 * (`DEFI_CONTRACTS` in config.ts), falling back to a live `is_pool` check against the
 * Blend factory for contracts not already known — so newly created Blend pools are
 * still detected without a hardcoded, ever-staling pool list. Unrecognized contract IDs
 * are deduplicated and classified concurrently (not once per operation) so an active
 * wallet with many distinct contract calls doesn't serialize dozens of RPC round-trips.
 */
export async function detectDefi(
  operations: HorizonOperation[],
  network: NetworkConfig,
  sourceWallet: string
): Promise<DefiSignals> {
  const registry = DEFI_CONTRACTS[network.name];
  const poolCache = loadPoolCache(network);

  const matches: DefiMatch[] = [];
  const protocolsTouched = new Set<string>();
  const unknownOps: { contractId: string; functionName: string; at: string; transactionHash: string }[] = [];

  for (const op of operations) {
    if (op.type !== "invoke_host_function") continue;
    const decoded = decodeInvocation(op);
    if (!decoded) continue;
    const { contractId, functionName } = decoded;

    const known = registry[contractId];
    if (known) {
      matches.push({ contractId, protocol: known.protocol, category: known.category, role: known.role, functionName, at: op.created_at, transactionHash: op.transaction_hash });
      protocolsTouched.add(known.protocol);
      continue;
    }

    if (poolCache.has(contractId)) {
      matches.push({ contractId, protocol: "blend", category: "lending", role: "pool", functionName, at: op.created_at, transactionHash: op.transaction_hash });
      protocolsTouched.add("blend");
      continue;
    }

    unknownOps.push({ contractId, functionName, at: op.created_at, transactionHash: op.transaction_hash });
  }

  const uniqueUnknownIds = [...new Set(unknownOps.map((o) => o.contractId))].slice(0, MAX_UNKNOWN_CONTRACTS_CHECKED);
  if (uniqueUnknownIds.length > 0) {
    const server = new rpc.Server(network.rpcUrl);
    const account = await server.getAccount(sourceWallet);
    const classifications = await mapWithConcurrency(uniqueUnknownIds, CLASSIFY_CONCURRENCY, (id) =>
      isBlendPool(id, network, account, server)
    );

    let cacheDirty = false;
    const confirmedPools = new Set<string>();
    uniqueUnknownIds.forEach((id, i) => {
      if (classifications[i]) {
        confirmedPools.add(id);
        poolCache.add(id);
        cacheDirty = true;
      }
    });
    if (cacheDirty) savePoolCache(network, poolCache);

    for (const op of unknownOps) {
      if (confirmedPools.has(op.contractId)) {
        matches.push({ contractId: op.contractId, protocol: "blend", category: "lending", role: "pool", functionName: op.functionName, at: op.at, transactionHash: op.transactionHash });
        protocolsTouched.add("blend");
      }
    }
  }

  return {
    protocolsTouched: [...protocolsTouched],
    interactionCount: matches.length,
    matches,
  };
}

/**
 * Live collateral/liability/supply state for a wallet against known Blend pools, via the
 * pool's free read-only `get_positions(user)` call. Reflects current state — unaffected by
 * Horizon/RPC history retention limits, unlike event- or operation-based detection.
 */
export async function fetchBlendPositions(
  wallet: string,
  network: NetworkConfig,
  poolIds: string[]
): Promise<BlendPositionSummary[]> {
  const server = new rpc.Server(network.rpcUrl);
  const account = await server.getAccount(wallet);

  const results: BlendPositionSummary[] = [];
  for (const poolId of poolIds) {
    try {
      const contract = new Contract(poolId);
      const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: network.passphrase })
        .addOperation(contract.call("get_positions", Address.fromString(wallet).toScVal()))
        .setTimeout(30)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) continue;

      const positions = scValToNative(sim.result.retval) as {
        collateral: Map<number, bigint>;
        liabilities: Map<number, bigint>;
        supply: Map<number, bigint>;
      };
      results.push({
        poolId,
        hasCollateral: positions.collateral.size > 0,
        hasLiabilities: positions.liabilities.size > 0,
        hasSupply: positions.supply.size > 0,
      });
    } catch {
      // pool unreachable or wallet has no relationship with it — skip, don't fail the score
    }
  }
  return results;
}

/** Every Blend pool contract ID we currently know about for a network (registry + discovered cache). */
export function knownBlendPools(network: NetworkConfig): string[] {
  const registryPools = Object.entries(DEFI_CONTRACTS[network.name])
    .filter(([, meta]) => meta.protocol === "blend" && meta.role.startsWith("pool-"))
    .map(([id]) => id);
  return [...new Set([...registryPools, ...loadPoolCache(network)])];
}
