// Chainlink Functions source — Generic webhook verification.
// args[0]: HTTPS URL to GET. Verified when the response is HTTP 200 and either
//          the body parses to JSON with { verified: true } OR the body equals
//          the literal text "OK" / "verified".
// Returns abi-encoded (bool verified, string message).

const url = args[0];
if (!url || !url.startsWith("https://")) {
  return Functions.encodeString("ERR:bad-url");
}

const res = await Functions.makeHttpRequest({ url, timeout: 9000 });
if (res.error) return Functions.encodeString(`ERR:${res.error}`);

let verified = false;
let message = `HTTP ${res.status}`;
if (res.status === 200) {
  const body = res.data;
  if (body && typeof body === "object" && body.verified === true) {
    verified = true;
    message = body.message || "webhook verified=true";
  } else if (typeof body === "string" && /^(OK|verified)$/i.test(body.trim())) {
    verified = true;
    message = `webhook returned ${body.trim()}`;
  } else {
    message = `HTTP 200 but body did not signal verified`;
  }
}

const { ethers } = await import("npm:ethers@5.7.2");
const encoded = ethers.utils.defaultAbiCoder.encode(
  ["bool", "string"],
  [verified, message],
);
return ethers.utils.arrayify(encoded);
