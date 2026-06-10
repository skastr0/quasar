import { Duration, Effect } from "effect";

import {
  IngestRecordsResponse,
  QuasarApiPaths,
  RECORD_LIMITS,
  type RecordEnvelope,
} from "@skastr0/quasar-core";

import { requestJson } from "../api";

export type RecordEnvelopeSender<E = never, R = never> = {
  readonly send: (envelope: RecordEnvelope) => Effect.Effect<IngestRecordsResponse, E, R>;
};

const sleepForBackpressure = (response: IngestRecordsResponse) => {
  const retryAfterMs = response.backpressure.retryAfterMs ?? 0;
  return retryAfterMs > 0 ? Effect.sleep(Duration.millis(retryAfterMs)) : Effect.void;
};

export const liveRecordSender = {
  send: (envelope: RecordEnvelope) =>
    requestJson({
      method: "POST",
      path: QuasarApiPaths.ingestRecords,
      body: envelope,
      responseSchema: IngestRecordsResponse,
    }).pipe(Effect.tap(sleepForBackpressure)),
};

export const dryRunRecordSender: RecordEnvelopeSender = {
  send: (envelope) =>
    Effect.succeed({
      protocol: envelope.protocol,
      applied: envelope.records.filter((record) => record.type !== "tombstone").length,
      unchanged: 0,
      tombstoned: envelope.records.filter((record) => record.type === "tombstone").length,
      backpressure: {
        outboxDepth: 0,
        retryAfterMs: null,
      },
      limits: RECORD_LIMITS,
    }),
};
