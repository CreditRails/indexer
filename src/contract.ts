import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONTRACT } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * Writes a computed score on-chain by shelling out to the `stellar` CLI
 * (already configured with the `stealth402-deployer` identity). Avoids
 * re-implementing Soroban transaction signing in JS.
 */
export async function writeScoreOnChain(
  wallet: string,
  score: number,
  percentile: number
): Promise<{ txUrl: string | null; raw: string }> {
  const args = [
    "contract",
    "invoke",
    "--id",
    CONTRACT.creditScoreId,
    "--source",
    CONTRACT.adminIdentity,
    "--network",
    CONTRACT.network,
    "--",
    "update_score",
    "--wallet",
    wallet,
    "--score",
    String(score),
    "--percentile",
    String(percentile),
  ];

  const { stdout, stderr } = await execFileAsync("stellar", args);
  const raw = `${stdout}${stderr}`;
  const match = raw.match(/https:\/\/stellar\.expert\/explorer\/testnet\/tx\/\S+/);
  return { txUrl: match?.[0] ?? null, raw };
}
