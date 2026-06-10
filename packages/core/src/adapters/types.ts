import type {
  AdapterDiagnostic,
  MachineIdentity,
  NormalizedSession,
  Provider,
  SourceRoot,
} from "../schemas";
import type { IngestRecord } from "../records";

export interface AdapterDiscoverOptions {
  readonly machine: MachineIdentity;
  readonly now: string;
  readonly roots?: Partial<Record<Provider, string>>;
  readonly logicalRoots?: Partial<Record<Provider, string>>;
  readonly limit?: number;
  readonly skip?: number;
}

export interface AdapterReadResult {
  readonly sourceRoots: SourceRoot[];
  readonly sessions: NormalizedSession[];
  readonly diagnostics: AdapterDiagnostic[];
}

export type AdapterStreamItem =
  | { readonly type: "sourceRoot"; readonly sourceRoot: SourceRoot }
  | { readonly type: "session"; readonly session: NormalizedSession }
  | { readonly type: "diagnostic"; readonly diagnostic: AdapterDiagnostic };

export type UnitFingerprint =
  {
    readonly size?: number;
    readonly mtimeMs?: number;
  };

export interface SourceUnit {
  readonly provider: Provider;
  readonly adapterId: string;
  readonly rootPath: string;
  readonly sourcePath: string;
  readonly physicalPath?: string;
}

export interface RecordStreamOptions extends AdapterDiscoverOptions {
  readonly shouldProcessUnit?: (
    unit: SourceUnit,
    fingerprint: UnitFingerprint,
  ) => boolean | Promise<boolean>;
}

export type RecordStreamItem =
  | {
      readonly type: "unitStart";
      readonly unit: SourceUnit;
      readonly fingerprint: UnitFingerprint;
    }
  | {
      readonly type: "record";
      readonly item: IngestRecord;
    }
  | { readonly type: "unitEnd"; readonly unit: SourceUnit; readonly complete: boolean }
  | { readonly type: "rootScanned"; readonly root: SourceRoot; readonly complete: boolean }
  | { readonly type: "diagnostic"; readonly diagnostic: AdapterDiagnostic };

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
  readonly streamRecords?: (options: RecordStreamOptions) => AsyncIterable<RecordStreamItem>;
}
