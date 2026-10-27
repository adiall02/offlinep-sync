/** Error for any non-2xx answer. Network failures are NOT HttpErrors (they are TypeErrors / aborts). */
export class HttpError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Thin fetch wrapper used by every request in the app, so connectivity rules live in ONE place:
 *  - `isOnline()` false → fail immediately like a dead network (this is how the demo's
 *    "Simulate offline" switch works, and it behaves exactly like airplane mode);
 *  - every request gets the bearer token and a hard timeout, so a half-open connection can
 *    never hang the sync loop.
 */
export function createHttp({ getToken, isOnline = () => true, fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 20_000 }) {
  return async function request(method, url, { body, headers = {} } = {}) {
    if (!isOnline()) throw new TypeError('offline');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const token = getToken();
      const res = await fetchImpl(url, {
        method,
        signal: ctrl.signal,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : undefined;
      if (!res.ok) throw new HttpError(res.status, parsed);
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  };
}
