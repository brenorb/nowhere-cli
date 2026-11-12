export const title = "Quote and begin a Nowhere store checkout";
export const state = ({c}) => {
  if (c.phase === "failed" && c.published) return "Order published, invoice failed";
  return {
    quoting: "Reading cart, inventory and payment methods",
    "quote returned": "Quote returned",
    gate: "Checking whether the cart can proceed",
    validate: "Checking buyer details and method",
    "prepare payment": "Preparing the payment amount",
    "publish order": "Publishing the order",
    "get invoice": "Order published, requesting invoice",
    "manual returned": "Manual payment instructions returned",
    "invoice returned": "Lightning invoice returned",
    failed: "Checkout failed",
  }[c.phase];
};
export const step = (action, _from, to) => ({
  Quote: to.c.command === "quote" ? "return the quote" : "use the quote for checkout",
  Gate: to.c.phase === "failed" ? "inventory or cart prevents checkout" : "inventory and cart can proceed",
  Validate: "buyer details and method accepted",
  Prepare: "amount ready",
  Publish: to.c.method === "lightning" ? "publish before requesting the invoice" : "publish and return instructions",
  Invoice: "invoice received",
  Fail: to.c.published ? "invoice cannot be obtained" : "report failure",
  Done: "finish",
})[action];
