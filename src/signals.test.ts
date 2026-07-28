import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSignals } from "./signals.js";
import type { HorizonEffect, HorizonOperation, HorizonPayment, HorizonTrade } from "./horizon.js";
import type { DefiSignals } from "./defi.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WALLET = "GWALLET";
const NO_DEFI: DefiSignals = { protocolsTouched: [], interactionCount: 0, matches: [] };

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

function payment(overrides: Partial<HorizonPayment>): HorizonPayment {
  return {
    id: "p1",
    type: "payment",
    created_at: daysAgo(1),
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    ...overrides,
  };
}

function operation(overrides: Partial<HorizonOperation>): HorizonOperation {
  return {
    id: "op1",
    type: "payment",
    created_at: daysAgo(1),
    source_account: WALLET,
    transaction_hash: "hash1",
    transaction_successful: true,
    ...overrides,
  };
}

function derive(
  payments: HorizonPayment[],
  trades: HorizonTrade[],
  operations: HorizonOperation[] = [],
  effects: HorizonEffect[] = [],
  firstOperation: HorizonOperation | null = null,
  defi: DefiSignals = NO_DEFI
) {
  return deriveSignals(WALLET, payments, trades, operations, effects, firstOperation, defi, []);
}

test("deriveSignals: sums inflow/outflow in USD and flags large events over the threshold", () => {
  const payments: HorizonPayment[] = [
    payment({ id: "p1", to: WALLET, from: "GCOUNTERPARTY1", amount: "600", created_at: daysAgo(10) }),
    payment({ id: "p2", from: WALLET, to: "GCOUNTERPARTY2", amount: "200", created_at: daysAgo(5) }),
  ];

  const signals = derive(payments, []);

  assert.equal(signals.inflowUsd, 600);
  assert.equal(signals.outflowUsd, 200);
  assert.equal(signals.largeEvents.length, 1); // only the 600 payment clears the $500 threshold
  assert.equal(signals.distinctAssets, 1);
  assert.equal(signals.distinctCounterparties, 2);
  assert.equal(signals.txCount, 2);
});

test("deriveSignals: excludes payments older than the lookback window from flow/tx totals", () => {
  const payments: HorizonPayment[] = [
    payment({ id: "old", to: WALLET, from: "GOLD", amount: "1000", created_at: daysAgo(400) }),
    payment({ id: "recent", to: WALLET, from: "GRECENT", amount: "100", created_at: daysAgo(10) }),
  ];

  const signals = derive(payments, []);

  assert.equal(signals.inflowUsd, 100); // "old" payment filtered out of the 365-day lookback
  assert.equal(signals.txCount, 1);
});

test("deriveSignals: regular recurring counterparty (even gaps) sets hasRegularRecurrence", () => {
  const payments: HorizonPayment[] = [
    payment({ id: "r1", to: WALLET, from: "GPAYROLL", amount: "100", created_at: daysAgo(90) }),
    payment({ id: "r2", to: WALLET, from: "GPAYROLL", amount: "100", created_at: daysAgo(60) }),
    payment({ id: "r3", to: WALLET, from: "GPAYROLL", amount: "100", created_at: daysAgo(30) }),
  ];

  const signals = derive(payments, []);

  assert.equal(signals.recurringCounterpartyCount, 1);
  assert.equal(signals.hasRegularRecurrence, true);
});

test("deriveSignals: irregular recurring counterparty (uneven gaps) does not set hasRegularRecurrence", () => {
  const payments: HorizonPayment[] = [
    payment({ id: "i1", to: WALLET, from: "GIRREGULAR", amount: "100", created_at: daysAgo(200) }),
    payment({ id: "i2", to: WALLET, from: "GIRREGULAR", amount: "100", created_at: daysAgo(150) }),
    payment({ id: "i3", to: WALLET, from: "GIRREGULAR", amount: "100", created_at: daysAgo(10) }),
  ];

  const signals = derive(payments, []);

  assert.equal(signals.recurringCounterpartyCount, 1); // still 3 repeats, just not evenly spaced
  assert.equal(signals.hasRegularRecurrence, false);
});

test("deriveSignals: fewer than minRecurrencesForRegularity repeats never counts as recurring", () => {
  const payments: HorizonPayment[] = [
    payment({ id: "o1", to: WALLET, from: "GONEOFF", amount: "100", created_at: daysAgo(90) }),
    payment({ id: "o2", to: WALLET, from: "GONEOFF", amount: "100", created_at: daysAgo(60) }),
  ];

  const signals = derive(payments, []);

  assert.equal(signals.recurringCounterpartyCount, 0);
  assert.equal(signals.hasRegularRecurrence, false);
});

test("deriveSignals: large swaps from trades are detected and counted toward distinct assets", () => {
  const trades: HorizonTrade[] = [
    {
      id: "t1",
      ledger_close_time: daysAgo(2),
      base_account: WALLET,
      base_asset_type: "native",
      base_amount: "10000", // 10000 * 0.1 (native price) = $1000
      counter_account: "GDEX",
      counter_asset_type: "credit_alphanum4",
      counter_asset_code: "USDC",
      counter_amount: "1000",
    },
  ];

  const signals = derive([], trades);

  assert.equal(signals.largeEvents.length, 1);
  assert.equal(signals.largeEvents[0].kind, "swap");
  assert.equal(signals.distinctAssets, 2); // native + USDC
  assert.equal(signals.txCount, 1);
});

test("deriveSignals: accountAgeConfidence is 'exact' and uses create_account timestamp when firstOperation is a create_account", () => {
  const firstOperation = operation({
    id: "ca",
    type: "create_account",
    account: WALLET,
    funder: "GFUNDER",
    starting_balance: "10",
    created_at: daysAgo(500),
  });

  const signals = derive([], [], [], [], firstOperation);

  assert.equal(signals.accountAgeConfidence, "exact");
  assert.ok(signals.accountAgeDays >= 499 && signals.accountAgeDays <= 501);
});

test("deriveSignals: accountAgeConfidence is 'estimated' when firstOperation isn't a create_account (capped/pruned history)", () => {
  const firstOperation = operation({ id: "p1", type: "payment", to: WALLET, from: "GX", amount: "50", created_at: daysAgo(50) });

  const signals = derive([], [], [], [], firstOperation);

  assert.equal(signals.accountAgeConfidence, "estimated");
  assert.ok(signals.accountAgeDays >= 49 && signals.accountAgeDays <= 51);
});

test("deriveSignals: accountAgeDays is 0 and confidence is 'estimated' when firstOperation is null", () => {
  const signals = derive([], []);

  assert.equal(signals.accountAgeConfidence, "estimated");
  assert.equal(signals.accountAgeDays, 0);
});

test("deriveSignals: age is independent of the (capped, most-recent-first) operations/payments lists", () => {
  // Simulates a high-activity wallet where `fetchOperations`/`fetchPayments` are capped and
  // never reach the true earliest record — only the dedicated `firstOperation` fetch does.
  const recentOnlyOperations: HorizonOperation[] = [
    operation({ id: "recent1", type: "payment", created_at: daysAgo(1) }),
  ];
  const recentOnlyPayments: HorizonPayment[] = [payment({ id: "recent1", created_at: daysAgo(1) })];
  const firstOperation = operation({ id: "ca", type: "create_account", created_at: daysAgo(1000) });

  const signals = derive(recentOnlyPayments, [], recentOnlyOperations, [], firstOperation);

  assert.equal(signals.accountAgeConfidence, "exact");
  assert.ok(signals.accountAgeDays >= 999 && signals.accountAgeDays <= 1001);
});

test("deriveSignals: contract_credited/contract_debited effects contribute to volume and large events", () => {
  const effects: HorizonEffect[] = [
    { id: "e1", type: "contract_credited", created_at: daysAgo(5), account: WALLET, asset_type: "native", amount: "6000" }, // $600
    { id: "e2", type: "contract_debited", created_at: daysAgo(3), account: WALLET, asset_type: "native", amount: "100" }, // $10
  ];

  const signals = derive([], [], [], effects);

  assert.equal(signals.inflowUsd, 600);
  assert.equal(signals.outflowUsd, 10);
  assert.equal(signals.largeEvents.length, 1);
  assert.equal(signals.largeEvents[0].kind, "contract_transfer");
  assert.equal(signals.txCount, 2);
});

test("deriveSignals: passes DeFi signals and Blend positions straight through", () => {
  const defi: DefiSignals = { protocolsTouched: ["blend", "soroswap"], interactionCount: 3, matches: [] };
  const signals = deriveSignals(WALLET, [], [], [], [], null, defi, [
    { poolId: "CPOOL", hasCollateral: true, hasLiabilities: false, hasSupply: true },
  ]);

  assert.deepEqual(signals.defiProtocolsTouched, ["blend", "soroswap"]);
  assert.equal(signals.defiInteractionCount, 3);
  assert.equal(signals.blendPositions.length, 1);
  assert.equal(signals.blendPositions[0].hasCollateral, true);
});
