import { network, ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Append/update a contract record in deployments/<network>.json. Called by the
 * deploy scripts so every broadcast is recorded per chain. No-ops on the
 * in-process `hardhat` network so local test runs don't write files.
 */
function deploymentsFile(): string {
  return path.join(__dirname, "..", "..", "deployments", `${network.name}.json`);
}

/** Read the per-chain deployments record (throws if none). */
export function loadDeployments(): any {
  const file = deploymentsFile();
  if (!fs.existsSync(file)) throw new Error(`No deployments/${network.name}.json — deploy first.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Look up a deployed contract address by record name. */
export function deployedAddress(name: string): string {
  const c = loadDeployments().contracts?.[name];
  if (!c?.address) throw new Error(`${name} not found in deployments/${network.name}.json`);
  return c.address;
}

export async function saveDeployment(
  name: string,
  address: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (network.name === "hardhat") return;

  const dir = path.join(__dirname, "..", "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const [deployer] = await ethers.getSigners();

  let data: any = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      data = {};
    }
  }
  data.network = network.name;
  data.chainId = chainId;
  data.deployer = deployer?.address ?? data.deployer;
  data.updatedAt = new Date().toISOString();
  data.contracts = data.contracts || {};
  data.contracts[name] = { address, ...extra };

  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`  ↳ recorded ${name} in deployments/${network.name}.json`);
}
