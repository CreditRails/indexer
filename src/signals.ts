import { ASSET_USD_PRICE, LOOKBACK_DAYS, THRESHOLDS } from "./config.js";
import type { HorizonEffect, HorizonOperation, HorizonPayment, HorizonTrade } from "./horizon.js";
import type { BlendPositionSummary, DefiSignals } from "./defi.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function assetKey(assetType: string, assetCode?: string): string {
  return assetType === "native" ? "native" : assetCode ?? "unknown";
}

function usdValue(amount: string | undefined, key: string): number {
  if (!amount) return 0;
  const price = ASSET_USD_PRICE[key] ?? 0;
  return parseFloat(amount) * price;
}

function withinLookback(dateIso: string, now: Date): boolean {
  return now.getTime() - new Date(dateIso).getTime() <= LOOKBACK_DAYS * DAY_MS;
}

function stddev(values: number[]): number {
  if (values.length < 2) return Infinity;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export interface LargeEvent {
  kind: "payment" | "swap" | "contract_transfer";
  usd: number;
  at: string;
}

export type AccountAgeConfidence = "exact" | "estimated";

export interface WalletSignals {
  wallet: string;
  txCount: number;
  accountAgeDays: number;
  /**
   * "exact" when a `create_account` operation was found (age is precise).
   * "estimated" when it wasn't — the wallet is *at least* this old; on mainnet this
   * usually means it predates Horizon's 1-year retention window. Point `horizonUrl`
   * at a full-history provider (see NETWORKS.mainnet.archivalHorizonUrl) for an exact figure.
   */
  accountAgeConfidence: AccountAgeConfidence;
  txPerWeek: number;
  inflowUsd: number;
  outflowUsd: number;
  largeEvents: LargeEvent[];
  distinctAssets: number;
  distinctCounterparties: number;
  recurringCounterpartyCount: number;
  hasRegularRecurrence: boolean;
  defiProtocolsTouched: string[];
  defiInteractionCount: number;
  blendPositions: BlendPositionSummary[];
}

export function deriveSignals(
  wallet: string,
  allPayments: HorizonPayment[],
  allTrades: HorizonTrade[],
  allOperations: HorizonOperation[],
  allEffects: HorizonEffect[],
  firstOperation: HorizonOperation | null,
  defi: DefiSignals,
  blendPositions: BlendPositionSummary[]
): WalletSignals {
  const now = new Date();

  const payments = allPayments.filter((p) => withinLookback(p.created_at, now));
  const trades = allTrades.filter((t) => withinLookback(t.ledger_close_time, now));
  const contractEffects = allEffects.filter(
    (e) => (e.type === "contract_credited" || e.type === "contract_debited") && withinLookback(e.created_at, now)
  );

  // `firstOperation` comes from a dedicated, uncapped request (see fetchFirstOperation) —
  // `allOperations`/`allPayments` are most-recent-first and capped, so they can't be trusted
  // to contain the account's true earliest record for high-activity wallets.
  const accountAgeConfidence: AccountAgeConfidence = firstOperation?.type === "create_account" ? "exact" : "estimated";
  const ageAnchor = firstOperation?.created_at ?? null;
  const accountAgeDays = ageAnchor ? (now.getTime() - new Date(ageAnchor).getTime()) / DAY_MS : 0;

  const activeDays = Math.max(1, Math.min(accountAgeDays, LOOKBACK_DAYS));
  const txCount = payments.length + trades.length + contractEffects.length;
  const txPerWeek = (txCount / activeDays) * 7;

  let inflowUsd = 0;
  let outflowUsd = 0;
  const largeEvents: LargeEvent[] = [];
  const assets = new Set<string>();
  const counterparties = new Set<string>();
  const inflowsByCounterparty = new Map<string, string[]>(); // address -> sorted created_at[]

  for (const p of payments) {
    const key = assetKey(p.asset_type, p.asset_code);
    assets.add(key);
    const amount = p.amount ?? p.starting_balance;
    const usd = usdValue(amount, key);

    const isInflow = p.to === wallet;
    const isOutflow = p.from === wallet;
    if (isInflow) {
      inflowUsd += usd;
      if (p.from) {
        counterparties.add(p.from);
        const list = inflowsByCounterparty.get(p.from) ?? [];
        list.push(p.created_at);
        inflowsByCounterparty.set(p.from, list);
      }
    }
    if (isOutflow) {
      outflowUsd += usd;
      if (p.to) counterparties.add(p.to);
    }

    if (usd >= THRESHOLDS.largeAmountUsd) {
      largeEvents.push({ kind: "payment", usd, at: p.created_at });
    }
  }

  for (const t of trades) {
    const baseKey = assetKey(t.base_asset_type, t.base_asset_code);
    const counterKey = assetKey(t.counter_asset_type, t.counter_asset_code);
    assets.add(baseKey);
    assets.add(counterKey);

    const swapUsd = Math.max(
      usdValue(t.base_amount, baseKey),
      usdValue(t.counter_amount, counterKey)
    );
    if (swapUsd >= THRESHOLDS.largeAmountUsd) {
      largeEvents.push({ kind: "swap", usd: swapUsd, at: t.ledger_close_time });
    }
  }

  // Soroban token transfers (e.g. SAC-wrapped assets moved via a contract call) never
  // appear as classic payments — effects are the only place they show up. No counterparty
  // is exposed here, so these contribute to volume/large-event signals but not recurrence.
  for (const e of contractEffects) {
    const key = assetKey(e.asset_type ?? "native", e.asset_code);
    assets.add(key);
    const usd = usdValue(e.amount, key);

    if (e.type === "contract_credited") inflowUsd += usd;
    if (e.type === "contract_debited") outflowUsd += usd;

    if (usd >= THRESHOLDS.largeAmountUsd) {
      largeEvents.push({ kind: "contract_transfer", usd, at: e.created_at });
    }
  }

  let recurringCounterpartyCount = 0;
  let hasRegularRecurrence = false;
  for (const dates of inflowsByCounterparty.values()) {
    if (dates.length < THRESHOLDS.minRecurrencesForRegularity) continue;
    recurringCounterpartyCount += 1;

    const sorted = [...dates].sort();
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / DAY_MS);
    }
    if (stddev(gaps) <= THRESHOLDS.maxGapStdDevDaysForRegularity) {
      hasRegularRecurrence = true;
    }
  }

  return {
    wallet,
    txCount,
    accountAgeDays,
    accountAgeConfidence,
    txPerWeek,
    inflowUsd,
    outflowUsd,
    largeEvents,
    distinctAssets: assets.size,
    distinctCounterparties: counterparties.size,
    recurringCounterpartyCount,
    hasRegularRecurrence,
    defiProtocolsTouched: defi.protocolsTouched,
    defiInteractionCount: defi.interactionCount,
    blendPositions,
  };
}
