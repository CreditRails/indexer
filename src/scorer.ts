import { SCORE_MIN, SCORE_MAX, THRESHOLDS, TIER_CUTOFFS } from "./config.js";
import { computeFactors, weightedFactorAverage, type Factors } from "./factors.js";
import type { WalletSignals } from "./signals.js";

export type RiskTier = (typeof TIER_CUTOFFS)[number]["tier"];

export interface ScoreResult {
  wallet: string;
  score: number;
  tier: RiskTier;
  percentile: number;
  factors: Factors;
  coldStart: boolean;
}

export function tierForScore(score: number): RiskTier {
  for (const cutoff of TIER_CUTOFFS) {
    if (score >= cutoff.min) return cutoff.tier;
  }
  return "F";
}

export function scoreWallet(signals: WalletSignals): ScoreResult {
  if (signals.txCount < THRESHOLDS.minTxForConfidentScore) {
    const score = THRESHOLDS.coldStartScore;
    return {
      wallet: signals.wallet,
      score,
      tier: tierForScore(score),
      percentile: Math.round(((score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * 100),
      factors: computeFactors(signals),
      coldStart: true,
    };
  }

  const factors = computeFactors(signals);
  const avg = weightedFactorAverage(factors); // 0-100
  const score = Math.round(SCORE_MIN + (avg / 100) * (SCORE_MAX - SCORE_MIN));
  const percentile = Math.round(((score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * 100);

  return {
    wallet: signals.wallet,
    score,
    tier: tierForScore(score),
    percentile,
    factors,
    coldStart: false,
  };
}
