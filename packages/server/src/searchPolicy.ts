import type { MessageRow } from "./model";

const textEncoder = new TextEncoder();

export type SearchDocumentKind = "semantic" | "ignored";

export type SearchDocumentReason =
  | "semantic-eligible"
  | "role-not-searchable";

export interface SearchDocumentDecision {
  readonly kind: SearchDocumentKind;
  readonly reason: SearchDocumentReason;
  readonly textBytes: number;
  readonly lexical: boolean;
  readonly semantic: boolean;
}

export interface SearchDocumentPolicyStats {
  readonly total: number;
  readonly semanticEligible: number;
  readonly ignored: number;
}

export const isSearchableRole = (role: string): role is "user" | "assistant" | "reasoning" =>
  role === "user" || role === "assistant" || role === "reasoning";

export const decideSearchDocument = (message: Pick<MessageRow, "role" | "text">): SearchDocumentDecision => {
  const textBytes = textEncoder.encode(message.text).byteLength;
  if (!isSearchableRole(message.role)) {
    return {
      kind: "ignored",
      reason: "role-not-searchable",
      textBytes,
      lexical: false,
      semantic: false,
    };
  }
  return {
    kind: "semantic",
    reason: "semantic-eligible",
    textBytes,
    lexical: true,
    semantic: true,
  };
};

export const isSemanticSearchDocument = (message: Pick<MessageRow, "role" | "text">): boolean =>
  decideSearchDocument(message).semantic;

export const summarizeSearchDocumentPolicy = (messages: readonly Pick<MessageRow, "role" | "text">[]): SearchDocumentPolicyStats => {
  let semanticEligible = 0;
  let ignored = 0;
  for (const message of messages) {
    const decision = decideSearchDocument(message);
    if (decision.kind === "semantic") semanticEligible += 1;
    else ignored += 1;
  }
  return { total: messages.length, semanticEligible, ignored };
};
