import { getEncoding } from "js-tiktoken";

export const CHUNK_SIZE_TOKENS = 512;
export const CHUNK_OVERLAP_TOKENS = 50;

const MIN_FINAL_CHUNK_TOKENS = 32;

const encoder = getEncoding("cl100k_base");

export interface TextChunk {
  readonly text: string;
  readonly tokenCount: number;
  readonly startToken: number;
}

/**
 * Split `text` into chunks of at most `chunkSize` tokens, stepping forward by
 * `chunkSize - overlap` tokens. The final chunk is merged into the previous one
 * if it would be smaller than `MIN_FINAL_CHUNK_TOKENS`.
 *
 * Empty/whitespace-only input yields zero chunks.
 */
export const chunkText = (
  text: string,
  chunkSize = CHUNK_SIZE_TOKENS,
  overlap = CHUNK_OVERLAP_TOKENS,
): readonly TextChunk[] => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const tokens = encoder.encode(trimmed);
  if (tokens.length <= chunkSize) {
    return [{ text: trimmed, tokenCount: tokens.length, startToken: 0 }];
  }

  const step = Math.max(1, chunkSize - overlap);
  const rawChunks: TextChunk[] = [];
  for (let start = 0; start < tokens.length; start += step) {
    const end = Math.min(start + chunkSize, tokens.length);
    const chunkTokens = tokens.slice(start, end);
    rawChunks.push({
      text: encoder.decode(chunkTokens),
      tokenCount: chunkTokens.length,
      startToken: start,
    });
    if (end === tokens.length) break;
  }

  const last = rawChunks[rawChunks.length - 1];
  if (rawChunks.length > 1 && last.tokenCount < MIN_FINAL_CHUNK_TOKENS) {
    const previous = rawChunks[rawChunks.length - 2];
    const mergedTokens = encoder.encode(previous.text + "\n" + last.text);
    rawChunks[rawChunks.length - 2] = {
      text: encoder.decode(mergedTokens),
      tokenCount: mergedTokens.length,
      startToken: previous.startToken,
    };
    rawChunks.pop();
  }

  return rawChunks;
};

export interface MessageChunk extends TextChunk {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly projectKey: string;
  readonly chunkIndex: number;
}

export const chunkMessage = (args: {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly projectKey: string;
  readonly text: string;
}): readonly MessageChunk[] =>
  chunkText(args.text).map((chunk, chunkIndex) => ({
    ...chunk,
    sessionId: args.sessionId,
    seq: args.seq,
    role: args.role,
    projectKey: args.projectKey,
    chunkIndex,
  }));
