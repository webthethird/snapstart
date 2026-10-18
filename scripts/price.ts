/**
 * Reads the live cost of registering an fid, straight from the contracts.
 *
 * Run this before anything else. Published guides quote a price from whenever
 * they were written, and storage rent is repriced against an ETH/USD oracle,
 * so the only number worth trusting is the one you read yourself.
 */
import {
  ID_GATEWAY,
  STORAGE_REGISTRY,
  formatUsd8,
  idGatewayAbi,
  publicClient,
  storageRegistryAbi,
} from "./farcaster.js";
import { formatEther } from "viem";

const [registerPrice, usdUnitPrice, ethUsdPrice, gasPrice] = await Promise.all([
  publicClient.readContract({
    address: ID_GATEWAY,
    abi: idGatewayAbi,
    functionName: "price",
  }),
  publicClient.readContract({
    address: STORAGE_REGISTRY,
    abi: storageRegistryAbi,
    functionName: "usdUnitPrice",
  }),
  publicClient.readContract({
    address: STORAGE_REGISTRY,
    abi: storageRegistryAbi,
    functionName: "ethUsdPrice",
  }),
  publicClient.getGasPrice(),
]);

const registerUsd = (Number(formatEther(registerPrice)) * Number(ethUsdPrice)) / 1e8;

console.log("Live from Optimism mainnet:\n");
console.log(`  Storage, per unit      ${formatUsd8(usdUnitPrice)}`);
console.log(`  ETH/USD oracle rate    ${formatUsd8(ethUsdPrice)}`);
console.log(`  Gas price              ${Number(gasPrice) / 1e9} gwei`);
console.log(
  `\n  Register an fid        ${formatEther(registerPrice)} ETH  (~$${registerUsd.toFixed(2)})`,
);
console.log("  ...includes the first storage unit, so the account can post immediately.\n");
