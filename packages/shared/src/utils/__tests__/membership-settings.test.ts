import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MEMBERSHIP_PURCHASE_URL,
  parseMembershipPaymentSettings,
  safeEtransferEmail,
  safePurchaseUrl,
} from '../membership-settings';

const REC = 'https://athleticsandrecreation.its.sfu.ca/Program/GetProgramDetails?courseId=b20a05ca-2754-4f11-ba1a-4a2ced47446c';

describe('safePurchaseUrl', () => {
  it('accepts an https link on any host', () => {
    expect(safePurchaseUrl(REC)).toBe(REC);
    expect(safePurchaseUrl(' https://go.sfss.ca/clubs/1 ')).toBe('https://go.sfss.ca/clubs/1');
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'http://go.sfss.ca/clubs/1', 'https://u:p@go.sfss.ca/', '', '   ', 'nope'])(
    'rejects %s',
    (raw) => {
      expect(safePurchaseUrl(raw)).toBeNull();
    },
  );
});

describe('safeEtransferEmail', () => {
  it('accepts a plain address, trimmed', () => {
    expect(safeEtransferEmail(' treasurer@sfubadminton.com ')).toBe('treasurer@sfubadminton.com');
  });

  it.each(['', '   ', 'treasurer', 'a b@c.com', 'a@b', '@b.com', `${'a'.repeat(250)}@b.com`])('rejects %s', (raw) => {
    expect(safeEtransferEmail(raw)).toBeNull();
  });
});

describe('parseMembershipPaymentSettings', () => {
  it('reads a valid pair', () => {
    expect(
      parseMembershipPaymentSettings({ sfss_purchase_url: REC, etransfer_email: 'treasurer@sfubadminton.com' }),
    ).toEqual({ sfssPurchaseUrl: REC, etransferEmail: 'treasurer@sfubadminton.com' });
  });

  it('reads an absent or malformed row as the defaults', () => {
    const defaults = { sfssPurchaseUrl: DEFAULT_MEMBERSHIP_PURCHASE_URL, etransferEmail: null };
    expect(parseMembershipPaymentSettings(null)).toEqual(defaults);
    expect(parseMembershipPaymentSettings([])).toEqual(defaults);
    expect(parseMembershipPaymentSettings({})).toEqual(defaults);
  });

  it('hides a stored value that fails its rule, and an explicit blank', () => {
    const none = { sfssPurchaseUrl: null, etransferEmail: null };
    expect(parseMembershipPaymentSettings({ sfss_purchase_url: 'javascript:x', etransfer_email: 3 })).toEqual(none);
    expect(parseMembershipPaymentSettings({ sfss_purchase_url: '', etransfer_email: '' })).toEqual(none);
  });

  it('seeds a default that passes its own rule', () => {
    expect(safePurchaseUrl(DEFAULT_MEMBERSHIP_PURCHASE_URL)).toBe(DEFAULT_MEMBERSHIP_PURCHASE_URL);
  });
});
