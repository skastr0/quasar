// Real scan worker with one injectable fault, used to prove the pool survives
// a worker dying mid-chunk. Importing the production module installs the real
// message handler; this file wraps it, so every message that is not the single
// claimed fault runs the exact production path — including on the respawn.
import { readFileSync, unlinkSync } from "node:fs";

import "../../src/vectorScanWorker";
import { SCAN_WORKER_FAULT_MARKER, type ScanWorkerFault } from "./scanWorkerFault";

declare var self: Worker;

const realOnMessage = self.onmessage!;

const FAULTS: readonly ScanWorkerFault[] = ["crash", "silent", "silent-all", "init-exit"];

/** Read the armed fault without consuming it. */
const readFault = (): ScanWorkerFault | undefined => {
  let raw: string;
  try {
    raw = readFileSync(SCAN_WORKER_FAULT_MARKER, "utf8");
  } catch {
    return undefined;
  }
  const fault = raw.trim() as ScanWorkerFault;
  return FAULTS.includes(fault) ? fault : undefined;
};

/** Claim the marker by unlinking it: only one worker can win, so a fault fires
 * exactly once no matter how many workers race for the same chunk. */
const claim = (): boolean => {
  try {
    unlinkSync(SCAN_WORKER_FAULT_MARKER);
    return true;
  } catch {
    return false;
  }
};

/** Set once this worker claimed `silent-all`: it then swallows every chunk, so
 * a single slot can hold more than one scan at the same time. */
let swallowEverything = false;

self.onmessage = (event: MessageEvent) => {
  const message = event.data as { readonly type: string };
  if (message.type === "init") {
    // Exit DURING init, before the `ready` reply. Only an init fault may claim
    // the marker here — a scan fault must survive for the scan that armed it.
    if (readFault() === "init-exit" && claim()) process.exit(0);
    realOnMessage.call(self, event);
    return;
  }
  if (message.type !== "scan") {
    realOnMessage.call(self, event);
    return;
  }
  if (swallowEverything) return;
  const fault = readFault();
  if (fault === undefined || fault === "init-exit" || !claim()) {
    realOnMessage.call(self, event);
    return;
  }
  // Never replies and never dies: the pool has no event to react to, so only a
  // deadline can end the scan.
  if (fault === "silent") return;
  if (fault === "silent-all") {
    swallowEverything = true;
    return;
  }
  // Uncaught in the worker's own message handler — the thread dies holding the
  // chunk, exactly as an OOM kill or a kernel fault would leave it.
  throw new Error("injected vector scan worker fault");
};
