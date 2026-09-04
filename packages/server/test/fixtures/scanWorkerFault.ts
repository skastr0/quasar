import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fault-injection channel for the scan-worker pool.
 *
 * A Bun worker thread does not see env mutations made after the process
 * started, and Bun strips the query string from a Worker URL before the worker
 * observes it as `import.meta.url` — so the filesystem is the only channel a
 * parent has to a worker it spawns through production code. The marker names
 * one fault and is claimed by unlink: the first worker to take it applies the
 * fault, and every later worker (the respawn included) behaves normally.
 */
export const SCAN_WORKER_FAULT_MARKER = join(tmpdir(), "quasar-scan-worker-fault");

/**
 * - `crash` kills the worker thread mid-chunk.
 * - `silent` keeps it alive but never answers ONE chunk, the shape a deadline
 *   has to catch.
 * - `silent-all` never answers ANY chunk, so one worker can hold two scans at
 *   once — the shape that proves a slot recycled at one scan's deadline settles
 *   the OTHER scans it owed.
 * - `init-exit` exits the thread while handling `init`, before it ever replies
 *   `ready`. Bun emits `close` and no `error` for that, so it is the shape that
 *   proves the spawn promise is total.
 */
export type ScanWorkerFault = "crash" | "silent" | "silent-all" | "init-exit";
