export const title = "Sign a Nowhere petition";
export const state = ({p}) => ({
  validate: "Checking your petition response",
  encrypt: "Encrypting your response",
  "proof of work": "Computing proof of work",
  sign: "Signing and verifying the event",
  publish: "Publishing to relays",
  signed: "Signature published",
  failed: "Signature could not be submitted",
})[p.phase];
export const step = (action, _from, to) => ({
  ValidateInput: to.p.phase === "failed" ? "report missing required information" : "accept response",
  Encrypt: "protect the response for the petition owner",
  ComputeProof: "finish computing proof of work",
  Sign: "verify the signed event",
  Publish: "receive relay acknowledgement",
  Fail: "report a submission error",
  Done: "finish",
})[action];
