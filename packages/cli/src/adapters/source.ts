import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  type Stats,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

/**
 * Shared adapter source plumbing (Move 2).
 *
 * Proven duplication only:
 * - walkFiles / walkFilesWithStats — recursive discovery + skip/limit
 * - streamJsonlRecords — async JSONL line reader with named line diagnostics
 * - sqliteSnapshotForRead — copy live sqlite (+wal/shm) for read-only queries
 *
 * Adapters keep harness-specific generators; this module owns only the
 * literally-repeated file/source substrate.
 */

/** Same shape as DecodeDiagnostic / BoundaryDiagnostic — kept local to avoid cycles. */
type DiagnosticSink = {
  readonly push: (diagnostic: {
    readonly name: string;
    readonly message: string;
  }) => void;
};

export type WalkFilesOptions = {
  readonly limit?: number;
  readonly skip?: number;
};

const parseWalkInput = (root: string, limit: number | undefined, skip: number | undefined) => {
  const trimmedRoot = root.trim();
  if (trimmedRoot.length === 0 || (limit !== undefined && limit <= 0)) return undefined;
  return {
    root: trimmedRoot,
    limit:
      limit === undefined || !Number.isFinite(limit)
        ? Number.POSITIVE_INFINITY
        : Math.floor(limit),
    skip:
      skip === undefined || !Number.isFinite(skip) || skip <= 0
        ? 0
        : Math.floor(skip),
  };
};

/**
 * Depth-first sorted walk yielding matching file paths with their stats.
 * Skip applies to the match stream (not directory entries); limit caps yields.
 */
export function* walkFilesWithStats(
  root: string,
  predicate: (path: string) => boolean,
  options: WalkFilesOptions = {},
): Generator<{ readonly path: string; readonly stats: Stats }> {
  const input = parseWalkInput(root, options.limit, options.skip);
  if (input === undefined || !existsSync(input.root)) return;
  const walkInput = input;
  let matched = 0;
  let emitted = 0;

  function* visit(path: string): Generator<{ readonly path: string; readonly stats: Stats }> {
    if (emitted >= walkInput.limit) return;
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        yield* visit(join(path, entry));
        if (emitted >= walkInput.limit) return;
      }
      return;
    }
    if (!predicate(path)) return;
    if (matched >= walkInput.skip) {
      emitted += 1;
      yield { path, stats };
    }
    matched += 1;
  }

  yield* visit(walkInput.root);
}

/**
 * Collect matching file paths under root with skip/limit.
 * Same discovery math as walkFilesWithStats; path-only convenience.
 */
export const walkFiles = (
  root: string,
  predicate: (path: string) => boolean,
  limit: number = Number.POSITIVE_INFINITY,
  skip: number = 0,
): string[] => {
  const files: string[] = [];
  for (const { path } of walkFilesWithStats(root, predicate, { limit, skip })) {
    files.push(path);
  }
  return files;
};

export type StreamJsonlRecord = {
  readonly value: unknown;
  readonly lineNumber: number;
  /** Zero-based index among successfully parsed non-empty lines. */
  readonly recordIndex: number;
};

export type StreamJsonlOptions = {
  /**
   * When true, the first invalid JSON line throws. Prefer a custom
   * `strictError` so harnesses keep their named error types.
   */
  readonly strict?: boolean;
  readonly strictError?: (path: string, lineNumber: number, cause: unknown) => Error;
  readonly diagnosticName?: string;
  readonly diagnostics?: DiagnosticSink;
  readonly sourcePath?: string;
};

/**
 * Stream a JSONL file line-by-line. Corrupt lines emit a named diagnostic
 * (when a sink is supplied) and are dropped; the rest of the file continues.
 * File-open failures surface as a thrown error from createReadStream / readline
 * (callers that need soft missing-file behavior should stat first).
 */
export async function* streamJsonlRecords(
  path: string,
  options: StreamJsonlOptions = {},
): AsyncGenerator<StreamJsonlRecord> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let recordIndex = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    try {
      yield { value: JSON.parse(line) as unknown, lineNumber, recordIndex };
      recordIndex += 1;
    } catch (cause) {
      if (options.strict === true) {
        throw (
          options.strictError?.(path, lineNumber, cause) ??
          new Error(
            `Failed to parse JSONL record at ${path}:${lineNumber}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          )
        );
      }
      if (options.diagnostics !== undefined) {
        const diagnosticName = options.diagnosticName ?? "json.line.invalid";
        options.diagnostics.push({
          name: diagnosticName,
          message: `${diagnosticName} at ${options.sourcePath ?? path}:${lineNumber}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
      }
    }
  }
}

export type SqliteSnapshot = {
  readonly path: string;
  readonly cleanup: () => void;
};

export type SqliteSnapshotOptions = {
  /** Temp-directory name prefix (after `quasar-`). Default: `"sqlite"`. */
  readonly label?: string;
  /**
   * Filename inside the temp dir. Default: `basename(dbPath)`.
   * Antigravity/opencode pin a fixed name; hermes keeps the source basename.
   */
  readonly fileName?: string;
};

/**
 * Copy a live sqlite database (with optional -wal / -shm sidecars) into a temp
 * directory for lock-free reads. Call `cleanup()` when done.
 */
export const sqliteSnapshotForRead = (
  dbPath: string,
  options: SqliteSnapshotOptions = {},
): SqliteSnapshot => {
  const label = options.label ?? "sqlite";
  const tempDir = mkdtempSync(join(tmpdir(), `quasar-${label}-`));
  const fileName = options.fileName ?? basename(dbPath);
  const tempDbPath = join(tempDir, fileName);
  copyFileSync(dbPath, tempDbPath);
  for (const suffix of ["-wal", "-shm"] as const) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${tempDbPath}${suffix}`);
  }
  return {
    path: tempDbPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
};
