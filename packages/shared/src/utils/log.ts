/**
 * Canonical structured error logger for server actions, route handlers, and
 * shared utilities. Routes to console.error so logs land in platform
 * aggregators (Vercel Functions logs, Cloudflare Logs, etc.) where downstream
 * tooling can ingest them.
 *
 * Pass a stable `label` so log searches and alerts can pivot on it. The
 * optional `context` is merged into the JSON payload — keep keys flat and
 * snake_case for grep-ability.
 *
 * Replaces the old @sentry/nextjs setUser/captureException flow.
 */

type LogContext = Record<string, unknown>;

export function logError(label: string, err: unknown, context?: LogContext): void {
  const payload: Record<string, unknown> = { event: 'error', label };
  if (context) Object.assign(payload, context);

  if (err instanceof Error) {
    payload.message = err.message;
    payload.stack = err.stack;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') payload.code = code;
  } else if (typeof err === 'string') {
    payload.message = err;
  } else {
    payload.message = String(err);
  }

  // Single-line JSON keeps log ingesters happy.
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(payload));
}
