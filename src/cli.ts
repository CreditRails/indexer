import { accountExists, fetchPayments, fetchTrades } from "./horizon.js";
import { deriveSignals } from "./signals.js";
import { scoreWallet } from "./scorer.js";
import { writeScoreOnChain } from "./contract.js";

async function main() {
  const wallet = process.argv[2];
  const write = process.argv.includes("--write");

  if (!wallet) {
    console.error("Usage: npm run score -- <WALLET_ADDRESS> [--write]");
    process.exit(1);
  }

  console.log(`\nFetching Horizon testnet history for ${wallet}...`);

  const exists = await accountExists(wallet);
  if (!exists) {
    console.error(`Account ${wallet} not found on testnet (unfunded or invalid).`);
    process.exit(1);
  }

  const [payments, trades] = await Promise.all([fetchPayments(wallet), fetchTrades(wallet)]);
  console.log(`  payments: ${payments.length}, trades: ${trades.length}`);

  const signals = deriveSignals(wallet, payments, trades);
  console.log("\nRaw signals:");
  console.log(`  tx count (${signals.txCount}), account age (${signals.accountAgeDays.toFixed(1)}d)`);
  console.log(`  tx/week: ${signals.txPerWeek.toFixed(2)}`);
  console.log(`  inflow $${signals.inflowUsd.toFixed(2)}, outflow $${signals.outflowUsd.toFixed(2)}`);
  console.log(`  large events (>=$500): ${signals.largeEvents.length}`);
  console.log(`  distinct assets: ${signals.distinctAssets}, distinct counterparties: ${signals.distinctCounterparties}`);
  console.log(`  recurring counterparties: ${signals.recurringCounterpartyCount}, regular: ${signals.hasRegularRecurrence}`);

  const result = scoreWallet(signals);
  console.log("\nFactor breakdown (0-100):");
  for (const [name, value] of Object.entries(result.factors)) {
    console.log(`  ${name}: ${value.toFixed(1)}`);
  }

  console.log(`\nScore: ${result.score}  Tier: ${result.tier}  Percentile: ${result.percentile}${result.coldStart ? "  (cold start — insufficient history)" : ""}`);

  if (write) {
    console.log("\nWriting to credit_score contract on testnet...");
    const { txUrl } = await writeScoreOnChain(wallet, result.score, result.percentile);
    console.log(txUrl ? `Done: ${txUrl}` : "Submitted (no tx url parsed).");
  } else {
    console.log("\n(dry run — pass --write to commit this score on-chain)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
