'use client';

// WHAT ENTERING A DOUBLES EVENT ON YOUR OWN ACTUALLY MEANS, said before the
// member taps Enter and not after.
//
// "i need it to be allowed to join" — the club owner. Since 00102 a doubles
// event is a pool: some entrants arrive already paired, some arrive alone and
// an exec pairs them later. The member-facing half of that is a real
// commitment — you are agreeing to play with somebody you have not met and did
// not choose — and discovering it when a partner appears is not consent.
//
// SO IT IS A TICK BOX AND NOT A PARAGRAPH ELSEWHERE ON THE PAGE. A sentence in
// the page body is something a member can enter without ever having read;
// registerForEvent refuses without `soloEntryAcknowledged`, and this is the only
// thing in the app that sets it. The gate and the words are the same act.
//
// Sits alongside EventWaiverConsent in the same dialog when a tournament has a
// waiver too. They are two different things being agreed to — one is the club's
// legal text, one is how the draw will be built — so they are two boxes and
// each has to be ticked on its own.
//
// It deliberately does NOT offer to name a partner. Entering as a self-chosen
// pair is still admin-managed, because one member cannot enter another without
// that person's own consent, and an invite-and-accept flow is a separate
// feature rather than a checkbox on this one.

export function SoloEntryConsent({
  accepted,
  onAcceptedChange,
}: {
  accepted: boolean;
  onAcceptedChange: (value: boolean) => void;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: 14,
        display: 'grid',
        gap: 10,
      }}
    >
      <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
        This is a doubles event and you are entering <strong>on your own</strong>. The exec will
        pair you with another member who has also entered alone — you will not choose your
        partner, and you will not know who it is until they do.
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0, color: 'var(--mute)' }}>
        You can withdraw yourself any time before you are paired. Once you have a partner,
        leaving affects them too, so a tournament admin has to do it.
      </p>
      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          fontSize: 13,
          lineHeight: 1.5,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => onAcceptedChange(e.target.checked)}
          style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
        />
        <span>I understand I will be paired with another member.</span>
      </label>
    </div>
  );
}
