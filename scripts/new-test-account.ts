/**
 * Generates a fresh mnemonic for a THROWAWAY Farcaster test account.
 *
 * Why generate one instead of reusing an account you have:
 *
 * The custody address derived from this mnemonic will own an fid outright. Any
 * software holding it can post as that account, change its recovery address, or
 * transfer it away. You are about to paste this phrase into a tutorial client,
 * so it must guard nothing you would miss. Never run this flow against the
 * recovery phrase of an account you actually use.
 *
 * The phrase is written to .env, which is gitignored, and it stays on this
 * machine. It never goes to the read node.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;

if (existsSync(ENV_PATH) && /^TEST_MNEMONIC=.+/m.test(readFileSync(ENV_PATH, "utf8"))) {
  console.error(
    "Refusing to overwrite: .env already has a TEST_MNEMONIC.\n" +
      "Clear it by hand if you really want a new account — losing that phrase\n" +
      "means losing control of whatever fid it already owns.",
  );
  process.exit(1);
}

const mnemonic = generateMnemonic(english);
const account = mnemonicToAccount(mnemonic);

appendFileSync(
  ENV_PATH,
  `\nTEST_MNEMONIC="${mnemonic}"\nTEST_CUSTODY_ADDRESS=${account.address}\n`,
);

console.log("Generated a throwaway custody account.\n");
console.log(`  Custody address   ${account.address}`);
console.log(`  Derivation path   m/44'/60'/0'/0/0`);
console.log(`\nWritten to .env (gitignored).`);
console.log(`\nNext: fund ${account.address} with a few dollars of ETH on Optimism,`);
console.log(`then run \`npm run register\`.`);
