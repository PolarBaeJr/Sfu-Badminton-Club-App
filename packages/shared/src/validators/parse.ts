import { z } from 'zod';

// Validate untrusted input at a server-action trust boundary. Throws a plain
// Error (matching the actions' existing throw-style handling) built from the
// first issue, including its field path.
export function parseOrThrow<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown
): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (!issue) throw new Error('Invalid input');
    const prefix = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new Error(`${prefix}${issue.message}`);
  }
  return result.data;
}
