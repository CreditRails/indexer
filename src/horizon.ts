import { NETWORK } from "./config.js";

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

interface HorizonPage<T> {
  _embedded: { records: T[] };
  _links: { next: { href: string } };
}

async function fetchAllPages<T>(startUrl: string): Promise<T[]> {
  const records: T[] = [];
  let url: string | null = startUrl;

  while (url) {
    const res: Response = await fetch(url);
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

export async function accountExists(wallet: string): Promise<boolean> {
  const res = await fetch(`${NETWORK.horizonUrl}/accounts/${wallet}`);
  return res.ok;
}

/** Full inbound/outbound payment history for a wallet, oldest first. */
export async function fetchPayments(wallet: string): Promise<HorizonPayment[]> {
  const url = `${NETWORK.horizonUrl}/accounts/${wallet}/payments?order=asc&limit=200&include_failed=false`;
  return fetchAllPages<HorizonPayment>(url);
}

/** DEX trade fills for a wallet — the authoritative "swap" signal, oldest first. */
export async function fetchTrades(wallet: string): Promise<HorizonTrade[]> {
  const url = `${NETWORK.horizonUrl}/accounts/${wallet}/trades?order=asc&limit=200`;
  return fetchAllPages<HorizonTrade>(url);
}
