const recordValue = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

export class MaterializeReceiptError extends Error {
  override readonly name = "MaterializeReceiptError";
  readonly details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

const fieldFailure = (key: string, expected: "number" | "string", received: unknown) =>
  new MaterializeReceiptError(`server response field must be ${expected}: ${key}`, {
    path: key,
    expected,
    received,
    hint: "Inspect the server response shape before retrying the loop.",
  });

const numberField = (value: unknown, key: string) => {
  const field = recordValue(value, key);
  return typeof field === "number" && Number.isFinite(field)
    ? { ok: true as const, value: field }
    : { ok: false as const, error: fieldFailure(key, "number", field) };
};

export const materializeCounters = [
  "scanned",
  "cacheHits",
  "cacheMisses",
  "embedded",
  "skipped",
  "sqliteVectorsUpserted",
] as const;

export type MaterializeCounter = (typeof materializeCounters)[number];

export interface MaterializeTotals {
  scanned: number;
  cacheHits: number;
  cacheMisses: number;
  embedded: number;
  skipped: number;
  sqliteVectorsUpserted: number;
}

export interface MaterializeBatchReceipt {
  readonly data: unknown;
  readonly counters: MaterializeTotals;
  readonly activeEmbeddingProvider?: string;
  readonly activeEmbeddingProfile?: string;
  readonly vectorlessMessages: number;
  readonly vectorRows: number;
}

export const emptyMaterializeTotals = (): MaterializeTotals => ({
  scanned: 0,
  cacheHits: 0,
  cacheMisses: 0,
  embedded: 0,
  skipped: 0,
  sqliteVectorsUpserted: 0,
});

export const addMaterializeTotals = (totals: MaterializeTotals, counters: MaterializeTotals): void => {
  for (const key of materializeCounters) totals[key] += counters[key];
};

export const parseMaterializeBatch = (body: unknown):
  | { readonly ok: true; readonly receipt: MaterializeBatchReceipt }
  | { readonly ok: false; readonly error: unknown } => {
  if (recordValue(body, "ok") !== true) return { ok: false, error: body };
  const data = recordValue(body, "data");
  const report = recordValue(data, "report");
  const counters = emptyMaterializeTotals();
  for (const key of materializeCounters) {
    const field = numberField(report, key);
    if (!field.ok) return field;
    counters[key] = field.value;
  }

  const coverage = recordValue(data, "coverage");
  const vectorlessMessages = numberField(coverage, "vectorlessMessages");
  if (!vectorlessMessages.ok) return vectorlessMessages;
  const vectorRows = numberField(coverage, "vectorRows");
  if (!vectorRows.ok) return vectorRows;

  const embedding = recordValue(data, "embedding");
  const activeEmbeddingProvider = recordValue(embedding, "provider");
  if (activeEmbeddingProvider !== undefined && typeof activeEmbeddingProvider !== "string") {
    return { ok: false, error: fieldFailure("embedding.provider", "string", activeEmbeddingProvider) };
  }
  const activeEmbeddingProfile = recordValue(recordValue(embedding, "profile"), "cacheNamespace");
  if (activeEmbeddingProfile !== undefined && typeof activeEmbeddingProfile !== "string") {
    return { ok: false, error: fieldFailure("embedding.profile.cacheNamespace", "string", activeEmbeddingProfile) };
  }

  return {
    ok: true,
    receipt: {
      data,
      counters,
      activeEmbeddingProvider,
      activeEmbeddingProfile,
      vectorlessMessages: vectorlessMessages.value,
      vectorRows: vectorRows.value,
    },
  };
};

export type MaterializeLoopDecision =
  | { readonly kind: "success" }
  | { readonly kind: "continue" }
  | { readonly kind: "failure"; readonly error: MaterializeReceiptError };

export const decideMaterializeLoop = (receipt: MaterializeBatchReceipt): MaterializeLoopDecision => {
  if (receipt.vectorlessMessages === 0) return { kind: "success" };
  if (receipt.counters.scanned === 0) {
    return {
      kind: "failure",
      error: new MaterializeReceiptError("materialization made no SQLite progress while vectorless messages remain", {
        expected: "scanned > 0 until vectorlessMessages reaches 0",
        received: { scanned: receipt.counters.scanned, vectorlessMessages: receipt.vectorlessMessages },
        hint: "Inspect the server response and embedding provider readiness.",
      }),
    };
  }
  return { kind: "continue" };
};

export const materializeProviders = ["local", "synthetic"] as const;
export type MaterializeProvider = (typeof materializeProviders)[number];

export const requireMaterializeProvider = (
  receipt: MaterializeBatchReceipt,
  expectedProvider: MaterializeProvider | undefined,
): MaterializeReceiptError | undefined => {
  if (expectedProvider === undefined) return undefined;
  if (receipt.activeEmbeddingProvider === expectedProvider) return undefined;
  return new MaterializeReceiptError("materialization ran under the wrong embedding provider", {
    expected: `embedding.provider = ${expectedProvider}`,
    received: receipt.activeEmbeddingProvider,
    hint: "Re-run against a server configured with the provider required by the receipt gate.",
  });
};

export const materializeClosureReceipt = (receipt: MaterializeBatchReceipt) => ({
  embedding: {
    provider: receipt.activeEmbeddingProvider,
    activeEmbeddingProfile: receipt.activeEmbeddingProfile,
  },
  coverage: {
    vectorlessMessages: receipt.vectorlessMessages,
    vectorRows: receipt.vectorRows,
  },
  gates: {
    zeroVectorlessMessages: receipt.vectorlessMessages === 0,
  },
});
