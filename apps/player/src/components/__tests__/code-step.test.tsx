import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeStep } from '../auth/code-step';

const base = {
  email: 'member@example.invalid',
  code: '',
  onCodeChange: () => undefined,
  onSubmit: () => undefined,
  onResend: () => undefined,
  onChangeEmail: () => undefined,
  loading: false,
  resending: false,
  error: '',
  submitLabel: 'Continue',
  sentNotice: null,
};

describe('CodeStep', () => {
  it('defaults to the sign-in wording', () => {
    const html = renderToStaticMarkup(<CodeStep {...base} />);
    expect(html).toContain('Enter your code');
    expect(html).toContain('Sign-in code');
    expect(html).toContain('Use a different email');
    expect(html).toContain('member@example.invalid');
  });

  it('takes the password confirmation wording', () => {
    const html = renderToStaticMarkup(
      <CodeStep
        {...base}
        title="Confirm it is you"
        lead={<>We emailed a code to confirm your new password.</>}
        codeLabel="Confirmation code"
        altLabel="Choose a different password"
      />,
    );
    expect(html).toContain('Confirm it is you');
    expect(html).toContain('Confirmation code');
    expect(html).toContain('Choose a different password');
    expect(html).toContain('confirm your new password');
    expect(html).not.toContain('Enter your code');
    expect(html).not.toContain('Use a different email');
  });
});
