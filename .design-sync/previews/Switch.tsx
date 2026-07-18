import React from 'react';
import { Switch } from '@badminton/ui';

function Panel({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>;
}

export function NotificationSettings() {
  const [matchAlerts, setMatchAlerts] = React.useState(true);
  const [feeReminders, setFeeReminders] = React.useState(false);
  return (
    <Panel>
      <Switch
        checked={matchAlerts}
        onChange={setMatchAlerts}
        label="Match result alerts"
        description="Email me when an opponent reports a score against me"
      />
      <Switch
        checked={feeReminders}
        onChange={setFeeReminders}
        label="Fee reminders"
        description="Nudge me before comp fees are due each season"
      />
    </Panel>
  );
}

export function LadderVisibility() {
  const [visible, setVisible] = React.useState(true);
  return (
    <Panel>
      <Switch
        checked={visible}
        onChange={setVisible}
        label="Show my ELO on the public ladder"
      />
    </Panel>
  );
}

export function DisabledStates() {
  return (
    <Panel>
      <Switch
        checked
        onChange={() => {}}
        disabled
        label="Season auto-enrollment"
        description="Locked by club admins for Spring 2026"
      />
      <Switch
        checked={false}
        onChange={() => {}}
        disabled
        label="Guest check-ins"
        description="Disabled while the waiver form is being updated"
      />
    </Panel>
  );
}
