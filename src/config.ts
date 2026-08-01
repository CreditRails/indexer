/**
 * Every parameter used to judge a wallet lives in this one file.
 * Tune weights/thresholds here — nothing else in the indexer should
 * hardcode a number that affects the score.
 */

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  horizonUrl: string;
  /** Full-history Horizon override. Public mainnet Horizon truncates to 1 year (SDF policy since Aug 2024). */
  archivalHorizonUrl?: string;
  rpcUrl: string;
  passphrase: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    name: "mainnet",
    horizonUrl: "https://horizon.stellar.org",
    // LOBSTR keeps full history; use for exact wallet age beyond SDF's 1-year window.
    archivalHorizonUrl: "https://horizon.stellar.lobstr.co",
    // Free, no-signup, archive-capable public RPC. Fallback: https://archive-rpc.lightsail.network/
    rpcUrl: "https://rpc.ankr.com/stellar_soroban",
    passphrase: "Public Global Stellar Network ; September 2015",
  },
} as const;

export const DEFAULT_NETWORK: NetworkName = "testnet";

/** Deployed credit_score contract + the identity authorized to write to it, per network. */
export const CONTRACT: Record<NetworkName, { creditScoreId: string | null; adminIdentity: string | null }> = {
  testnet: {
    creditScoreId: "CAQGKWYTOSEE2BZSNOQCJCNPGMRXO75KU2P4YOPCYUBNVZWFLEYDZRAY",
    adminIdentity: "stealth402-deployer",
  },
  // No mainnet credit_score contract deployed yet — mainnet is dry-run/scoring only.
  mainnet: {
    creditScoreId: null,
    adminIdentity: null,
  },
};

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
 * so this is a static placeholder — mainnet should read from a price oracle
 * (e.g. the Reflector Soroban oracle). Not addressed in this pass.
 */
export const ASSET_USD_PRICE: Record<string, number> = {
  native: 0.1, // XLM
  USDC: 1,
  yUSDC: 1,
};

/**
 * Verified DeFi protocol contract addresses, per network. See defi-registry.ts.
 * Aqua (Aquarius) is mainnet-only here on purpose — its own docs (docs.aqua.network) state the
 * testnet router address changes across testnet resets, and an earlier search turned up a
 * different value than the current one, confirming it. Re-verify against Aquarius's docs before
 * adding a testnet entry — see data/pending-defi-integrations.md.
 */
export const DEFI_CONTRACTS: Record<
  NetworkName,
  Record<string, { protocol: "blend" | "soroswap" | "aqua"; category: "lending" | "amm"; role: string }>
> = {
  mainnet: {
    CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU: { protocol: "blend", category: "lending", role: "poolFactoryV2" },
    CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7: { protocol: "blend", category: "lending", role: "backstopV2" },
    CCOQM6S7ICIUWA225O5PSJWUBEMXGFSSW2PQFO6FP4DQEKMS5DASRGRR: { protocol: "blend", category: "lending", role: "emitter" },
    CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM: { protocol: "blend", category: "lending", role: "comet-BLND-USDC" },
    CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH: { protocol: "soroswap", category: "amm", role: "router" },
    CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2: { protocol: "soroswap", category: "amm", role: "factory" },
    CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK: { protocol: "aqua", category: "amm", role: "router" },
  },
  testnet: {
    CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6: { protocol: "blend", category: "lending", role: "poolFactoryV2" },
    CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA: { protocol: "blend", category: "lending", role: "backstopV2" },
    CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF: { protocol: "blend", category: "lending", role: "pool-TestnetV2" },
    CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD: { protocol: "soroswap", category: "amm", role: "router" },
    CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY: { protocol: "soroswap", category: "amm", role: "factory" },
  },
};

/** Each factor's weight in the final score. Must sum to 1. */
export const FACTOR_WEIGHTS = {
  paymentHistory: 0.27, // regularity/consistency of inflows and outflows
  transactionVolume: 0.18, // total USD moved, log-scaled
  accountAge: 0.13, // days since first observed activity
  savingsTrend: 0.13, // net inflow vs outflow (is the wallet accumulating?)
  remittanceRegularity: 0.09, // recurring same-counterparty inflows (payroll/remittance)
  diversity: 0.09, // distinct assets + counterparties touched
  defiParticipation: 0.11, // active lending positions + protocol diversity (Blend, Soroswap, ...)
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

  /** Distinct DeFi protocols touched that maps to a full 100 on the diversity portion of defiParticipation. */
  defiProtocolsForMaxScore: 3,

  /** Wallets below minTxForConfidentScore get clamped to this score instead of computing factors. */
  coldStartScore: SCORE_MIN,
} as const;

export type FactorName = keyof typeof FACTOR_WEIGHTS;
