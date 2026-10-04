/** Run `fn` over items with at most `limit` in flight, preserving order. Stops on first error. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed) throw failed;
  return results;
}

function isRetryable(err: unknown) {
  const status = (err as { status?: number }).status;
  if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) return true;
  const code = (err as { code?: string }).code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE" || /connection|network|socket|timeout/i.test(String((err as Error).message));
}

/** Retry transient API failures with exponential backoff (SDKs retry too; this covers longer outages). */
export async function retry<T>(fn: () => Promise<T>, signal?: AbortSignal, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted || i >= attempts - 1 || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = 0;
  let timer: NodeJS.Timeout | null = null;
  let pending: A | null = null;
  const call = (...args: A) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else {
      pending = args;
      timer ??= setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      }, ms - (now - last));
    }
  };
  return call;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 2.6);
