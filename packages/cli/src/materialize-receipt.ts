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

const fieldFailure = (key: string, expected: "number" | "boolean" | "string", received: unknown) =>
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

const optionalNumberField = (value: unknown, key: string) => {
  const field = recordValue(value, key);
  return field === undefined || (typeof field === "number" && Number.isFinite(field))
    ? { ok: true as const, value: field as number | undefined }
    : { ok: false as const, error: fieldFailure(key, "number", field) };
};

const booleanField = (value: unknown, key: string) => {
  const field = recordValue(value, key);
  return typeof field === "boolean"
    ? { ok: true as const, value: field }
    : { ok: false as const, error: fieldFailure(key, "boolean", field) };
};

export const materializeCounters = [
  "scanned",
  "cacheHits",
  "cacheMisses",
  "embedded",
  "skipped",
  "sqliteVectorsUpserted",
  "lanceRowsUpserted",
  "lanceRowsRepaired",
] as const;

export type MaterializeCounter = (typeof materializeCounters)[number];

export interface MaterializeTotals {
  scanned: number;
  cacheHits: number;
  cacheMisses: number;
  embedded: number;
  skipped: number;
  sqliteVectorsUpserted: number;
  lanceRowsUpserted: number;
  lanceRowsRepaired: number;
}

export interface MaterializeBatchReceipt {
  readonly data: unknown;
  readonly counters: MaterializeTotals;
  readonly activeEmbeddingProvider?: string;
  readonly vectorlessMessages: number;
  readonly vectorRows: number;
  readonly rowCountMatches: boolean;
  readonly rowCountDelta?: number;
  readonly sqliteVectorRows: number;
  readonly lanceRowCount?: number;
  readonly failedEmbedMessages: number;
  readonly pendingEmbedMessages: number;
  readonly globalFailedEmbedMessages: number;
  readonly globalPendingEmbedMessages: number;
  readonly activeEmbeddingProfile?: string;
  readonly activeVectorTableName?: string;
  readonly lanceScanComplete: boolean;
  readonly nextLanceOffset: number;
}

export const emptyMaterializeTotals = (): MaterializeTotals => ({
  scanned: 0,
  cacheHits: 0,
  cacheMisses: 0,
  embedded: 0,
  skipped: 0,
  sqliteVectorsUpserted: 0,
  lanceRowsUpserted: 0,
  lanceRowsRepaired: 0,
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

  const lanceScan = recordValue(report, "lanceScan");
  const nextLanceOffset = numberField(lanceScan, "nextOffset");
  if (!nextLanceOffset.ok) return nextLanceOffset;
  const lanceScanComplete = booleanField(lanceScan, "complete");
  if (!lanceScanComplete.ok) return lanceScanComplete;

  const coverage = recordValue(data, "coverage");
  const vectorlessMessages = numberField(coverage, "vectorlessMessages");
  if (!vectorlessMessages.ok) return vectorlessMessages;
  const vectorRows = numberField(coverage, "vectorRows");
  if (!vectorRows.ok) return vectorRows;

  const lance = recordValue(data, "lance");
  const divergence = recordValue(lance, "divergence");
  const rowCountMatches = booleanField(divergence, "rowCountMatches");
  if (!rowCountMatches.ok) return rowCountMatches;
  const rowCountDelta = optionalNumberField(divergence, "rowCountDelta");
  if (!rowCountDelta.ok) return rowCountDelta;
  const sqliteVectorRows = numberField(divergence, "sqliteVectorRows");
  if (!sqliteVectorRows.ok) return sqliteVectorRows;
  const lanceRowCount = optionalNumberField(divergence, "lanceRowCount");
  if (!lanceRowCount.ok) return lanceRowCount;

  const queue = recordValue(data, "queue");
  const queueEmbedMessage = recordValue(queue, "embedMessage");
  const activeQueueEmbedMessage = recordValue(queue, "activeEmbedMessage") ?? queueEmbedMessage;
  const failedEmbedMessages = numberField(activeQueueEmbedMessage, "failed");
  if (!failedEmbedMessages.ok) return failedEmbedMessages;
  const pendingEmbedMessages = numberField(activeQueueEmbedMessage, "pending");
  if (!pendingEmbedMessages.ok) return pendingEmbedMessages;
  const globalFailedEmbedMessages = numberField(queueEmbedMessage ?? activeQueueEmbedMessage, "failed");
  if (!globalFailedEmbedMessages.ok) return globalFailedEmbedMessages;
  const globalPendingEmbedMessages = numberField(queueEmbedMessage ?? activeQueueEmbedMessage, "pending");
  if (!globalPendingEmbedMessages.ok) return globalPendingEmbedMessages;

  const activeEmbeddingProfile = recordValue(queue, "activeEmbeddingProfile");
  if (activeEmbeddingProfile !== undefined && typeof activeEmbeddingProfile !== "string") {
    return { ok: false, error: fieldFailure("activeEmbeddingProfile", "string", activeEmbeddingProfile) };
  }

  const activeVectorTableName = recordValue(lance, "activeVectorTableName");
  if (activeVectorTableName !== undefined && typeof activeVectorTableName !== "string") {
    return { ok: false, error: fieldFailure("activeVectorTableName", "string", activeVectorTableName) };
  }

  const activeEmbeddingProvider = recordValue(recordValue(data, "embedding"), "provider");
  if (activeEmbeddingProvider !== undefined && typeof activeEmbeddingProvider !== "string") {
    return { ok: false, error: fieldFailure("embedding.provider", "string", activeEmbeddingProvider) };
  }

  return {
    ok: true,
    receipt: {
      data,
      counters,
      activeEmbeddingProvider,
      vectorlessMessages: vectorlessMessages.value,
      vectorRows: vectorRows.value,
      rowCountMatches: rowCountMatches.value,
      rowCountDelta: rowCountDelta.value,
      sqliteVectorRows: sqliteVectorRows.value,
      lanceRowCount: lanceRowCount.value,
      failedEmbedMessages: failedEmbedMessages.value,
      pendingEmbedMessages: pendingEmbedMessages.value,
      globalFailedEmbedMessages: globalFailedEmbedMessages.value,
      globalPendingEmbedMessages: globalPendingEmbedMessages.value,
      activeEmbeddingProfile,
      activeVectorTableName,
      lanceScanComplete: lanceScanComplete.value,
      nextLanceOffset: nextLanceOffset.value,
    },
  };
};

export type MaterializeLoopDecision =
  | { readonly kind: "success" }
  | { readonly kind: "continue"; readonly nextLanceOffset: number }
  | { readonly kind: "failure"; readonly error: MaterializeReceiptError };

export const decideMaterializeLoop = (receipt: MaterializeBatchReceipt): MaterializeLoopDecision => {
  if (
    receipt.vectorlessMessages === 0
    && receipt.rowCountMatches
    && receipt.failedEmbedMessages === 0
    && receipt.lanceScanComplete
  ) return { kind: "success" };
  if (receipt.vectorlessMessages > 0 && receipt.counters.scanned === 0) {
    return {
      kind: "failure",
      error: new MaterializeReceiptError("materialization made no SQLite progress while vectorless messages remain", {
        expected: "scanned > 0 until vectorlessMessages reaches 0",
        received: { scanned: receipt.counters.scanned, vectorlessMessages: receipt.vectorlessMessages },
        hint: "Inspect the server response and embedding provider readiness.",
      }),
    };
  }
  if (receipt.vectorlessMessages === 0 && receipt.rowCountMatches && receipt.lanceScanComplete && receipt.failedEmbedMessages > 0) {
    return {
      kind: "failure",
      error: new MaterializeReceiptError("active-profile embed-message dead letters remain after vector materialization", {
        expected: "queue.activeEmbedMessage.failed = 0",
        received: {
          activeEmbeddingProfile: receipt.activeEmbeddingProfile,
          failed: receipt.failedEmbedMessages,
        },
        hint: "Drain or inspect failed embed-message jobs for the active embedding profile before accepting the coverage receipt.",
      }),
    };
  }
  if (receipt.vectorlessMessages === 0 && receipt.lanceScanComplete && !receipt.rowCountMatches) {
    return {
      kind: "failure",
      error: new MaterializeReceiptError("LanceDB divergence remains after a full SQLite-vector repair pass", {
        expected: "active Lance row count matches SQLite vector rows",
        received: recordValue(recordValue(receipt.data, "lance"), "divergence"),
        hint: "Run maintenance inspection before treating semantic/fusion search as rebuilt.",
      }),
    };
  }
  return {
    kind: "continue",
    nextLanceOffset: receipt.vectorlessMessages === 0 ? receipt.nextLanceOffset : 0,
  };
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
  queue: {
    activeEmbeddingProfile: receipt.activeEmbeddingProfile,
    embedMessage: {
      pending: receipt.pendingEmbedMessages,
      failed: receipt.failedEmbedMessages,
    },
    globalEmbedMessage: {
      pending: receipt.globalPendingEmbedMessages,
      failed: receipt.globalFailedEmbedMessages,
    },
  },
  lance: {
    activeVectorTableName: receipt.activeVectorTableName,
    sqliteVectorRows: receipt.sqliteVectorRows,
    lanceRowCount: receipt.lanceRowCount,
    rowCountMatches: receipt.rowCountMatches,
    rowCountDelta: receipt.rowCountDelta,
    scanComplete: receipt.lanceScanComplete,
    nextOffset: receipt.nextLanceOffset,
  },
  gates: {
    zeroVectorlessMessages: receipt.vectorlessMessages === 0,
    zeroActiveEmbedMessageDeadLetters: receipt.failedEmbedMessages === 0,
    lanceRowCountMatches: receipt.rowCountMatches,
    lanceRepairScanComplete: receipt.lanceScanComplete,
  },
});
