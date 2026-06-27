import { writeFileSync } from "node:fs";

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { App } from "./app";

export interface TuiOptions {
  /** Render one frame then exit — used to smoke-test the compiled binary under a PTY. */
  readonly smoke?: boolean;
  /** Seed query for the smoke path, exercising the real search + result render. */
  readonly smokeQuery?: string;
  /** Server URL override, inherited from the CLI's resolution. */
  readonly server?: string;
}

/** How the TUI exited. An editorFile asks the CLI to drop the user into $EDITOR after teardown. */
export interface TuiExit {
  readonly editorFile?: string;
  readonly editor?: string;
}

/**
 * Launch the interactive TUI. Imported dynamically from the CLI dispatcher so
 * the always-JSON / headless path never loads the native opentui FFI. Resolves
 * with a TuiExit so the CLI can hand off to $EDITOR once the alt-screen is gone.
 */
export const launchTui = async (options: TuiOptions = {}): Promise<TuiExit | undefined> => {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    screenMode: "alternate-screen",
  });

  return await new Promise<TuiExit | undefined>((resolveDone) => {
    let done = false;
    const finish = (exit?: TuiExit) => {
      if (done) return;
      done = true;
      try {
        renderer.destroy();
      } catch {
        // teardown best-effort
      }
      const smokeFile = process.env.QUASAR_SMOKE_FILE;
      if (options.smoke && smokeFile) {
        try {
          writeFileSync(smokeFile, "ok");
        } catch {
          // best-effort smoke signal
        }
      }
      resolveDone(exit);
    };

    createRoot(renderer).render(<App options={options} onExit={finish} />);

    if (options.smoke) {
      setTimeout(() => finish(), options.smokeQuery ? 1800 : 700);
    }
  });
};
