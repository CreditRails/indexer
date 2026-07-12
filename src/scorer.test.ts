import { test } from "node:test";
import assert from "node:assert/strict";
import { tierForScore, scoreWallet } from "./scorer.js";
import { SCORE_MIN, THRESHOLDS } from "./config.js";
import type { WalletSignals } from "./signals.js";

test("tierForScore: boundary cutoffs match contract's score_to_tier", () => {
  assert.equal(tierForScore(850), "A");
  assert.equal(tierForScore(800), "A");
  assert.equal(tierForScore(799), "B");
  assert.equal(tierForScore(740), "B");
  assert.equal(tierForScore(739), "C");
  assert.equal(tierForScore(670), "C");
  assert.equal(tierForScore(669), "D");
  assert.equal(tierForScore(580), "D");
  assert.equal(tierForScore(579), "F");
  assert.equal(tierForScore(300), "F");
});

function signalsWithTxCount(txCount: number): WalletSignals {
  return {
    wallet: "GTEST",
    txCount,
    accountAgeDays: 100,
    txPerWeek: 5,
    inflowUsd: 1000,
    outflowUsd: 500,
    largeEvents: [],
    distinctAssets: 2,
    distinctCounterparties: 2,
    recurringCounterpartyCount: 1,
    hasRegularRecurrence: false,
  };
}

test("scoreWallet: below minTxForConfidentScore clamps to cold-start floor score", () => {
  const result = scoreWallet(signalsWithTxCount(THRESHOLDS.minTxForConfidentScore - 1));
  assert.equal(result.coldStart, true);
  assert.equal(result.score, SCORE_MIN);
  assert.equal(result.tier, "F");
  assert.equal(result.percentile, 0);
});

test("scoreWallet: at or above minTxForConfidentScore computes a real score, not cold-start", () => {
  const result = scoreWallet(signalsWithTxCount(THRESHOLDS.minTxForConfidentScore));
  assert.equal(result.coldStart, false);
  assert.ok(result.score >= SCORE_MIN && result.score <= 850);
});

test("scoreWallet: percentile tracks the score's position in the 300-850 range", () => {
  const result = scoreWallet(signalsWithTxCount(10));
  const expectedPercentile = Math.round(((result.score - SCORE_MIN) / (850 - SCORE_MIN)) * 100);
  assert.equal(result.percentile, expectedPercentile);
});

test("scoreWallet: strictly stronger signals never produce a lower score", () => {
  const weak = scoreWallet(signalsWithTxCount(5));
  const strong = scoreWallet({
    ...signalsWithTxCount(5),
    accountAgeDays: 800,
    inflowUsd: 20_000,
    outflowUsd: 0,
    distinctAssets: 10,
    distinctCounterparties: 10,
    recurringCounterpartyCount: 5,
    hasRegularRecurrence: true,
  });
  assert.ok(strong.score >= weak.score);
});
