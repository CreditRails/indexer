import { ASSET_USD_PRICE, LOOKBACK_DAYS, THRESHOLDS } from "./config.js";
import type { HorizonPayment, HorizonTrade } from "./horizon.js";

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
  kind: "payment" | "swap";
  usd: number;
  at: string;
}

export interface WalletSignals {
  wallet: string;
  txCount: number;
  accountAgeDays: number;
  txPerWeek: number;
  inflowUsd: number;
  outflowUsd: number;
  largeEvents: LargeEvent[];
  distinctAssets: number;
  distinctCounterparties: number;
  recurringCounterpartyCount: number;
  hasRegularRecurrence: boolean;
}

export function deriveSignals(
  wallet: string,
  allPayments: HorizonPayment[],
  allTrades: HorizonTrade[]
): WalletSignals {
  const now = new Date();

  const payments = allPayments.filter((p) => withinLookback(p.created_at, now));
  const trades = allTrades.filter((t) => withinLookback(t.ledger_close_time, now));

  const firstEvent = allPayments[0]?.created_at ?? null;
  const accountAgeDays = firstEvent
    ? (now.getTime() - new Date(firstEvent).getTime()) / DAY_MS
    : 0;

  const activeDays = Math.max(1, Math.min(accountAgeDays, LOOKBACK_DAYS));
  const txCount = payments.length + trades.length;
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
    txPerWeek,
    inflowUsd,
    outflowUsd,
    largeEvents,
    distinctAssets: assets.size,
    distinctCounterparties: counterparties.size,
    recurringCounterpartyCount,
    hasRegularRecurrence,
  };
}
