import { ConvexHttpClient } from "convex/browser";

import { configuredConvexUrl } from "./config";
import { CommandInputError } from "./errors";

/** Bounded retry for transient platform errors (e.g. TooManyWrites — a
 * documented Convex property, expected never to fire at sequential pace). */
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 250;
const TRANSIENT_ERROR =
  /toomanywrites|too many writes|429|503|overloaded|rate.?limit|timed?.?out|fetch failed|econnrefused|econnreset|socket|network/i;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const withRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= RETRY_ATTEMPTS || !TRANSIENT_ERROR.test(message)) throw error;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
};

export const createConvexClient = (): ConvexHttpClient => {
  const url = configuredConvexUrl();
  if (url === undefined || url.length === 0) {
    throw new CommandInputError({
      field: "CONVEX_URL",
      message:
        "Convex backend URL not found: set CONVEX_SELF_HOSTED_URL, CONVEX_URL, or ~/.config/quasar/config.json with convexUrl/fallbackUrls.convexUrl.",
    });
  }
  // The quasar functions are public; no admin auth is needed.
  return new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true });
};
