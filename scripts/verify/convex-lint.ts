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
 *   6. no Convex search/vector indexes; LanceDB owns search indexing;
 *   7. no Convex components; Quasar's Convex app is OLTP-only.
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

for (const file of convexSourceFiles) {
  const raw = readFileSync(file, "utf8");
  const source = stripNoise(raw);
  const isSchema = file.endsWith("schema.ts");
  const isConfig = file.endsWith("convex.config.ts");

  if (/\bdefineComponent\s*\(/.test(source) || /\bapp\s*\.\s*use\s*\(/.test(source)) {
    report(
      file,
      1,
      "no-convex-components",
      "Convex components are not part of Quasar's OLTP-only backend",
    );
  }

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

  if (isConfig && /@convex-dev\/(rag|workpool|migrations)/.test(raw)) {
    report(
      file,
      1,
      "no-convex-component-packages",
      "Convex component packages must not be imported by the Quasar app config",
    );
  }

  // 5/6/7: schema/index/component rules (textual, so every finding carries file:line).
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
      const searchIndex = tableBlock.indexOf("searchIndex");
      const vectorIndex = tableBlock.indexOf("vectorIndex");
      if (searchIndex !== -1) {
        report(
          file,
          lineOfIndex(source, match.index! + searchIndex),
          "no-convex-search-indexes",
          `${tableName} declares a Convex search index — LanceDB owns search indexing`,
        );
      }
      if (vectorIndex !== -1) {
        report(
          file,
          lineOfIndex(source, match.index! + vectorIndex),
          "no-convex-vector-indexes",
          `${tableName} declares a Convex vector index — LanceDB owns vector indexing`,
        );
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
