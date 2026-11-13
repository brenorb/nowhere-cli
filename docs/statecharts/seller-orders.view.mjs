export const title = "Find orders for a Nowhere store";
export const state = ({o}) => ({
  access: "Checking seller credentials",
  fetch: "Looking up order events",
  decrypt: "Reading a candidate order",
  failed: "Credentials missing or order unreadable",
  skip: "Candidate skipped",
  shown: "Order shown to seller",
})[o.phase];
export const step = (action, _from, to) => ({
  Authorize: to.o.access ? "use seller credentials" : "reject missing credentials",
  Fetch: "read relay results",
  Decrypt: to.o.phase === "shown" ? "accept a matching order" :
    to.o.phase === "skip" ? "skip another store, duplicate or unrequested ID" : "record an unreadable order",
  Done: "finish",
})[action];
