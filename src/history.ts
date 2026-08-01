import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NetworkConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

export interface ScoreSnapshot {
  score: number;
  tier: string;
  at: string; // ISO timestamp
}

/** Real score observations only — nothing here until a wallet has actually been scored more than once over time. */
function historyPath(network: NetworkConfig): string {
  return join(DATA_DIR, `score-history.${network.name}.json`);
}

function loadAll(network: NetworkConfig): Record<string, ScoreSnapshot[]> {
  const path = historyPath(network);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, ScoreSnapshot[]>;
  } catch {
    return {};
  }
}

function saveAll(network: NetworkConfig, all: Record<string, ScoreSnapshot[]>): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(historyPath(network), JSON.stringify(all, null, 2));
}

const MAX_SNAPSHOTS_PER_WALLET = 500;
/** Skip recording if the last snapshot is more recent than this — avoids flooding history
 *  with near-duplicate points from rapid dashboard refreshes/polling. */
const MIN_INTERVAL_MINUTES = 30;

/** Appends a real score observation for a wallet. Deduped by MIN_INTERVAL_MINUTES — call this every time a score is computed, not on a separate schedule. */
export function recordScore(network: NetworkConfig, wallet: string, score: number, tier: string): void {
  const all = loadAll(network);
  const existing = all[wallet] ?? [];
  const last = existing[existing.length - 1];
  const now = new Date();
  if (last && (now.getTime() - new Date(last.at).getTime()) / 60_000 < MIN_INTERVAL_MINUTES) {
    return;
  }
  existing.push({ score, tier, at: now.toISOString() });
  all[wallet] = existing.slice(-MAX_SNAPSHOTS_PER_WALLET);
  saveAll(network, all);
}

/** Real recorded snapshots for a wallet within the last `days` days — empty until enough real usage accumulates. */
export function getHistory(network: NetworkConfig, wallet: string, days: number): ScoreSnapshot[] {
  const existing = loadAll(network)[wallet] ?? [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return existing.filter((s) => new Date(s.at).getTime() >= cutoff);
}
