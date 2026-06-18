import { statSync } from "node:fs";
import { join } from "node:path";

import { Args, Command, Options } from "@effect/cli";
import { Effect } from "effect";

import {
  adaptersByProvider,
  loadMachineIdentity,
  quasarHome,
  sourceFingerprintFor,
  type AdapterStreamItem,
  type NormalizedSession,
  type Provider,
  type SessionAdapter,
  type SourceRoot,
} from "@skastr0/quasar-core";

import { mapNormalizedSession, PROVIDER_INGEST_HOOKS } from "./ingest";
import { loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { openIngestLedger, type IngestLedger } from "../ingest-ledger";
import { DiscoverOptions } from "../protocol";

const inputArg = Args.text({ name: "input" }).pipe(Args.optional);
const toUndefined = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }) =>
  value._tag === "Some" ? value.value : undefined;

const providerOption = Options.text("provider").pipe(
  Options.withDescription("Provider to scan (default: all stable providers)"),
  Options.optional,
);

const rootOption = Options.text("root").pipe(
  Options.withDescription("Override provider root (single-provider mode)"),
  Options.optional,
);

const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Limit sessions scanned per provider"),
  Options.optional,
);

const verboseOption = Options.boolean("verbose").pipe(
  Options.withDescription("Show per-session detail"),
  Options.optional,
);

/** Bytes-to-tokens approximation for sessions lacking provider-reported usage. */
const BYTES_PER_TOKEN_APPROX = 4;

export interface EstimatedIngest {
  readonly sessions: number;
  readonly messages: number;
  readonly toolCalls: number;
  readonly bytes: number;
  readonly approxMB: number;
  readonly estimatedTokens: number;
  readonly reportedTokens: number;
}

export interface ScanSessionDetail {
  readonly sessionId: string;
  readonly provider: Provider;
  readonly status: "ingested" | "new" | "changed";
  readonly messages: number;
  readonly toolCalls: number;
  readonly bytes: number;
  readonly estimatedTokens: number;
  readonly reportedTokens: number;
}

export interface ScanProviderReport {
  readonly provider: Provider;
  readonly adapterId: string;
  readonly displayName: string;
  readonly stable: boolean;
  readonly sourceRoots: readonly SourceRoot[];
  readonly diagnostics: readonly { status: string; message: string; rootPath?: string }[];
  readonly totalSessionsDiscovered: number;
  readonly ingestedSessions: number;
  readonly newOrChangedSessions: number;
  readonly estimatedIngest: EstimatedIngest;
  readonly sessionDetails?: readonly ScanSessionDetail[];
}

export interface ScanTotals {
  readonly totalSessionsDiscovered: number;
  readonly ingestedSessions: number;
  readonly newOrChangedSessions: number;
  readonly estimatedIngest: EstimatedIngest;
}

export interface ScanReport {
  readonly generatedAt: string;
  readonly ledger: { readonly path: string; readonly entries: number };
  readonly providers: readonly ScanProviderReport[];
  readonly totals: ScanTotals;
}

const emptyEstimatedIngest = (): EstimatedIngest => ({
  sessions: 0,
  messages: 0,
  toolCalls: 0,
  bytes: 0,
  approxMB: 0,
  estimatedTokens: 0,
  reportedTokens: 0,
});

interface MutableEstimatedIngest {
  sessions: number;
  messages: number;
  toolCalls: number;
  bytes: number;
  approxMB: number;
  estimatedTokens: number;
  reportedTokens: number;
}

const addSessionToEstimate = (
  acc: MutableEstimatedIngest,
  messages: number,
  toolCalls: number,
  bytes: number,
  estimatedTokens: number,
  reportedTokens: number,
): void => {
  acc.sessions += 1;
  acc.messages += messages;
  acc.toolCalls += toolCalls;
  acc.bytes += bytes;
  acc.estimatedTokens += estimatedTokens;
  acc.reportedTokens += reportedTokens;
  acc.approxMB = acc.bytes / (1024 * 1024);
};

/**
 * Sum provider-reported token counts from usage records. These are
 * cumulative context-window accounting (input_tokens repeats the running
 * context size every turn), NOT per-turn new tokens. Kept as metadata only;
 * the ingest volume estimate is byte-based (bytesAdmitted / 4).
 */
const reportedTokensFor = (session: NormalizedSession): number => {
  let total = 0;
  for (const record of session.usageRecords) {
    if (record.totalTokens !== undefined) {
      total += record.totalTokens;
      continue;
    }
    const input = record.inputTokens ?? 0;
    const output = record.outputTokens ?? 0;
    if (input + output > 0) total += input + output;
  }
  return total;
};

/** Resolve the source fingerprint for a streamed session item. */
const resolveFingerprint = (
  item: Extract<AdapterStreamItem, { type: "session" }>,
): string => {
  if (item.fingerprint !== undefined) {
    return JSON.stringify(item.fingerprint);
  }
  const physicalPath = item.sourceUnit?.physicalPath ?? item.session.sourcePath;
  return sourceFingerprintFor(statSync(physicalPath));
};

/**
 * Stream a single adapter, probing each session against the ledger.
 * - Ingested sessions (ledger hit): skip expensive parse, classify "ingested".
 * - New/changed sessions: parse to get message/toolCall/byte/token counts.
 */
export const scanAdapter = async (
  adapter: SessionAdapter,
  ledger: IngestLedger,
  options: {
    readonly root?: string;
    readonly limit?: number;
    readonly verbose?: boolean;
  },
  now: string,
): Promise<ScanProviderReport> => {
  const provider = adapter.provider;
  const hooks = PROVIDER_INGEST_HOOKS.get(provider) ?? {};
  const sourceRoots: SourceRoot[] = [];
  const diagnostics: { status: string; message: string; rootPath?: string }[] = [];
  const sessionDetails: ScanSessionDetail[] = [];
  const estimated: MutableEstimatedIngest = emptyEstimatedIngest() as MutableEstimatedIngest;
  let totalDiscovered = 0;
  let ingested = 0;
  let newOrChanged = 0;

  const stream = adapter.stream;
  if (stream === undefined) {
    return {
      provider,
      adapterId: adapter.id,
      displayName: adapter.displayName,
      stable: adapter.stable,
      sourceRoots,
      diagnostics: [
        {
          status: "no_data_found",
          message: `The ${provider} adapter does not expose a session stream.`,
        },
      ],
      totalSessionsDiscovered: 0,
      ingestedSessions: 0,
      newOrChangedSessions: 0,
      estimatedIngest: emptyEstimatedIngest(),
      ...(options.verbose ? { sessionDetails } : {}),
    };
  }

  const streamOptions: Parameters<typeof stream>[0] = {
    machine: loadMachineIdentity(),
    now,
    ...(options.root !== undefined ? { roots: { [provider]: options.root } } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    shouldParseSession: (probe) => {
      totalDiscovered += 1;
      if (ledger.has(probe.sessionId, probe.sourceFingerprint)) {
        ingested += 1;
        if (options.verbose) {
          sessionDetails.push({
            sessionId: probe.sessionId,
            provider,
            status: "ingested",
            messages: 0,
            toolCalls: 0,
            bytes: 0,
            estimatedTokens: 0,
            reportedTokens: 0,
          });
        }
        return false;
      }
      return true;
    },
  };

  const items = stream(streamOptions);
  for await (const item of items) {
    if (item.type === "sourceRoot") {
      sourceRoots.push(item.sourceRoot);
      continue;
    }
    if (item.type === "diagnostic") {
      diagnostics.push({
        status: item.diagnostic.status,
        message: item.diagnostic.message,
        ...(item.diagnostic.rootPath !== undefined
          ? { rootPath: item.diagnostic.rootPath }
          : {}),
      });
      continue;
    }
    if (item.type !== "session") continue;

    const session = item.session;
    const sourceFingerprint = resolveFingerprint(item);
    const isChanged = ledger.has(session.id, sourceFingerprint);
    const status: "new" | "changed" = isChanged ? "changed" : "new";
    newOrChanged += 1;

    const mapped = mapNormalizedSession(session, hooks);
    const bytes = mapped.bytesAdmitted;
    const messages = mapped.messages.length;
    const toolCalls = mapped.toolCalls.length;
    // Provider usage records are cumulative context-window accounting, not
    // per-turn new tokens — summing them massively overcounts. The ingest
    // volume estimate is byte-based: bytesAdmitted is the actual product text
    // that will be stored. reportedTokens is kept as metadata only.
    const estimatedTokens = Math.ceil(bytes / BYTES_PER_TOKEN_APPROX);
    const reported = reportedTokensFor(session);

    addSessionToEstimate(estimated, messages, toolCalls, bytes, estimatedTokens, reported);

    if (options.verbose) {
      sessionDetails.push({
        sessionId: session.id,
        provider,
        status,
        messages,
        toolCalls,
        bytes,
        estimatedTokens,
        reportedTokens: reported,
      });
    }
  }

  return {
    provider,
    adapterId: adapter.id,
    displayName: adapter.displayName,
    stable: adapter.stable,
    sourceRoots,
    diagnostics,
    totalSessionsDiscovered: totalDiscovered,
    ingestedSessions: ingested,
    newOrChangedSessions: newOrChanged,
    estimatedIngest: {
      sessions: estimated.sessions,
      messages: estimated.messages,
      toolCalls: estimated.toolCalls,
      bytes: estimated.bytes,
      approxMB: estimated.approxMB,
      estimatedTokens: estimated.estimatedTokens,
      reportedTokens: estimated.reportedTokens,
    },
    ...(options.verbose ? { sessionDetails } : {}),
  };
};

const mergeTotals = (reports: readonly ScanProviderReport[]): ScanTotals => {
  const acc: MutableEstimatedIngest = emptyEstimatedIngest() as MutableEstimatedIngest;
  let totalDiscovered = 0;
  let ingested = 0;
  let newOrChanged = 0;
  for (const report of reports) {
    totalDiscovered += report.totalSessionsDiscovered;
    ingested += report.ingestedSessions;
    newOrChanged += report.newOrChangedSessions;
    acc.sessions += report.estimatedIngest.sessions;
    acc.messages += report.estimatedIngest.messages;
    acc.toolCalls += report.estimatedIngest.toolCalls;
    acc.bytes += report.estimatedIngest.bytes;
    acc.estimatedTokens += report.estimatedIngest.estimatedTokens;
    acc.reportedTokens += report.estimatedIngest.reportedTokens;
  }
  acc.approxMB = acc.bytes / (1024 * 1024);
  return {
    totalSessionsDiscovered: totalDiscovered,
    ingestedSessions: ingested,
    newOrChangedSessions: newOrChanged,
    estimatedIngest: acc,
  };
};

const selectAdapters = (
  providers: readonly Provider[] | undefined,
  includeExperimental: boolean,
): readonly SessionAdapter[] => {
  const allAdapters = [...adaptersByProvider.values()];
  const candidates = includeExperimental
    ? allAdapters
    : allAdapters.filter((adapter) => adapter.stable);
  if (providers === undefined || providers.length === 0) return candidates;
  const selected = new Set(providers);
  return candidates.filter((adapter) => selected.has(adapter.provider));
};

export const scanCommand = Command.make(
  "scan",
  {
    input: inputArg,
    provider: providerOption,
    root: rootOption,
    limit: limitOption,
    verbose: verboseOption,
  },
  ({ input, provider, root, limit, verbose }) =>
    executeJsonCommand(
      "scan",
      Effect.gen(function* () {
        const inputText = toUndefined(input);
        const options = yield* loadOptionalJsonInput(
          DiscoverOptions,
          inputText,
          { includeExperimental: true },
        );

        const providerValue = toUndefined(provider);
        const rootValue = toUndefined(root);
        const limitValue = toUndefined(limit);
        const verboseValue = toUndefined(verbose) ?? false;

        const providers =
          providerValue !== undefined && providerValue !== "all"
            ? [providerValue as Provider]
            : options.providers;
        const adapters = selectAdapters(providers, options.includeExperimental ?? true);

        const now = new Date().toISOString();

        const report = yield* Effect.tryPromise({
          try: async () => {
            const ledger = openIngestLedger();
            const providerReports = await Promise.all(
              adapters.map((adapter) =>
                scanAdapter(
                  adapter,
                  ledger,
                  {
                    ...(rootValue !== undefined ? { root: rootValue } : {}),
                    ...(limitValue !== undefined ? { limit: limitValue } : {}),
                    verbose: verboseValue,
                  },
                  now,
                ),
              ),
            );
            ledger.close();
            const ledgerPath = join(quasarHome(), "ingest-fingerprints.json");
            const ledgerEntries = providerReports.reduce(
              (sum, report) => sum + report.ingestedSessions,
              0,
            );
            const result: ScanReport = {
              generatedAt: now,
              ledger: { path: ledgerPath, entries: ledgerEntries },
              providers: providerReports,
              totals: mergeTotals(providerReports),
            };
            return result;
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });

        return report;
      }),
    ),
);