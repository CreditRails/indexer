import { test } from "node:test";
import assert from "node:assert/strict";
import { Address, xdr } from "@stellar/stellar-sdk";
import { decodeInvocation, detectDefi } from "./defi.js";
import { NETWORKS } from "./config.js";
import type { HorizonOperation } from "./horizon.js";

const WALLET = "GWALLET";

function scAddressXdr(id: string): string {
  return Address.fromString(id).toScVal().toXDR("base64");
}

function scSymbolXdr(sym: string): string {
  return xdr.ScVal.scvSymbol(sym).toXDR("base64");
}

function invokeOp(contractId: string, functionName: string, overrides: Partial<HorizonOperation> = {}): HorizonOperation {
  return {
    id: "op1",
    type: "invoke_host_function",
    created_at: new Date().toISOString(),
    source_account: WALLET,
    transaction_hash: "hash1",
    transaction_successful: true,
    function: "HostFunctionTypeHostFunctionTypeInvokeContract",
    parameters: [
      { value: scAddressXdr(contractId), type: "Address" },
      { value: scSymbolXdr(functionName), type: "Sym" },
    ],
    ...overrides,
  };
}

test("decodeInvocation: decodes a real captured invoke_host_function operation", () => {
  const op: HorizonOperation = {
    id: "16521253129052161",
    type: "invoke_host_function",
    created_at: "2026-07-28T15:20:20Z",
    source_account: "GAGMSM3BKRHLXLJUE7ZDCXMPKL6YSUUMW5DGWL4EIBU4B32KYY6OB3MZ",
    transaction_hash: "513aa1e2080bb2ebf63ed182d0affd704a69be3ccb5b8867a86a58baef1a5cfb",
    transaction_successful: true,
    function: "HostFunctionTypeHostFunctionTypeInvokeContract",
    parameters: [
      { value: "AAAAEgAAAAEJIX5C6S3X6ftDOw+T3MtGCdZN6Xv2zEfpPmTF42f8og==", type: "Address" },
      { value: "AAAADwAAAARwdXNo", type: "Sym" },
    ],
  };

  const decoded = decodeInvocation(op);
  assert.deepEqual(decoded, {
    contractId: "CAESC7SC5EW5P2P3IM5Q7E64ZNDATVSN5F57NTCH5E7GJRPDM76KF7QM",
    functionName: "push",
  });
});

test("decodeInvocation: returns null when parameters are missing or malformed", () => {
  assert.equal(decodeInvocation({ id: "x", type: "invoke_host_function", created_at: "", source_account: "", transaction_hash: "", transaction_successful: true }), null);
  assert.equal(
    decodeInvocation({
      id: "x",
      type: "invoke_host_function",
      created_at: "",
      source_account: "",
      transaction_hash: "",
      transaction_successful: true,
      parameters: [{ value: "not-valid-base64-xdr", type: "Address" }],
    }),
    null
  );
});

test("detectDefi: matches a known registry contract without needing a live RPC call", async () => {
  const network = NETWORKS.testnet;
  const soroswapRouterTestnet = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
  const operations = [invokeOp(soroswapRouterTestnet, "swap_exact_tokens_for_tokens")];

  const defi = await detectDefi(operations, network, WALLET);

  assert.deepEqual(defi.protocolsTouched, ["soroswap"]);
  assert.equal(defi.interactionCount, 1);
  assert.equal(defi.matches[0].role, "router");
  assert.equal(defi.matches[0].category, "amm");
});

test("detectDefi: ignores non-invoke_host_function operations entirely", async () => {
  const network = NETWORKS.testnet;
  const operations: HorizonOperation[] = [
    { id: "p1", type: "payment", created_at: new Date().toISOString(), source_account: WALLET, transaction_hash: "h", transaction_successful: true },
  ];

  const defi = await detectDefi(operations, network, WALLET);

  assert.deepEqual(defi.protocolsTouched, []);
  assert.equal(defi.interactionCount, 0);
});
