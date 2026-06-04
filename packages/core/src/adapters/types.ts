import type {
  AdapterDiagnostic,
  MachineIdentity,
  NormalizedSession,
  Provider,
  SourceRoot,
} from "../schemas";

export interface AdapterDiscoverOptions {
  readonly machine: MachineIdentity;
  readonly now: string;
  readonly roots?: Partial<Record<Provider, string>>;
  readonly limit?: number;
}

export interface AdapterReadResult {
  readonly sourceRoots: SourceRoot[];
  readonly sessions: NormalizedSession[];
  readonly diagnostics: AdapterDiagnostic[];
}

export interface SessionAdapter {
  readonly id: string;
  readonly provider: Provider;
  readonly displayName: string;
  readonly stable: boolean;
  readonly defaultRoot: () => string | undefined;
  readonly read: (options: AdapterDiscoverOptions) => Promise<AdapterReadResult>;
}
