// Holds a real SQLite write lock on its own thread for a fixed window.
//
// The main thread cannot do this to itself: bun:sqlite is synchronous, so a
// blocked writer there also blocks the timer that would release the lock. A
// worker thread sleeps synchronously inside its transaction while the main
// thread's writer waits out the busy handler.
import { Database } from "bun:sqlite";

declare var self: Worker;

self.onmessage = (event: MessageEvent) => {
  const message = event.data as { readonly type: string; readonly path: string; readonly holdMs: number };
  if (message.type !== "hold") return;
  const db = new Database(message.path, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      "INSERT OR REPLACE INTO projects(project_key, display_name, raw_path) VALUES ('write-lock-holder', 'write-lock-holder', NULL)",
    );
    self.postMessage({ type: "locked" });
    Bun.sleepSync(message.holdMs);
    db.exec("COMMIT");
    self.postMessage({ type: "released" });
  } catch (cause) {
    self.postMessage({ type: "error", message: cause instanceof Error ? cause.message : String(cause) });
  } finally {
    db.close();
  }
};
