import type { NetworkConfig } from "./config.js";

export interface HorizonPayment {
  id: string;
  type: string; // "payment" | "path_payment_strict_receive" | "path_payment_strict_send" | "create_account" | "account_merge"
  created_at: string;
  from?: string;
  to?: string;
  asset_type: string;
  asset_code?: string;
  amount?: string;
  starting_balance?: string; // create_account uses this instead of amount
}

export interface HorizonTrade {
  id: string;
  ledger_close_time: string;
  base_account: string;
  base_asset_type: string;
  base_asset_code?: string;
  base_amount: string;
  counter_account: string;
  counter_asset_type: string;
  counter_asset_code?: string;
  counter_amount: string;
}

/**
 * Every operation type the account performed — a superset of `/payments`.
 * Fields vary by `type`; only the ones we actually read are declared, all optional
 * except the identifying ones.
 */
export interface HorizonOperation {
  id: string;
  type: string;
  created_at: string;
  source_account: string;
  transaction_hash: string;
  transaction_successful: boolean;
  // payment-like ops (payment / path_payment_* / create_account / account_merge)
  from?: string;
  to?: string;
  account?: string;
  funder?: string;
  asset_type?: string;
  asset_code?: string;
  amount?: string;
  starting_balance?: string;
  // invoke_host_function
  function?: string;
  parameters?: { value: string; type: string }[];
  // liquidity_pool_deposit / liquidity_pool_withdraw
  liquidity_pool_id?: string;
  // manage_buy_offer / manage_sell_offer
  buying_asset_code?: string;
  selling_asset_code?: string;
}

export interface HorizonEffect {
  id: string;
  type: string; // e.g. "contract_credited" | "contract_debited" | "trustline_created" | "liquidity_pool_deposited"
  created_at: string;
  account: string;
  contract?: string;
  asset_type?: string;
  asset_code?: string;
  amount?: string;
}

interface HorizonPage<T> {
  _embedded: { records: T[] };
  _links: { next: { href: string } };
}

// Node's global fetch has no default timeout — a single stalled connection would otherwise
// hang the whole scoring pipeline forever with no error. 20s is generous for a single Horizon page.
const REQUEST_TIMEOUT_MS = 20_000;
// Safety cap so a pathologically high-activity wallet (thousands of pages) can't run unbounded;
// 100 pages is 20k records, already far beyond what a real credit signal needs.
const MAX_PAGES = 100;

async function fetchAllPages<T>(startUrl: string): Promise<T[]> {
  const records: T[] = [];
  let url: string | null = startUrl;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    pages++;
    const res: Response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      if (res.status === 404) break; // wallet not found / not funded
      throw new Error(`Horizon request failed: ${res.status} ${res.statusText} (${url})`);
    }
    const page = (await res.json()) as HorizonPage<T>;
    const batch = page._embedded?.records ?? [];
    records.push(...batch);

    const next = page._links?.next?.href ?? null;
    url = next && batch.length > 0 && next !== url ? next : null;
  }

  return records;
}

export async function accountExists(wallet: string, network: NetworkConfig): Promise<boolean> {
  const res = await fetch(`${network.horizonUrl}/accounts/${wallet}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res.ok;
}

/**
 * Full inbound/outbound payment history for a wallet, most recent first. Descending order
 * (rather than the more obvious ascending) matters for high-activity wallets: `fetchAllPages`
 * caps out at MAX_PAGES, and it's the *recent* activity that feeds the scoring signals
 * (LOOKBACK_DAYS) — a bot with 100k+ historical payments should still get its last-year
 * activity scored, not silently truncated to whatever its oldest 20k payments happen to be.
 */
export async function fetchPayments(wallet: string, network: NetworkConfig): Promise<HorizonPayment[]> {
  const url = `${network.horizonUrl}/accounts/${wallet}/payments?order=desc&limit=200&include_failed=false`;
  return fetchAllPages<HorizonPayment>(url);
}

/** DEX trade fills for a wallet — the authoritative "swap" signal, most recent first. */
export async function fetchTrades(wallet: string, network: NetworkConfig): Promise<HorizonTrade[]> {
  const url = `${network.horizonUrl}/accounts/${wallet}/trades?order=desc&limit=200`;
  return fetchAllPages<HorizonTrade>(url);
}

/**
 * Every operation the account performed — payments, Soroban contract invocations,
 * liquidity pool ops, DEX orders, trustline changes, etc. Superset of `/payments`, most
 * recent first (see `fetchPayments` for why). Used for DeFi detection (`invoke_host_function`)
 * — exact wallet age comes from `fetchFirstOperation`, not this list.
 */
export async function fetchOperations(wallet: string, network: NetworkConfig): Promise<HorizonOperation[]> {
  const url = `${network.horizonUrl}/accounts/${wallet}/operations?order=desc&limit=200&include_failed=false`;
  return fetchAllPages<HorizonOperation>(url);
}

/**
 * Ledger-level effects for the account — catches Soroban token moves
 * (`contract_credited` / `contract_debited`) that don't appear as classic payments. Most recent first.
 */
export async function fetchEffects(wallet: string, network: NetworkConfig): Promise<HorizonEffect[]> {
  const url = `${network.horizonUrl}/accounts/${wallet}/effects?order=desc&limit=200`;
  return fetchAllPages<HorizonEffect>(url);
}

/**
 * The account's very first operation ever (usually `create_account`) — a single cheap request,
 * independent of `fetchOperations`'s MAX_PAGES cap, so exact wallet age is correct even for
 * wallets with more history than the cap covers.
 */
export async function fetchFirstOperation(wallet: string, network: NetworkConfig): Promise<HorizonOperation | null> {
  const url = `${network.horizonUrl}/accounts/${wallet}/operations?order=asc&limit=1&include_failed=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) return null;
  const page = (await res.json()) as HorizonPage<HorizonOperation>;
  return page._embedded?.records?.[0] ?? null;
}
