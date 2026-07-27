import { expect, test } from "bun:test";

import { parseCliArguments } from "../src/argv";

test("argument parsing exposes option names without reclassifying option-shaped values", () => {
  const parsed = parseCliArguments(
    ["messages", "--model", "--detail", "--mystery", "value"],
    new Set(["--model"]),
  );

  expect(parsed.positionals).toEqual(["messages", "value"]);
  expect(parsed.optionNames).toEqual(["--model", "--mystery"]);
  expect(parsed.first("--model")).toBe("--detail");
  expect(parsed.has("--detail")).toBe(false);
});
