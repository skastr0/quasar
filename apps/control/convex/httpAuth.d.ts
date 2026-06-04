export function isLoopbackRequest(req: Request): boolean;
export function ensureAuthorized(
  req: Request,
  env?: Record<string, string | undefined>,
): void;
export function ensureStrictTokenAuthorized(
  req: Request,
  env?: Record<string, string | undefined>,
): void;
export function ensureJsonRequest(req: Request): void;
