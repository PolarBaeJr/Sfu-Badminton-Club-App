import { describe, it, expect } from 'vitest';
import { ERROR_CODES, renderErrorCatalogue } from '../error-codes';

// packages/shared/ERROR-CODES.md is this output. When the registry changes the
// snapshot fails; regenerate with `npm test -w @badminton/shared -- -u` and
// commit the file alongside the change.
describe('ERROR-CODES.md', () => {
  const md = renderErrorCatalogue();

  it('lists every code', () => {
    for (const code of Object.keys(ERROR_CODES)) expect(md).toContain(`\`${code}\``);
  });

  it('writes no em dash', () => {
    expect(md).not.toContain('\u2014');
  });

  it('matches the committed catalogue', async () => {
    await expect(md).toMatchFileSnapshot('../../../ERROR-CODES.md');
  });
});
