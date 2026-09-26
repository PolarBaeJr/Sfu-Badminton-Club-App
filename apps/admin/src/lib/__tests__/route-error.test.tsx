import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
// Straight at the modules rather than the '@badminton/ui' barrel, the same call
// select.test.tsx makes.
import {
  ROUTE_ERROR_FALLBACK,
  isGenericServerMessage,
  routeErrorMessage,
} from '@badminton/ui/src/route-error';
import { RouteError } from '@badminton/ui/src/components/RouteError';
import { ERROR_CODES } from '@badminton/shared/src/utils/error-codes';

const GENERIC =
  'An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.';

function withDigest(message: string, digest?: string): Error & { digest?: string } {
  const error = new Error(message) as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
}

describe('isGenericServerMessage', () => {
  it("matches Next's production server-render text", () => {
    expect(isGenericServerMessage(GENERIC)).toBe(true);
  });

  it('does not match an ordinary message or nothing', () => {
    expect(isGenericServerMessage('Failed to load fees')).toBe(false);
    expect(isGenericServerMessage('')).toBe(false);
    expect(isGenericServerMessage(undefined)).toBe(false);
  });
});

describe('routeErrorMessage', () => {
  it('shows the fallback when a digest is set, even with an ordinary message', () => {
    expect(routeErrorMessage(withDigest('column x does not exist', '2299239490'), 'Failed.')).toBe(
      'Failed.',
    );
  });

  it('shows the fallback for the generic text with no digest', () => {
    expect(routeErrorMessage(withDigest(GENERIC), 'Failed.')).toBe('Failed.');
  });

  it('passes a client-side message through', () => {
    expect(routeErrorMessage(withDigest('Network down'), 'Failed.')).toBe('Network down');
  });

  it('falls back on an empty message', () => {
    expect(routeErrorMessage(withDigest(''), 'Failed.')).toBe('Failed.');
  });

  it('uses the default fallback when none is given', () => {
    expect(routeErrorMessage(withDigest('', '1'))).toBe(ROUTE_ERROR_FALLBACK);
    expect(routeErrorMessage(withDigest(''), undefined)).toBe(ROUTE_ERROR_FALLBACK);
  });
});

describe('RouteError', () => {
  it('shows the error code and hides the generic text', () => {
    const html = renderToStaticMarkup(
      <RouteError title="Fees Error" error={withDigest(GENERIC, '2299239490')} reset={() => {}} />,
    );
    expect(html).toContain('Fees Error');
    expect(html).toContain('Error code');
    expect(html).toContain('2299239490');
    expect(html).toContain('Copy');
    expect(html).not.toContain('Server Components render');
  });

  it("names a numeric digest after the boundary's area and keeps the digest as the ref", () => {
    const html = renderToStaticMarkup(
      <RouteError area="FEE" title="Fees Error" error={withDigest(GENERIC, '931992559')} reset={() => {}} />,
    );
    expect(html).toContain('FEE-000');
    expect(html).toContain('931992559');
    expect(html).toContain(ERROR_CODES['FEE-000'].meaning);
  });

  it("shows a coded digest's own code and meaning, whatever the area", () => {
    const html = renderToStaticMarkup(
      <RouteError area="FEE" title="Fees Error" error={withDigest(GENERIC, 'DB-101.k3x9q2ab')} reset={() => {}} />,
    );
    expect(html).toContain('DB-101');
    expect(html).toContain('k3x9q2ab');
    expect(html).toContain(ERROR_CODES['DB-101'].title);
    expect(html).toContain(ERROR_CODES['DB-101'].meaning);
    expect(html).not.toContain('FEE-000');
  });

  it('shows no code line without a digest, and renders children', () => {
    const html = renderToStaticMarkup(
      <RouteError title="Event Error" error={withDigest('Network down')} reset={() => {}}>
        <button type="button">Go Back</button>
      </RouteError>,
    );
    expect(html).toContain('Network down');
    expect(html).not.toContain('Error code');
    expect(html).toContain('Go Back');
  });
});
