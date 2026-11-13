export const title = "Request a Nowhere tip or donation invoice";
export const state = ({i}) => ({
  validate: "Checking the amount",
  choose: "Selecting a payment method",
  resolve: "Getting the provider amount limits",
  callback: "Ready to request an invoice",
  response: "Waiting for the provider response",
  complete: "Invoice available",
  failed: "Invoice request failed",
})[i.phase];
export const step = (action, _from, to) => ({
  Validate: to.i.phase === "failed" ? "reject the amount" : "accept a positive whole-sat amount",
  Choose: to.i.phase === "failed" ? "reject missing or unsupported method" : "select Lightning",
  Resolve: to.i.phase === "failed" ? "reject amount outside provider limits" : "accept amount within provider limits",
  Request: "send invoice request",
  Invoice: "return the invoice",
  Fail: "report a provider or response error",
  Done: "finish",
})[action];
