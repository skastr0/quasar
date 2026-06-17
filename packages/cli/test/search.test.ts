import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { getFunctionName } from "convex/server";

import {
  checkedSearchLimit,
  runSearchQuery,
  searchActionForMode,
  type SearchActionClient,
} from "../src/commands/search";

class FakeSearchClient implements SearchActionClient {
  reference: unknown;
  args: unknown;

  action(reference: unknown, args: unknown): Promise<unknown> {
    this.reference = reference;
    this.args = args;
    return Promise.resolve({
      matches: [],
      diagnostics: {
        textSearched: true,
        semanticSearched: false,
        semanticStatus: "unavailable",
      },
    });
  }
}

describe("search command wiring", () => {
  test("maps modes to LanceDB-backed search actions", () => {
    expect(getFunctionName(searchActionForMode("text") as never)).toBe("search:searchLexical");
    expect(getFunctionName(searchActionForMode("semantic") as never)).toBe("search:searchSemantic");
    expect(getFunctionName(searchActionForMode("fusion") as never)).toBe("search:searchFusion");
  });

  test("sends secret, query, project, and limit to the selected action", async () => {
    const client = new FakeSearchClient();
    await runSearchQuery({
      client,
      actionSecret: "test-secret",
      query: "  convex node actions  ",
      mode: "fusion",
      projectKey: "git:example/project",
      limit: 7,
    });

    expect(getFunctionName(client.reference as never)).toBe("search:searchFusion");
    expect(client.args).toEqual({
      secret: "test-secret",
      query: "convex node actions",
      limit: 7,
      projectKey: "git:example/project",
    });
  });

  test("validates limit and action secret before network calls", async () => {
    expect(checkedSearchLimit(Option.none())).toBe(10);
    expect(() => checkedSearchLimit(Option.some(21))).toThrow(/limit must be/);
    await expect(
      runSearchQuery({
        client: new FakeSearchClient(),
        actionSecret: "",
        query: "anything",
        mode: "text",
        limit: 1,
      }),
    ).rejects.toThrow(/Search actions require QUASAR_ACTION_SECRET/);
  });
});
