import { z } from 'zod';
import { ExpectedError } from '../utils/expected-error';

// Validate untrusted input at a server-action trust boundary. Throws an
// ExpectedError built from the first issue, including its field path: a schema
// rejection means the user typed something invalid, which is the validator
// working, not a fault worth paging anyone about.
export function parseOrThrow<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown
): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (!issue) throw new ExpectedError('Invalid input');
    const prefix = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new ExpectedError(`${prefix}${issue.message}`);
  }
  return result.data;
}
