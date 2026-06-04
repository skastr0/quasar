import assert from "node:assert/strict";
import {
  ensureAuthorized,
  ensureJsonRequest,
  ensureStrictTokenAuthorized,
} from "../convex/httpAuth.js";

const request = (url, init = {}) => new Request(url, init);

const statusFrom = (fn) => {
  try {
    fn();
    return 200;
  } catch (error) {
    if (error instanceof Response) return error.status;
    throw error;
  }
};

assert.equal(
  statusFrom(() =>
    ensureAuthorized(request("http://127.0.0.1:3218/api/health"), {
      QUASAR_CONTROL_ALLOW_LOCAL_UNAUTH: "true",
    }),
  ),
  200,
);

assert.equal(
  statusFrom(() =>
    ensureStrictTokenAuthorized(request("http://127.0.0.1:3218/api/projects"), {
      QUASAR_CONTROL_ALLOW_LOCAL_UNAUTH: "true",
    }),
  ),
  401,
);

assert.equal(
  statusFrom(() =>
    ensureStrictTokenAuthorized(
      request("http://127.0.0.1:3218/api/projects", {
        headers: { authorization: "Bearer secret" },
      }),
      { QUASAR_CONTROL_TOKEN: "secret" },
    ),
  ),
  200,
);

assert.equal(
  statusFrom(() =>
    ensureJsonRequest(
      request("http://127.0.0.1:3218/api/projects", {
        method: "POST",
        headers: { "content-type": "text/plain" },
      }),
    ),
  ),
  415,
);

assert.equal(
  statusFrom(() =>
    ensureJsonRequest(
      request("http://127.0.0.1:3218/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    ),
  ),
  200,
);

console.log("Quasar HTTP auth smoke checks passed");
