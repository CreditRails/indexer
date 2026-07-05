import { FACTOR_WEIGHTS, THRESHOLDS, type FactorName } from "./config.js";
import type { WalletSignals } from "./signals.js";

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** log-scale so early volume matters more than marginal volume at the high end. */
function logScale(value: number, maxForFullScore: number): number {
  if (value <= 0) return 0;
  const ratio = Math.log10(1 + value) / Math.log10(1 + maxForFullScore);
  return clamp100(ratio * 100);
}

export type Factors = Record<FactorName, number>;

export function computeFactors(signals: WalletSignals): Factors {
  const paymentHistory = clamp100(
    (signals.hasRegularRecurrence ? 60 : 0) +
      Math.min(40, signals.recurringCounterpartyCount * 10) +
      Math.min(20, (signals.txPerWeek / THRESHOLDS.highActivityTxPerWeek) * 20)
  );

  const transactionVolume = logScale(
    signals.inflowUsd + signals.outflowUsd,
    THRESHOLDS.volumeUsdForMaxScore
  );

  const accountAge = clamp100((signals.accountAgeDays / THRESHOLDS.ageDaysForMaxScore) * 100);

  // Net accumulation relative to total flow — a wallet that only spends what it
  // receives scores lower here than one that's building a balance over time.
  const totalFlow = signals.inflowUsd + signals.outflowUsd;
  const net = signals.inflowUsd - signals.outflowUsd;
  const savingsTrend = totalFlow === 0 ? 0 : clamp100(((net / totalFlow) * 0.5 + 0.5) * 100);

  const remittanceRegularity = clamp100(
    (signals.hasRegularRecurrence ? 70 : 0) +
      Math.min(30, signals.recurringCounterpartyCount * 10)
  );

  const diversity = clamp100(
    ((signals.distinctAssets + signals.distinctCounterparties) /
      THRESHOLDS.diversityCountForMaxScore) *
      100
  );

  return {
    paymentHistory,
    transactionVolume,
    accountAge,
    savingsTrend,
    remittanceRegularity,
    diversity,
  };
}

export function weightedFactorAverage(factors: Factors): number {
  let total = 0;
  for (const [name, weight] of Object.entries(FACTOR_WEIGHTS) as [FactorName, number][]) {
    total += factors[name] * weight;
  }
  return total; // 0-100
}
