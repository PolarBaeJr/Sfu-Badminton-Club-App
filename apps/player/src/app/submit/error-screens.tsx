import Link from 'next/link';

function Shell({ label, heading, body, cta }: { label: string; heading: string; body: React.ReactNode; cta: React.ReactNode }) {
  return (
    <div className="submit-shell">
      <div className="submit-card">
        <div className="submit-label submit-label-danger">{label}</div>
        <h1 className="submit-heading">{heading}</h1>
        <div className="submit-body">{body}</div>
        <div className="submit-cta">{cta}</div>
      </div>
    </div>
  );
}

export function WrongPlayerError({ loggedInName, sideA, sideB }: { loggedInName: string; sideA: string; sideB: string }) {
  return (
    <Shell
      label="WRONG ACCOUNT"
      heading="This match isn't yours"
      body={
        <>
          You&apos;re signed in as <strong>{loggedInName}</strong>, but this challenge is
          between <strong>{sideA}</strong> and <strong>{sideB}</strong>.
        </>
      }
      cta={
        <Link href="/" className="submit-btn submit-btn-ghost">Go to dashboard</Link>
      }
    />
  );
}

export function ExpiredError() {
  return (
    <Shell
      label="EXPIRED"
      heading="This QR code has expired"
      body={<>Ask an admin or the challenge creator to regenerate the QR code.</>}
      cta={<Link href="/challenges" className="submit-btn submit-btn-ghost">View challenges</Link>}
    />
  );
}

export function AlreadySubmittedError({ matchId, challengeId }: { matchId?: string; challengeId?: string }) {
  return (
    <Shell
      label="ALREADY SUBMITTED"
      heading="This result is already in"
      body={<>The match result has already been submitted. It may be awaiting confirmation.</>}
      cta={
        <Link href={challengeId ? `/challenges/${challengeId}` : '/challenges'} className="submit-btn submit-btn-ghost">
          View match {matchId ? 'result' : 'details'}
        </Link>
      }
    />
  );
}

export function InvalidTokenError() {
  return (
    <Shell
      label="INVALID LINK"
      heading="This QR code is invalid"
      body={<>The code may have been tampered with, or the link was copied incorrectly. Ask an admin to regenerate it.</>}
      cta={<Link href="/" className="submit-btn submit-btn-ghost">Go to dashboard</Link>}
    />
  );
}

export function WrongStatusError({ status }: { status?: string }) {
  const label = status ? status.replace(/_/g, ' ') : 'not ready';
  return (
    <Shell
      label="NOT READY"
      heading="This challenge can't be submitted yet"
      body={<>Current status: <strong>{label}</strong>. Only accepted challenges can be submitted through QR.</>}
      cta={<Link href="/challenges" className="submit-btn submit-btn-ghost">View challenges</Link>}
    />
  );
}
