/**
 * Registers an fid for the throwaway custody account in .env.
 *
 * One transaction on Optimism. IdGateway.register() mints the fid to the caller
 * and rents its first storage unit in the same call, which is why the account
 * can post the moment this confirms — an fid with no storage can hold keys but
 * its messages get pruned.
 *
 * This spends real money. It prints what it is about to do and waits for you.
 */
import { createWalletClient, formatEther, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { optimism } from "viem/chains";
import { createInterface } from "node:readline/promises";
import {
  ID_GATEWAY,
  ID_REGISTRY,
  OP_RPC_URL,
  idGatewayAbi,
  idRegistryAbi,
  publicClient,
} from "./farcaster.js";

const mnemonic = process.env.TEST_MNEMONIC;
if (!mnemonic) {
  console.error("No TEST_MNEMONIC in the environment. Run `npm run new-account` first.");
  process.exit(1);
}

const account = mnemonicToAccount(mnemonic);

// One address can only ever own one fid, so a non-zero result means we already ran.
const existing = await publicClient.readContract({
  address: ID_REGISTRY,
  abi: idRegistryAbi,
  functionName: "idOf",
  args: [account.address],
});
if (existing !== 0n) {
  console.log(`${account.address} already owns fid ${existing}. Nothing to do.`);
  process.exit(0);
}

const [price, balance] = await Promise.all([
  publicClient.readContract({ address: ID_GATEWAY, abi: idGatewayAbi, functionName: "price" }),
  publicClient.getBalance({ address: account.address }),
]);

console.log(`  Custody address   ${account.address}`);
console.log(`  Balance           ${formatEther(balance)} ETH on Optimism`);
console.log(`  Registration      ${formatEther(price)} ETH (includes 1 storage unit)`);

if (balance <= price) {
  console.error(
    `\nNot enough ETH. Send a little more than ${formatEther(price)} ETH to the address above` +
      `\n(the surplus covers gas) and run this again.`,
  );
  process.exit(1);
}

// The recovery address can reclaim the fid if the custody key is lost. For a
// throwaway account we set it to the custody address itself; for anything real,
// point it at a separate wallet you control.
const recovery = account.address;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`\nRegister an fid for this address? [y/N] `);
rl.close();
if (answer.trim().toLowerCase() !== "y") {
  console.log("Aborted. Nothing was sent.");
  process.exit(0);
}

const wallet = createWalletClient({
  account,
  chain: optimism,
  transport: http(OP_RPC_URL),
});

const hash = await wallet.writeContract({
  address: ID_GATEWAY,
  abi: idGatewayAbi,
  functionName: "register",
  args: [recovery],
  value: price,
});

console.log(`\nSubmitted ${hash}`);
console.log("Waiting for confirmation...");

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  console.error(`Transaction reverted. See https://optimistic.etherscan.io/tx/${hash}`);
  process.exit(1);
}

const fid = await publicClient.readContract({
  address: ID_REGISTRY,
  abi: idRegistryAbi,
  functionName: "idOf",
  args: [account.address],
});

console.log(`\nRegistered fid ${fid}.`);
console.log(`Add this to .env:\n\n  TEST_FID=${fid}\n`);
