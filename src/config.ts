/**
 * Every parameter used to judge a wallet lives in this one file.
 * Tune weights/thresholds here — nothing else in the indexer should
 * hardcode a number that affects the score.
 */

export const NETWORK = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
} as const;

/** Deployed testnet credit_score contract + the identity authorized to write to it. */
export const CONTRACT = {
  creditScoreId: "CAQGKWYTOSEE2BZSNOQCJCNPGMRXO75KU2P4YOPCYUBNVZWFLEYDZRAY",
  adminIdentity: "stealth402-deployer",
  network: "testnet",
} as const;

/** How far back we look at wallet history when computing a score. */
export const LOOKBACK_DAYS = 365;

/** Contract-enforced score range (must match contracts/credit_score/src/lib.rs). */
export const SCORE_MIN = 300;
export const SCORE_MAX = 850;

/** Must match `score_to_tier` in contracts/credit_score/src/lib.rs. */
export const TIER_CUTOFFS = [
  { min: 800, tier: "A" },
  { min: 740, tier: "B" },
  { min: 670, tier: "C" },
  { min: 580, tier: "D" },
  { min: 0, tier: "F" },
] as const;

/**
 * Rough USD conversion for testnet assets. Testnet has no real price feed,
 * so this is a static placeholder — mainnet should read from a price oracle.
 */
export const ASSET_USD_PRICE: Record<string, number> = {
  native: 0.1, // XLM
  USDC: 1,
  yUSDC: 1,
};

/** Each factor's weight in the final score. Must sum to 1. */
export const FACTOR_WEIGHTS = {
  paymentHistory: 0.3, // regularity/consistency of inflows and outflows
  transactionVolume: 0.2, // total USD moved, log-scaled
  accountAge: 0.15, // days since first observed activity
  savingsTrend: 0.15, // net inflow vs outflow (is the wallet accumulating?)
  remittanceRegularity: 0.1, // recurring same-counterparty inflows (payroll/remittance)
  diversity: 0.1, // distinct assets + counterparties touched
} as const;

/** Signal-level thresholds that feed the factor calculations above. */
export const THRESHOLDS = {
  /** A single payment/swap at or above this USD value counts as "large". */
  largeAmountUsd: 500,

  /** Transactions per week at/above this rate scores as "highly active". */
  highActivityTxPerWeek: 3,

  /** Below this many total transactions, we don't have enough signal to score confidently. */
  minTxForConfidentScore: 3,

  /** USD volume (in + out) that maps to a full 100 on the volume factor. */
  volumeUsdForMaxScore: 10_000,

  /** Wallet age in days that maps to a full 100 on the age factor. */
  ageDaysForMaxScore: 730,

  /** Distinct assets + counterparties combined that maps to a full 100 on diversity. */
  diversityCountForMaxScore: 10,

  /** Recurring counterparty: minimum repeat inflows from the same address to count as regular. */
  minRecurrencesForRegularity: 3,

  /** Recurring counterparty: max allowed stddev (in days) between repeats to count as "regular". */
  maxGapStdDevDaysForRegularity: 5,

  /** Wallets below minTxForConfidentScore get clamped to this score instead of computing factors. */
  coldStartScore: SCORE_MIN,
} as const;

export type FactorName = keyof typeof FACTOR_WEIGHTS;
