/**
 * x402 EIP-712 domain tests
 *
 * Verifies that the TransferWithAuthorization EIP-712 domain is loaded
 * dynamically from the token contract's name()/version(), rather than
 * hardcoded to "USD Coin"/"2" (issue #81).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { base } from "viem/chains";

const readContract = vi.fn();

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: () => ({ readContract }),
  };
});

import { getEip712Domain } from "../conway/x402.js";

describe("x402 - getEip712Domain", () => {
  beforeEach(() => {
    readContract.mockReset();
  });

  it("reads name and version from the token contract", async () => {
    readContract.mockImplementation(({ functionName }: { functionName: string }) =>
      functionName === "name" ? Promise.resolve("USD Coin") : Promise.resolve("2"),
    );

    const domain = await getEip712Domain(
      base,
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );

    expect(domain).toEqual({ name: "USD Coin", version: "2" });
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it("caches the domain per chain+contract instead of re-fetching", async () => {
    readContract.mockImplementation(({ functionName }: { functionName: string }) =>
      functionName === "name" ? Promise.resolve("Some Token") : Promise.resolve("1"),
    );
    const tokenAddress = "0x0000000000000000000000000000000000cAFE";

    await getEip712Domain(base, tokenAddress);
    await getEip712Domain(base, tokenAddress);

    expect(readContract).toHaveBeenCalledTimes(2); // not 4 — second call hit the cache
  });

  it("falls back to the default domain if the contract call fails", async () => {
    readContract.mockRejectedValue(new Error("contract does not implement name()"));

    const domain = await getEip712Domain(
      base,
      "0x0000000000000000000000000000000000bEEF",
    );

    expect(domain).toEqual({ name: "USD Coin", version: "2" });
  });
});
