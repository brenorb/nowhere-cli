export const title = "Watch Nowhere forum events";
export const state = ({w}) => {
  if (w.phase === "failed") return "Watch failed";
  if (w.phase === "finished") return "Watch ended";
  if (w.stop && w.busy) return "Stopping after the pending poll";
  if (w.phase === "snapshot") return "Loading initial events";
  if (w.phase === "waiting") return w.live ? "Live events checked" : "Initial events checked";
  return "Looking for new events";
};
export const step = (action, from) => ({
  Poll: "read events",
  Arrive: from.w.phase === "snapshot" ? "emit the initial snapshot" : "emit only newly seen events",
  ListError: "report a read error",
  NextPoll: "wait before polling again",
  Signal: "receive an exit signal",
  Deadline: "reach the watch duration",
  Finish: "stop watching",
  Done: "finish",
})[action];
