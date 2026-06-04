export const defaultApiBase = (
  process.env.NEXT_PUBLIC_QUASAR_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
  ""
).replace(/\/+$/, "");

export function normalizeApiBase(value: string) {
  return value.replace(/\/+$/, "");
}

export function createDashboardClient(apiBase: string, token: string) {
  const endpoint = (path: string) => `${apiBase}${path}`;
  const authHeaders = () => ({
    ...(token.trim().length > 0 ? { authorization: `Bearer ${token.trim()}` } : {}),
  });

  const fetchJson = async <Result>(path: string, init: RequestInit = {}) => {
    const response = await fetch(endpoint(path), {
      ...init,
      headers: {
        ...authHeaders(),
        ...(init.headers ?? {}),
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Request failed: ${path}`);
    return body as Result;
  };

  return { endpoint, authHeaders, fetchJson };
}
