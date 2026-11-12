export const title = "Pair and manage a Nowhere remote signer";
export const state = ({s}) => {
  if (s.phase === "authorization") return s.method === "bunker" ? "Waiting for the bunker" : "Waiting for a signer to pair";
  if (s.phase === "identity") return "Reading the signer's public key";
  if (s.phase === "saving") return "Saving signer settings";
  if (s.observation === "pairing failed") return "Pairing failed";
  return {
    missing: "No saved signer",
    valid: "Signer settings saved",
    invalid: "Saved signer settings cannot be read",
  }[s.stored];
};
export const step = (action, _from, to) => ({
  ReadSession: "check saved signer settings",
  Disconnect: "forget saved signer",
  Begin: to.s.method === "bunker" ? "connect with a bunker" : "wait on a pairing URI",
  Authorize: "signer authorizes the connection",
  GetPublicKey: "receive the public key",
  Persist: "save the signer locally",
  Fail: "report a pairing or save error",
})[action];
