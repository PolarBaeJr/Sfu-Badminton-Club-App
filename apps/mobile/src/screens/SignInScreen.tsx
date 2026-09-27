import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, Card } from '../components/ui';
import { usePalette } from '../components/theme';
import { useAuth } from '../lib/auth/auth-context';
import { sendEmailCode, verifyEmailCode } from '../lib/auth/email-code';

/**
 * Email then code. Sign-in only: accounts are created on the website, where
 * the waivers are signed, so an unknown address is told so rather than
 * enrolled. Passkeys and Google are not here yet (see docs/05-development.md).
 */
export function SignInScreen() {
  const { supabase, signInNotice: notice, setSignInNotice: setNotice } = useAuth();
  const p = usePalette();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function send(): Promise<boolean> {
    const result = await sendEmailCode(supabase, email.trim());
    if (result.ok) return true;
    if (result.unknownAccount) setNotice('unknown');
    else setError(result.message);
    return false;
  }

  async function handleSend() {
    setBusy(true);
    setError('');
    setNotice(null);
    setInfo('');
    if (await send()) {
      setCode('');
      setSent(true);
    }
    setBusy(false);
  }

  async function handleResend() {
    setBusy(true);
    setError('');
    setInfo('');
    if (await send()) setInfo('A new code is on its way.');
    setBusy(false);
  }

  async function handleVerify() {
    setBusy(true);
    setError('');
    const result = await verifyEmailCode(supabase, email.trim(), code.trim());
    if (!result.ok) {
      if (result.unfinished) {
        // Usually lands on a freshly mounted screen (see signInNotice).
        setSent(false);
        setCode('');
        setNotice('unfinished');
      } else {
        setError(result.message);
      }
    }
    // On success the auth listener swaps this screen out; nothing to do here.
    setBusy(false);
  }

  const inputStyle = [styles.input, { color: p.text, borderColor: p.line, backgroundColor: p.surface }];

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: p.background }]}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.content}>
          <Text style={[styles.title, { color: p.text }]}>SFU Badminton</Text>
          <Card>
            {!sent ? (
              <>
                <Body muted>Sign in with the email on your club account. We will send you a 6-digit code.</Body>
                <TextInput
                  style={inputStyle}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Email"
                  placeholderTextColor={p.muted}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  editable={!busy}
                />
                <Button title={busy ? 'Sending...' : 'Send code'} onPress={handleSend} disabled={busy || !email.trim()} />
              </>
            ) : (
              <>
                <Body muted>Enter the code we sent to {email.trim()}.</Body>
                <TextInput
                  style={inputStyle}
                  value={code}
                  onChangeText={setCode}
                  placeholder="6-digit code"
                  placeholderTextColor={p.muted}
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  maxLength={10}
                  editable={!busy}
                />
                <Button title={busy ? 'Checking...' : 'Sign in'} onPress={handleVerify} disabled={busy || !code.trim()} />
                <Button title="Resend code" onPress={handleResend} disabled={busy} variant="ghost" />
                <Button
                  title="Change email"
                  onPress={() => {
                    setSent(false);
                    setCode('');
                    setError('');
                    setInfo('');
                  }}
                  disabled={busy}
                  variant="ghost"
                />
              </>
            )}
            {info ? <Text style={[styles.message, { color: p.muted }]}>{info}</Text> : null}
            {error ? <Text style={[styles.message, { color: p.danger }]}>{error}</Text> : null}
            {notice ? (
              <Text style={[styles.message, { color: p.danger }]}>
                {notice === 'unknown'
                  ? 'No account uses that email. Create an account on the club website first.'
                  : 'That email has not finished signing up yet. Complete sign-up on the club website, then sign in here.'}
              </Text>
            ) : null}
          </Card>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', padding: 20 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 20 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, marginTop: 12 },
  message: { marginTop: 12, fontSize: 14, lineHeight: 20 },
});
