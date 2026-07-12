import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFactors, weightedFactorAverage } from "./factors.js";
import type { WalletSignals } from "./signals.js";

function baseSignals(overrides: Partial<WalletSignals> = {}): WalletSignals {
  return {
    wallet: "GTEST",
    txCount: 10,
    accountAgeDays: 0,
    txPerWeek: 0,
    inflowUsd: 0,
    outflowUsd: 0,
    largeEvents: [],
    distinctAssets: 0,
    distinctCounterparties: 0,
    recurringCounterpartyCount: 0,
    hasRegularRecurrence: false,
    ...overrides,
  };
}

test("computeFactors: all-zero signals produce all-zero factors", () => {
  const factors = computeFactors(baseSignals());
  assert.equal(factors.paymentHistory, 0);
  assert.equal(factors.transactionVolume, 0);
  assert.equal(factors.accountAge, 0);
  assert.equal(factors.savingsTrend, 0);
  assert.equal(factors.remittanceRegularity, 0);
  assert.equal(factors.diversity, 0);
});

test("computeFactors: clamps accountAge and diversity at 100 past their max thresholds", () => {
  const factors = computeFactors(
    baseSignals({ accountAgeDays: 10_000, distinctAssets: 50, distinctCounterparties: 50 })
  );
  assert.equal(factors.accountAge, 100);
  assert.equal(factors.diversity, 100);
});

test("computeFactors: savingsTrend is 100 when only inflow, 0 when only outflow", () => {
  const savingOnly = computeFactors(baseSignals({ inflowUsd: 1000, outflowUsd: 0 }));
  const spendingOnly = computeFactors(baseSignals({ inflowUsd: 0, outflowUsd: 1000 }));
  assert.equal(savingOnly.savingsTrend, 100);
  assert.equal(spendingOnly.savingsTrend, 0);
});

test("computeFactors: savingsTrend is 50 when inflow exactly equals outflow", () => {
  const factors = computeFactors(baseSignals({ inflowUsd: 500, outflowUsd: 500 }));
  assert.equal(factors.savingsTrend, 50);
});

test("computeFactors: remittanceRegularity rewards regular recurrence and repeat counterparties", () => {
  const regular = computeFactors(
    baseSignals({ hasRegularRecurrence: true, recurringCounterpartyCount: 3 })
  );
  const irregular = computeFactors(baseSignals({ hasRegularRecurrence: false }));
  assert.equal(regular.remittanceRegularity, 100); // 70 + min(30, 3*10)
  assert.equal(irregular.remittanceRegularity, 0);
});

test("weightedFactorAverage: all factors at 100 averages to 100", () => {
  const avg = weightedFactorAverage({
    paymentHistory: 100,
    transactionVolume: 100,
    accountAge: 100,
    savingsTrend: 100,
    remittanceRegularity: 100,
    diversity: 100,
  });
  assert.equal(avg, 100);
});

test("weightedFactorAverage: respects individual factor weights", () => {
  const avg = weightedFactorAverage({
    paymentHistory: 100, // weight 0.30
    transactionVolume: 0,
    accountAge: 0,
    savingsTrend: 0,
    remittanceRegularity: 0,
    diversity: 0,
  });
  assert.equal(avg, 30);
});
