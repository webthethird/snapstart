/**
 * Shared constants and clients for the Farcaster contracts on Optimism.
 *
 * Everything here runs against a public RPC with no API key, which is a
 * constraint we hold throughout snapstart: you furnish the compute, nobody
 * furnishes you credentials.
 */
import { createPublicClient, http } from "viem";
import { optimism } from "viem/chains";

export const OP_RPC_URL = process.env.OP_RPC_URL ?? "https://mainnet.optimism.io";

/** Registers fids and rents the first storage unit in the same call. */
export const ID_GATEWAY = "0x00000000Fc25870C6eD6b6c7E41Fb078b7656f69" as const;
/** Source of truth for which address owns which fid. */
export const ID_REGISTRY = "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b" as const;
/** Sets the price of storage, in USD, converted to ETH at an oracle rate. */
export const STORAGE_REGISTRY = "0x00000000fcCe7f938e7aE6D3c335bD6a1a7c593D" as const;

export const idGatewayAbi = [
  {
    type: "function",
    name: "price",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "payable",
    inputs: [{ name: "recovery", type: "address" }],
    outputs: [
      { name: "fid", type: "uint256" },
      { name: "overpayment", type: "uint256" },
    ],
  },
] as const;

export const idRegistryAbi = [
  {
    type: "function",
    name: "idOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const storageRegistryAbi = [
  {
    type: "function",
    name: "unitPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "usdUnitPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ethUsdPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const publicClient = createPublicClient({
  chain: optimism,
  transport: http(OP_RPC_URL),
});

/** usdUnitPrice and ethUsdPrice are both 8-decimal fixed point. */
export function formatUsd8(value: bigint): string {
  return (Number(value) / 1e8).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}
