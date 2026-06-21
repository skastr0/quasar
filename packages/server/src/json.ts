export interface JsonEnvelope<T> {
  readonly ok: true;
  readonly command: string;
  readonly data: T;
}

export interface JsonErrorEnvelope {
  readonly ok: false;
  readonly command: string;
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export const ok = <T>(command: string, data: T): JsonEnvelope<T> => ({ ok: true, command, data });

export const fail = (command: string, error: unknown): JsonErrorEnvelope => ({
  ok: false,
  command,
  error: {
    type: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    details: typeof error === "object" && error !== null && "details" in error
      ? (error as { readonly details?: unknown }).details
      : undefined,
  },
});

export const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
