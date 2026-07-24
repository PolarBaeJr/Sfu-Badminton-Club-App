export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const NEXT_CONTROL_FLOW = /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/;

export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const digest = (err as { digest?: string } | null)?.digest;
    if (typeof digest === 'string' && NEXT_CONTROL_FLOW.test(digest)) throw err;
    return { ok: false, error: err instanceof Error ? err.message : 'Something went wrong' };
  }
}
