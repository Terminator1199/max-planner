// The planner worker: the page sends the data files once, then planning requests.
import { makeContext, type Context, type Files } from "./context.ts";
import { planVillage, type PlanInput } from "./planner.ts";

type Message = { kind: "init"; files: Files } | { kind: "plan"; id: number; input: PlanInput };

const scope = self as unknown as {
  onmessage: ((e: { data: Message }) => void) | null;
  postMessage: (m: unknown) => void;
};
let ctx: Context | undefined;

scope.onmessage = (e) => {
  const m = e.data;
  if (m.kind === "init") {
    ctx = makeContext(m.files);
    scope.postMessage({ kind: "ready" });
    return;
  }
  try {
    if (!ctx) throw new Error("The planner has no data yet.");
    scope.postMessage({ kind: "plan", id: m.id, out: planVillage(ctx, m.input) });
  } catch (err) {
    scope.postMessage({
      kind: "plan",
      id: m.id,
      out: { ok: false, message: String((err as Error).message ?? err) },
    });
  }
};
