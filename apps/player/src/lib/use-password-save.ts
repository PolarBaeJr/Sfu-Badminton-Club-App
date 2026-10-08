'use client';

import { useCallback, useRef, useState } from 'react';
import {
  authErrorCode,
  friendlyAuthError,
  passwordProblem,
  withErrorCode,
} from '@badminton/shared';
import { passwordSaveMessage, sendReauthCode, setMemberPassword } from '@/lib/password-client';
import { passwordSaveOutcome } from '@/lib/password-save-flow';

// Saving a password, including the emailed confirmation code GoTrue can ask
// for. Shared by Settings, forgot password and signup, so none of them can
// dead-end on "needs a code" again.
//
// The pending password lives in a ref only: never in state that could be
// logged, never in storage, a URL or telemetry. It is handed to supabase-js
// and dropped on cancel.
export function usePasswordSave({ onSaved }: { onSaved: () => void | Promise<void> }) {
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [nonce, setNonce] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pwRef = useRef('');
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Runs after a successful save; the form returns to its first step.
  const finishSaved = useCallback(async () => {
    await onSavedRef.current();
    pwRef.current = '';
    setNonce('');
    setStep('password');
  }, []);

  const emailCode = useCallback(async (): Promise<boolean> => {
    const { error: sendError } = await sendReauthCode();
    if (sendError) {
      setError(withErrorCode(friendlyAuthError(sendError.message), authErrorCode(sendError)));
      return false;
    }
    return true;
  }, []);

  const submitPassword = useCallback(async (pw: string) => {
    const problem = passwordProblem(pw);
    if (problem) {
      setError(withErrorCode(problem, 'AUTH-212'));
      return;
    }
    pwRef.current = pw;
    setBusy(true);
    setError('');
    setNotice('');
    const res = await setMemberPassword(pw);
    const outcome = passwordSaveOutcome(res, { withNonce: false });
    if (outcome === 'saved') {
      await finishSaved();
    } else if (outcome === 'needs-code') {
      if (await emailCode()) {
        setNonce('');
        setStep('code');
      }
    } else if (!res.ok) {
      setError(passwordSaveMessage(res));
    }
    setBusy(false);
  }, [emailCode, finishSaved]);

  const submitCode = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    const res = await setMemberPassword(pwRef.current, nonce.trim());
    const outcome = passwordSaveOutcome(res, { withNonce: true });
    if (outcome === 'saved') {
      await finishSaved();
    } else if (!res.ok) {
      // A wrong code stays on the code screen so it can be retried.
      setError(passwordSaveMessage(res));
    }
    setBusy(false);
  }, [nonce, finishSaved]);

  const resendCode = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    if (await emailCode()) setNotice('A new code is on its way.');
    setBusy(false);
  }, [emailCode]);

  const cancel = useCallback(() => {
    pwRef.current = '';
    setNonce('');
    setError('');
    setNotice('');
    setStep('password');
  }, []);

  return { step, nonce, setNonce, busy, error, notice, submitPassword, submitCode, resendCode, cancel };
}
