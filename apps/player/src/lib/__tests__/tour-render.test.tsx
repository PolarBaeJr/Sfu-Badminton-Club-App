import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tour } from '@badminton/ui/src/components/Tour';
import type { TourStep } from '@badminton/ui/src/tour';

/**
 * The tour's static shell, through a real render. renderToStaticMarkup and not
 * a DOM, the same posture as announcement-markdown.test.tsx: no effect runs,
 * so no target is resolved and the card is still hidden. What this pins is the
 * dialog semantics a screen reader relies on, not where anything lands.
 */

const STEPS: TourStep[] = [
  { id: 'one', title: 'First title', body: 'First body', targets: [], missingTarget: 'center' },
  { id: 'two', title: 'Second title', body: 'Second body', targets: ['#nowhere'], missingTarget: 'skip' },
];

const LABELS = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  skip: 'Skip tour',
  progress: (step: number, total: number) => `Step ${step} of ${total}`,
};

const draw = (open: boolean) =>
  renderToStaticMarkup(<Tour open={open} steps={STEPS} onFinish={() => {}} labels={LABELS} />);

describe('Tour', () => {
  it('renders nothing when closed', () => {
    expect(draw(false)).toBe('');
  });

  it('is a modal dialog labelled by its heading and described by its body', () => {
    const html = draw(true);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');

    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(html).toMatch(new RegExp(`<h2[^>]*id="${escapeRegExp(labelledBy!)}"[^>]*>First title</h2>`));
    expect(html).toMatch(new RegExp(`<p[^>]*id="${escapeRegExp(describedBy!)}"[^>]*>First body</p>`));
    // Not Dialog's hardcoded id: two dialogs on one page would share it.
    expect(labelledBy).not.toBe('dialog-title');
  });

  it('announces the step through a polite live region', () => {
    expect(draw(true)).toMatch(/<div aria-live="polite"[^>]*>Step 1 of 2<\/div>/);
  });

  it('offers Skip and Next on the first step, and no Back', () => {
    const html = draw(true);
    expect(html).toContain('>Skip tour</button>');
    expect(html).toContain('>Next</button>');
    expect(html).not.toContain('>Back</button>');
  });

  it('carries every word from its props', () => {
    const html = renderToStaticMarkup(
      <Tour
        open
        steps={[STEPS[0]!]}
        onFinish={() => {}}
        labels={{ ...LABELS, done: 'Finish', skip: 'Leave', progress: () => 'one/one' }}
      />,
    );
    expect(html).toContain('>Finish</button>');
    expect(html).toContain('>Leave</button>');
    expect(html).toContain('one/one');
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
