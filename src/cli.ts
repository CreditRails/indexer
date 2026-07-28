import { CONTRACT, type NetworkName } from "./config.js";
import { computeForWallet } from "./compute.js";
import { writeScoreOnChain } from "./contract.js";

async function main() {
  const wallet = process.argv[2];
  const write = process.argv.includes("--write");
  const networkArgIndex = process.argv.indexOf("--network");
  const network: NetworkName = networkArgIndex >= 0 ? (process.argv[networkArgIndex + 1] as NetworkName) : "testnet";

  if (!wallet || (network !== "testnet" && network !== "mainnet")) {
    console.error("Usage: npm run score -- <WALLET_ADDRESS> [--network testnet|mainnet] [--write]");
    process.exit(1);
  }

  if (write && network === "mainnet") {
    console.error("No credit_score contract is deployed on mainnet yet — mainnet is dry-run only.");
    process.exit(1);
  }

  console.log(`\nFetching Horizon ${network} history for ${wallet}...`);

  const { signals, result } = await computeForWallet(wallet, network);

  console.log("\nRaw signals:");
  console.log(
    `  tx count (${signals.txCount}), account age (${signals.accountAgeDays.toFixed(1)}d, ${signals.accountAgeConfidence})`
  );
  console.log(`  tx/week: ${signals.txPerWeek.toFixed(2)}`);
  console.log(`  inflow $${signals.inflowUsd.toFixed(2)}, outflow $${signals.outflowUsd.toFixed(2)}`);
  console.log(`  large events (>=$500): ${signals.largeEvents.length}`);
  console.log(`  distinct assets: ${signals.distinctAssets}, distinct counterparties: ${signals.distinctCounterparties}`);
  console.log(`  recurring counterparties: ${signals.recurringCounterpartyCount}, regular: ${signals.hasRegularRecurrence}`);
  console.log(
    `  DeFi protocols touched: ${signals.defiProtocolsTouched.join(", ") || "none"} (${signals.defiInteractionCount} interactions)`
  );
  if (signals.blendPositions.length > 0) {
    console.log(`  Blend positions: ${JSON.stringify(signals.blendPositions)}`);
  }

  console.log("\nFactor breakdown (0-100):");
  for (const [name, value] of Object.entries(result.factors)) {
    console.log(`  ${name}: ${value.toFixed(1)}`);
  }

  console.log(`\nScore: ${result.score}  Tier: ${result.tier}  Percentile: ${result.percentile}${result.coldStart ? "  (cold start — insufficient history)" : ""}`);

  if (write) {
    console.log(`\nWriting to credit_score contract on ${network}...`);
    const { txUrl } = await writeScoreOnChain(wallet, result.score, result.percentile, CONTRACT[network]);
    console.log(txUrl ? `Done: ${txUrl}` : "Submitted (no tx url parsed).");
  } else {
    console.log("\n(dry run — pass --write to commit this score on-chain)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
