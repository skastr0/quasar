import { Brand } from "effect";

/**
 * Per-harness native session identifiers. Each is the content/path-independent
 * id the harness itself assigns to a session (a uuid, a session-dir name, a
 * row id, etc.) — never the machine id and never the source path. The brand
 * forces every adapter to construct its own native id explicitly, so a bare
 * string drawn from anywhere cannot silently flow into the canonical session
 * id constructor.
 */
export type CodexSessionId = string & Brand.Brand<"CodexSessionId">;
export const CodexSessionId = Brand.nominal<CodexSessionId>();

export type ClaudeSessionId = string & Brand.Brand<"ClaudeSessionId">;
export const ClaudeSessionId = Brand.nominal<ClaudeSessionId>();

export type GrokSessionId = string & Brand.Brand<"GrokSessionId">;
export const GrokSessionId = Brand.nominal<GrokSessionId>();

export type OpenCodeSessionId = string & Brand.Brand<"OpenCodeSessionId">;
export const OpenCodeSessionId = Brand.nominal<OpenCodeSessionId>();

export type HermesSessionId = string & Brand.Brand<"HermesSessionId">;
export const HermesSessionId = Brand.nominal<HermesSessionId>();

export type KimiSessionId = string & Brand.Brand<"KimiSessionId">;
export const KimiSessionId = Brand.nominal<KimiSessionId>();

export type AntigravitySessionId = string & Brand.Brand<"AntigravitySessionId">;
export const AntigravitySessionId = Brand.nominal<AntigravitySessionId>();

export type OmpSessionId = string & Brand.Brand<"OmpSessionId">;
export const OmpSessionId = Brand.nominal<OmpSessionId>();

export type PiSessionId = string & Brand.Brand<"PiSessionId">;
export const PiSessionId = Brand.nominal<PiSessionId>();

export type CursorSessionId = string & Brand.Brand<"CursorSessionId">;
export const CursorSessionId = Brand.nominal<CursorSessionId>();

export type DevinSessionId = string & Brand.Brand<"DevinSessionId">;
export const DevinSessionId = Brand.nominal<DevinSessionId>();

export type AmpSessionId = string & Brand.Brand<"AmpSessionId">;
export const AmpSessionId = Brand.nominal<AmpSessionId>();

/**
 * The union of every harness-native session id. `sessionIdFor` accepts only a
 * value of this union, so a bare `string` does not type-check as input.
 */
export type NativeSessionId =
  | CodexSessionId
  | ClaudeSessionId
  | GrokSessionId
  | OpenCodeSessionId
  | HermesSessionId
  | KimiSessionId
  | OmpSessionId
  | PiSessionId
  | CursorSessionId
  | DevinSessionId
  | AntigravitySessionId
  | AmpSessionId;

/**
 * The canonical Quasar session id. Machine- and path-INDEPENDENT: derived from
 * (provider, nativeSessionId) alone, so the same session ingested from a host
 * and from a container converges on one id. `sessionIdFor` is the sole
 * constructor.
 */
export type SessionId = string & Brand.Brand<"SessionId">;

/**
 * The version of the canonical session-identity scheme. Every stored session is
 * stamped with this so a future change to how `sessionIdFor` derives ids is an
 * explicit, versioned migration rather than silent duplication of sessions
 * under two different identity schemes.
 */
export const IDENTITY_SCHEME_VERSION = 1;
