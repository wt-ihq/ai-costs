import { describe, expect, it } from "vitest";
import { runLanes } from "./run-all";

/** A promise whose resolution is held by the test. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("runLanes", () => {
  // The heavy writers (Cursor, Vercel) share a lane so their DB write phases
  // never overlap; OpenAI (mostly waiting out 429s) and the light sources run
  // alongside. A lane's sources run one after another; lanes run together.
  it("runs a lane's sources in order and different lanes concurrently", async () => {
    const started: string[] = [];
    const gates: Record<string, ReturnType<typeof deferred>> = { a: deferred(), b: deferred(), c: deferred() };
    const run = async (name: string) => {
      started.push(name);
      await gates[name].promise;
    };

    const done = runLanes([["a", "b"], ["c"]], run);
    await Promise.resolve();
    expect(started).toEqual(["a", "c"]); // b waits for a; c starts alongside a

    gates.c.resolve();
    await Promise.resolve();
    expect(started).toEqual(["a", "c"]); // c finishing doesn't release b

    gates.a.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["a", "c", "b"]);

    gates.b.resolve();
    await done;
  });
});
