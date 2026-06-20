import type { IngestReport } from "../../local-server/src/ingest";

export const summarizeIngestReports = (reports: readonly IngestReport[]) => ({
  reports: reports.map((report) => ({
    provider: report.provider,
    sessionsSeen: report.sessionsSeen,
    sessionsWritten: report.sessionsWritten,
    sessionsSkipped: report.sessionsSkipped,
    sessionsFailed: report.sessionsFailed,
    messagesWritten: report.messagesWritten,
    toolCallsWritten: report.toolCallsWritten,
    jobsEnqueued: report.jobsEnqueued,
    searchDocuments: report.searchDocuments,
    failures: report.failures,
    durationMs: report.durationMs,
  })),
});

export class IngestFailedError extends Error {
  override readonly name = "IngestFailedError";
  readonly details: ReturnType<typeof summarizeIngestReports>;

  constructor(reports: readonly IngestReport[]) {
    const failedSessions = reports.reduce((total, report) => total + report.sessionsFailed, 0);
    super(`quasar ingest failed for ${failedSessions} session${failedSessions === 1 ? "" : "s"}`);
    this.details = summarizeIngestReports(reports);
  }
}

export const ingestFailureError = (reports: readonly IngestReport[]): IngestFailedError | undefined =>
  reports.some((report) => report.sessionsFailed > 0) ? new IngestFailedError(reports) : undefined;

export const ingestReportPayload = (reports: readonly IngestReport[], summary: boolean) =>
  summary ? summarizeIngestReports(reports) : reports;
