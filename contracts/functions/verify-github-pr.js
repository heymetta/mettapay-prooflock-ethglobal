// Chainlink Functions source — GitHub PR merged verification.
// args[0]: full GitHub PR URL, e.g. https://github.com/org/repo/pull/123
// Returns abi-encoded (bool verified, string message).
// No secrets required for public repos. For private repos, add a GITHUB_TOKEN
// via Functions DON-hosted secrets and set Authorization header.

const url = args[0];
const m = url && url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
if (!m) {
  return Functions.encodeString("ERR:bad-url");
}
const [, owner, repo, pr] = m;

const res = await Functions.makeHttpRequest({
  url: `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}`,
  headers: { Accept: "application/vnd.github+json", "User-Agent": "ProofLock" },
  timeout: 9000,
});

if (res.error || !res.data) {
  return Functions.encodeString(`ERR:${res.error || "no-data"}`);
}
const merged = res.data.merged === true;
const message = merged
  ? `PR #${pr} merged at ${res.data.merged_at}`
  : `PR #${pr} state=${res.data.state} merged=false`;

// Manual ABI encode: bool then dynamic string (offset 0x40).
// Easiest path on the DON: return JSON the consumer decodes off-chain, OR
// use ethers AbiCoder. The Functions runtime ships ethers v5:
const { ethers } = await import("npm:ethers@5.7.2");
const encoded = ethers.utils.defaultAbiCoder.encode(
  ["bool", "string"],
  [merged, message],
);
return ethers.utils.arrayify(encoded);
