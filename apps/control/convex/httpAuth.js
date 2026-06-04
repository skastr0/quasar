export const isLoopbackRequest = (req) => {
  const hostname = new URL(req.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
};

const tokenFrom = (env) => env.QUASAR_CONTROL_TOKEN?.trim();

export const ensureAuthorized = (req, env = process.env) => {
  const expected = tokenFrom(env);
  if (expected === undefined || expected.length === 0) {
    if (
      env.QUASAR_CONTROL_ALLOW_LOCAL_UNAUTH === "true" &&
      isLoopbackRequest(req)
    ) {
      return;
    }
    throw new Response("Quasar token is not configured.", { status: 401 });
  }
  if (req.headers.get("authorization") !== `Bearer ${expected}`) {
    throw new Response("Unauthorized", { status: 401 });
  }
};

export const ensureStrictTokenAuthorized = (req, env = process.env) => {
  const expected = tokenFrom(env);
  if (expected === undefined || expected.length === 0) {
    throw new Response("Quasar token is required for mutations.", { status: 401 });
  }
  if (req.headers.get("authorization") !== `Bearer ${expected}`) {
    throw new Response("Unauthorized", { status: 401 });
  }
};

export const ensureJsonRequest = (req) => {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Response("Mutation requests must use application/json.", {
      status: 415,
    });
  }
};
