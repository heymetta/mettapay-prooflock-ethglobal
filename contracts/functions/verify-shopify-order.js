// Chainlink Functions source — Shopify order fulfilled verification.
// args[0]: shop domain (e.g. "my-store.myshopify.com")
// args[1]: order id (numeric, as string)
// secrets.SHOPIFY_TOKEN: Shopify Admin API access token (read_orders scope).
// Returns abi-encoded (bool verified, string message).

const shop = args[0];
const orderId = args[1];
if (!shop || !orderId) return Functions.encodeString("ERR:missing-args");
if (!secrets.SHOPIFY_TOKEN) return Functions.encodeString("ERR:no-token");

const res = await Functions.makeHttpRequest({
  url: `https://${shop}/admin/api/2024-07/orders/${orderId}.json`,
  headers: {
    "X-Shopify-Access-Token": secrets.SHOPIFY_TOKEN,
    Accept: "application/json",
  },
  timeout: 9000,
});

if (res.error || !res.data?.order) {
  return Functions.encodeString(`ERR:${res.error || "no-order"}`);
}
const order = res.data.order;
const verified = order.fulfillment_status === "fulfilled" || order.financial_status === "paid";
const message = `order ${orderId} fulfillment=${order.fulfillment_status} financial=${order.financial_status}`;

const { ethers } = await import("npm:ethers@5.7.2");
const encoded = ethers.utils.defaultAbiCoder.encode(
  ["bool", "string"],
  [verified, message],
);
return ethers.utils.arrayify(encoded);
