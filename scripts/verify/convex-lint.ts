/**
 * BATTERY (c) — GUIDELINE CONFORMANCE
 *
 * Executable conformance checks over convex/*.ts (excluding _generated),
 * encoding the grain rulings that prose gates failed to hold:
 *
 *   1. every registered function (query/mutation/action + internal variants)
 *      declares an `args` validator;
 *   2. no `.filter(` on a ctx.db.query chain (index-only reads);
 *   3. no `.collect()` anywhere (bounded reads: take/paginate/first/unique);
 *   4. no `ctx.db` inside actions (actions are for external work);
 *   5. index names follow the by_field1_and_field2 convention;
 *   6. `toolCalls` has no search index (the structural surface is never
 *      search-indexed or embedded);
 *   7. the `messages` search index filterFields are exactly
 *      [projectKey, role, sessionId];
 *   8. embedding-surface purity: the embedding modules (embed.ts,
 *      quasarRag.ts) never reference the structural surface (toolCalls) or
 *      the non-conversation role (reasoning) — tool payloads and reasoning
 *      rows are structurally unreachable from the embedding path.
 *
 * Every violation is reported as file:line. Nonzero exit on any violation.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONVEX_DIR = join(import.meta.dir, "..", "..", "convex");

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

const violations: Violation[] = [];
const report = (file: string, line: number, rule: string, message: string) =>
  violations.push({ file, line, rule, message });

const convexSourceFiles = readdirSync(CONVEX_DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
  .filter((name) => !name.endsWith(".test.ts"))
  .map((name) => join(CONVEX_DIR, name));

/** Strip comments (preserving newlines and string contents, with quotes
 * normalized to ') so the structural checks never fire on prose. */
const stripNoise = (source: string): string => {
  let out = "";
  let index = 0;
  const length = source.length;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  while (index < length) {
    const ch = source[index]!;
    const next = source[index + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line";
        index += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "block";
        index += 2;
        continue;
      }
      if (ch === "'") mode = "single";
      else if (ch === '"') mode = "double";
      else if (ch === "`") mode = "template";
      out += ch === "'" || ch === '"' || ch === "`" ? "'" : ch;
      index += 1;
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out += "\n";
      }
      index += 1;
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = "code";
        index += 2;
        continue;
      }
      if (ch === "\n") out += "\n";
      index += 1;
      continue;
    }
    // Inside a string/template literal: contents are preserved (schema names
    // live in strings), only the delimiters are normalized.
    if (ch === "\\") {
      out += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (
      (mode === "single" && ch === "'") ||
      (mode === "double" && ch === '"') ||
      (mode === "template" && ch === "`")
    ) {
      mode = "code";
      out += "'";
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
};

const lineOfIndex = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

/** From an opening brace/paren index, find its matching closer. */
const matchDelimiter = (source: string, openIndex: number): number => {
  const open = source[openIndex]!;
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : "";
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index]!;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
};

const FUNCTION_REGISTRATION =
  /\b(query|mutation|action|internalQuery|internalMutation|internalAction|httpAction)\s*\(\s*\{/g;

/** Rule 8: the embedding pipeline's modules. Their stripped source (code +
 * strings, comments removed) must never name what they must not touch. */
const EMBEDDING_SURFACE_FILES = ["embed.ts", "quasarRag.ts"];
const EMBEDDING_SURFACE_BANNED = ["toolCalls", "reasoning"];

for (const file of convexSourceFiles) {
  const raw = readFileSync(file, "utf8");
  const source = stripNoise(raw);
  const isSchema = file.endsWith("schema.ts");

  // 1 + 4: registered functions — args validator present; no ctx.db in actions.
  for (const match of source.matchAll(FUNCTION_REGISTRATION)) {
    const kind = match[1]!;
    if (kind === "httpAction") continue;
    const braceIndex = source.indexOf("{", match.index! + match[0].length - 1);
    const endIndex = matchDelimiter(source, braceIndex);
    const body = source.slice(braceIndex, endIndex + 1);
    const line = lineOfIndex(source, match.index!);
    if (!/\bargs\s*:/.test(body)) {
      report(file, line, "validators", `${kind}() registered without an args validator`);
    }
    if ((kind === "action" || kind === "internalAction") && /\bctx\.db\b/.test(body)) {
      const offset = body.search(/\bctx\.db\b/);
      report(
        file,
        lineOfIndex(source, braceIndex + offset),
        "no-ctx-db-in-actions",
        `${kind}() touches ctx.db — actions have no database access`,
      );
    }
  }

  // 2: no .filter( on a ctx.db.query chain.
  for (const match of source.matchAll(/\.filter\s*\(/g)) {
    const statementStart = Math.max(
      source.lastIndexOf(";", match.index!),
      source.lastIndexOf("=>", match.index!),
      source.lastIndexOf("return ", match.index!),
    );
    const chain = source.slice(statementStart + 1, match.index!);
    if (/ctx\.db\s*\.\s*query\s*\(/.test(chain)) {
      report(
        file,
        lineOfIndex(source, match.index!),
        "no-db-filter",
        ".filter( on a ctx.db.query chain — define an index and use withIndex",
      );
    }
  }

  // 3: no unbounded .collect().
  for (const match of source.matchAll(/\.collect\s*\(\s*\)/g)) {
    report(
      file,
      lineOfIndex(source, match.index!),
      "no-collect",
      ".collect() is unbounded — use take/paginate/first/unique",
    );
  }

  // 8: embedding-surface purity — structurally blind to the structural
  // surface and the non-conversation role.
  if (EMBEDDING_SURFACE_FILES.some((name) => file.endsWith(`/${name}`))) {
    for (const banned of EMBEDDING_SURFACE_BANNED) {
      for (const match of source.matchAll(new RegExp(`\\b${banned}\\b`, "g"))) {
        report(
          file,
          lineOfIndex(source, match.index!),
          "embedding-surface-purity",
          `embedding module references "${banned}" — the embedding path must be structurally blind to it`,
        );
      }
    }
  }

  // 5/6/7: schema index rules (textual, so every finding carries file:line).
  if (isSchema) {
    for (const match of source.matchAll(/\.index\s*\(\s*'([^']*)'\s*,\s*\[([^\]]*)\]/g)) {
      const name = match[1]!;
      const fields = [...match[2]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
      const expected = `by_${fields.join("_and_")}`;
      if (name !== expected) {
        report(
          file,
          lineOfIndex(source, match.index!),
          "index-naming",
          `index "${name}" over [${fields.join(", ")}] must be named "${expected}"`,
        );
      }
    }
    // Locate each defineTable block and its chained calls.
    for (const match of source.matchAll(/(\w+)\s*:\s*defineTable\s*\(/g)) {
      const tableName = match[1]!;
      // Slice from the defineTable open paren through the end of its chained
      // calls (up to the next top-level `,\n\n  word:` or the schema end).
      const openParen = source.indexOf("(", match.index! + match[0].length - 1);
      let cursor = matchDelimiter(source, openParen);
      // Follow the chain: `.index(...)`, `.searchIndex(...)`, …
      while (true) {
        const rest = source.slice(cursor + 1);
        const chained = rest.match(/^\s*\.\s*\w+\s*\(/);
        if (chained === null) break;
        cursor = matchDelimiter(source, cursor + 1 + chained[0].length - 1);
      }
      const tableBlock = source.slice(match.index!, cursor + 1);
      if (tableName === "toolCalls" && tableBlock.includes("searchIndex")) {
        report(
          file,
          lineOfIndex(source, match.index!),
          "toolCalls-never-searched",
          "toolCalls declares a search index — the structural surface is never search-indexed",
        );
      }
      if (tableName === "messages") {
        const search = tableBlock.match(/searchIndex\s*\(\s*'([^']*)'\s*,\s*\{([\s\S]*?)\}\s*\)/);
        if (search === null) {
          report(
            file,
            lineOfIndex(source, match.index!),
            "messages-search",
            "messages must declare its search index (the search surface)",
          );
        } else {
          const filterFields = [
            ...(search[2]!.match(/filterFields\s*:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(
              /'([^']*)'/g,
            ),
          ].map((m) => m[1]!);
          const expected = ["projectKey", "role", "sessionId"];
          if (
            filterFields.length !== expected.length ||
            expected.some((field, i) => filterFields[i] !== field)
          ) {
            report(
              file,
              lineOfIndex(source, match.index! + tableBlock.indexOf("searchIndex")),
              "messages-search-filters",
              `messages search filterFields must be exactly [${expected.join(", ")}], found [${filterFields.join(", ")}]`,
            );
          }
        }
      }
    }
  }
}

if (violations.length === 0) {
  console.log(
    `CONVEX LINT: PASS — ${convexSourceFiles.length} file(s) conform to the grain rulings.`,
  );
} else {
  console.log(`CONVEX LINT: FAIL — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line} [${v.rule}] ${v.message}`);
  }
  process.exit(1);
}
