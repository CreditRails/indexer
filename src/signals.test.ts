import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSignals } from "./signals.js";
import type { HorizonPayment, HorizonTrade } from "./horizon.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WALLET = "GWALLET";

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

test("deriveSignals: sums inflow/outflow in USD and flags large events over the threshold", () => {
  const payments: HorizonPayment[] = [
    payment({ id: "p1", to: WALLET, from: "GCOUNTERPARTY1", amount: "600", created_at: daysAgo(10) }),
    payment({ id: "p2", from: WALLET, to: "GCOUNTERPARTY2", amount: "200", created_at: daysAgo(5) }),
  ];

  const signals = deriveSignals(WALLET, payments, []);

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

  const signals = deriveSignals(WALLET, payments, []);

  assert.equal(signals.inflowUsd, 100); // "old" payment filtered out of the 365-day lookback
  assert.equal(signals.txCount, 1);
  // accountAgeDays is derived from the oldest payment in the *unfiltered* array
  assert.ok(signals.accountAgeDays >= 399 && signals.accountAgeDays <= 401);
});

test("deriveSignals: regular recurring counterparty (even gaps) sets hasRegularRecurrence", () => {
  const payments: HorizonPayment[] = [
    payment({ id: "r1", to: WALLET, from: "GPAYROLL", amount: "100", created_at: daysAgo(90) }),
    payment({ id: "r2", to: WALLET, from: "GPAYROLL", amount: "100", created_at: daysAgo(60) }),
    payment({ id: "r3", to: WALLET, from: "GPAYROLL", amount: "100", created_at: daysAgo(30) }),
  ];

  const signals = deriveSignals(WALLET, payments, []);

  assert.equal(signals.recurringCounterpartyCount, 1);
  assert.equal(signals.hasRegularRecurrence, true);
});

test("deriveSignals: irregular recurring counterparty (uneven gaps) does not set hasRegularRecurrence", () => {
  const payments: HorizonPayment[] = [
    payment({ id: "i1", to: WALLET, from: "GIRREGULAR", amount: "100", created_at: daysAgo(200) }),
    payment({ id: "i2", to: WALLET, from: "GIRREGULAR", amount: "100", created_at: daysAgo(150) }),
    payment({ id: "i3", to: WALLET, from: "GIRREGULAR", amount: "100", created_at: daysAgo(10) }),
  ];

  const signals = deriveSignals(WALLET, payments, []);

  assert.equal(signals.recurringCounterpartyCount, 1); // still 3 repeats, just not evenly spaced
  assert.equal(signals.hasRegularRecurrence, false);
});

test("deriveSignals: fewer than minRecurrencesForRegularity repeats never counts as recurring", () => {
  const payments: HorizonPayment[] = [
    payment({ id: "o1", to: WALLET, from: "GONEOFF", amount: "100", created_at: daysAgo(90) }),
    payment({ id: "o2", to: WALLET, from: "GONEOFF", amount: "100", created_at: daysAgo(60) }),
  ];

  const signals = deriveSignals(WALLET, payments, []);

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

  const signals = deriveSignals(WALLET, [], trades);

  assert.equal(signals.largeEvents.length, 1);
  assert.equal(signals.largeEvents[0].kind, "swap");
  assert.equal(signals.distinctAssets, 2); // native + USDC
  assert.equal(signals.txCount, 1);
});
