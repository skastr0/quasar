import type {
  AdapterDiagnostic,
  MachineIdentity,
  NormalizedSession,
  Provider,
  SourceRoot,
} from "../core/schemas";

/**
 * Cheap pre-parse probe: an adapter computes this (source path + statSync
 * size/mtime alone) before the expensive build/yield of a session. The
 * `sourceFingerprint` is byte-identical to what the ingest engine derives
 * from the session's unit fingerprint, so a caller can decide skip purely
 * from it.
 */
export interface SessionParseProbe {
  readonly sessionId: string;
  readonly sourceFingerprint: string;
}

export interface AdapterDiscoverOptions {
  readonly machine: MachineIdentity;
  readonly now: string;
  readonly roots?: Partial<Record<Provider, string>>;
  readonly logicalRoots?: Partial<Record<Provider, string>>;
  readonly limit?: number;
  readonly skip?: number;
  /**
   * Pre-parse gate. Returning false means the adapter MUST skip the expensive
   * build/yield for that session. Absent (the default) preserves today's
   * behavior: every discovered session is parsed and yielded.
   */
  readonly shouldParseSession?: (probe: SessionParseProbe) => boolean | Promise<boolean>;
}

export interface AdapterReadResult {
  readonly sourceRoots: SourceRoot[];
  readonly sessions: NormalizedSession[];
  readonly diagnostics: AdapterDiagnostic[];
}

export type AdapterStreamItem =
  | { readonly type: "sourceRoot"; readonly sourceRoot: SourceRoot }
  | {
      readonly type: "session";
      readonly session: NormalizedSession;
      readonly sourceUnit?: SourceUnit;
      readonly fingerprint?: UnitFingerprint;
    }
  | { readonly type: "diagnostic"; readonly diagnostic: AdapterDiagnostic };

export type UnitFingerprint =
  {
    readonly size?: number;
    readonly mtimeMs?: number;
    /**
     * Opaque change signal for sources with no local stat to fingerprint
     * (a server-side transcript). The adapter derives it from cheap list
     * metadata so an unchanged unit is skipped before any expensive fetch;
     * it flows through `JSON.stringify(fingerprint)` into `sourceFingerprint`.
     */
    readonly tag?: string;
  };

export interface SourceUnit {
  readonly provider: Provider;
  readonly adapterId: string;
  readonly rootPath: string;
  readonly sourcePath: string;
  readonly physicalPath?: string;
}

export const collectAdapterStream = async (
  stream: AsyncIterable<AdapterStreamItem>,
): Promise<AdapterReadResult> => {
  const sourceRoots: SourceRoot[] = [];
  const sessions: NormalizedSession[] = [];
  const diagnostics: AdapterDiagnostic[] = [];
  for await (const item of stream) {
    if (item.type === "sourceRoot") sourceRoots.push(item.sourceRoot);
    else if (item.type === "session") sessions.push(item.session);
    else diagnostics.push(item.diagnostic);
  }
  return { sourceRoots, sessions, diagnostics };
};

export interface SessionAdapter {
  readonly id: string;
  readonly provider: Provider;
  readonly displayName: string;
  readonly stable: boolean;
  readonly defaultRoot: () => string | undefined;
  readonly read: (options: AdapterDiscoverOptions) => Promise<AdapterReadResult>;
  readonly stream?: (options: AdapterDiscoverOptions) => AsyncIterable<AdapterStreamItem>;
}
