export const title = "Nowhere create, update, and verify a protected link";

const labels = {
  importing: "Opening the previous link",
  building: "Building the new page",
  unsigned: "New page is ready",
  signed: "New page is signed",
  encrypted: "New page is encrypted",
  published: "New link is ready to share",
  verifying: "Checking the new link",
  failed: "The new link could not be created",
  unreadable: "The password was rejected",
};

export function state({ link }) {
  if (link.phase === "verified") {
    return link.verified === "signed" ? "Signature verified" : "Page opens without a signature";
  }
  return labels[link.phase];
}

export function step(action, from, to) {
  switch (action) {
    case "ImportExisting": return "the previous page opens";
    case "BuildNewFragment": return "the page contents are encoded";
    case "SignNewFragment": return "the owner signs the new page";
    case "EncryptFinalFragment": return "the password protects the link";
    case "PrintFinalLink": return "the command prints the new link";
    case "BuildOrProtectFails":
      return {
        importing: "the previous page could not be opened",
        building: "the page could not be built",
        unsigned: from.link.wantsSign ? "the page could not be signed" : "the link could not be encrypted",
        signed: "the link could not be encrypted",
      }[from.link.phase];
    case "OpenForVerification": return "the user checks the final link";
    case "PasswordRejected": return "the supplied password does not open it";
    case "VerifySignature": return to.link.verified === "signed" ? "the signature is valid" : "the page has no signature";
    case "Done": return "the command has completed";
    default: throw new Error(`Unexpected action ${action}`);
  }
}
