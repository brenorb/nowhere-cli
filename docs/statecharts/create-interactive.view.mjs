export const title = "Create a Nowhere site interactively";
export const state = ({p}) => ({
  "validate flags": "Checking create options",
  "choose tool": "Choosing the site type",
  "fill fields": "Filling missing fields",
  review: "Reviewing the proposed site",
  build: "Building the site link",
  created: "Site link created",
  cancelled: "Creation cancelled",
  failed: "Creation failed",
})[p.phase];
export const step = (action, _from, to) => ({
  RejectFlags: "report invalid options",
  Open: to.p.chooseTool ? "ask which site type to create" : "open the site form",
  ChooseTool: "choose a supported site type",
  FillRequired: "supply a required answer",
  Review: "show the completed form",
  PromptFailure: "report an input or validation error",
  Retry: "ask again",
  Confirm: "confirm or take the default",
  Decline: "answer no",
  Build: "return the site link",
  BuildFails: "report build failure",
  Done: "finish",
})[action];
