import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingTile } from '@/components/setting-tile';

// Toggles batch until the reason is written and Save pressed, so the ON/OFF a
// tile prints has to follow the value it is handed (the edited one), and the
// warning has to stay outside the disclosure where nobody has to open it.
describe('SettingTile', () => {
  const base = { label: 'Sessions', summary: 'Schedule, RSVPs and check-in', control: <button type="button" /> };

  it('prints the state it is given', () => {
    expect(renderToStaticMarkup(<SettingTile {...base} on />)).toContain('>ON<');
    expect(renderToStaticMarkup(<SettingTile {...base} on={false} />)).toContain('>OFF<');
  });

  it('shows the summary, and the Modified marker only when edited', () => {
    expect(renderToStaticMarkup(<SettingTile {...base} on />)).toContain('Schedule, RSVPs and check-in');
    expect(renderToStaticMarkup(<SettingTile {...base} on />)).not.toContain('Modified');
    expect(renderToStaticMarkup(<SettingTile {...base} on={false} modified />)).toContain('Modified');
  });

  it('keeps the warning outside the disclosure and the detail inside it', () => {
    const html = renderToStaticMarkup(
      <SettingTile {...base} on warning="WARNING: memberships lapse." detail="Off stops the reminders." />,
    );
    const details = html.slice(html.indexOf('<details'));
    expect(html.indexOf('WARNING: memberships lapse.')).toBeLessThan(html.indexOf('<details'));
    expect(details).toContain('Off stops the reminders.');
    expect(details).not.toContain('WARNING');
  });
});
