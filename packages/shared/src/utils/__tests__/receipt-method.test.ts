import { describe, it, expect } from 'vitest';
import { classifyReceiptText, isReceiptMethod } from '../receipt-method';
import { formatPaymentMethod } from '../payment-methods';

// EVERY FIXTURE BELOW IS SYNTHETIC. None is text read off a real bank's
// e-Transfer screen or a real SFU Rec receipt: both layouts are unverified, and
// the names and numbers here are made up. They pin the behaviour the classifier
// promises, not anybody's format.

describe('classifyReceiptText (synthetic fixtures)', () => {
  it('reads an Interac confirmation as an e-transfer, club name and all', () => {
    const text = [
      'Interac e-Transfer sent',
      'To: SFU Badminton Club',
      'Amount $40.00',
      'Reference number: CA7Hd2k9QmP4',
    ].join('\n');
    expect(classifyReceiptText(text)).toBe('e_transfer');
  });

  it('reads an autodeposit notice as an e-transfer', () => {
    expect(classifyReceiptText('Your money was sent. Autodeposit is on for this recipient.')).toBe('e_transfer');
  });

  it('reads a Fusion-style receipt as SFU Rec', () => {
    const text = [
      'Athletics and Recreation',
      'Receipt #: 20260924118',
      'Badminton Club Membership $40.00',
      'Visa ****1234',
      'Powered By Fusion',
    ].join('\n');
    expect(classifyReceiptText(text)).toBe('sfu_rec');
  });

  it('reads two card words and no e-transfer word as SFU Rec', () => {
    expect(classifyReceiptText('Order #88412093\nPaid with Mastercard\nTotal $40.00')).toBe('sfu_rec');
  });

  it('does not decide on a single card word', () => {
    expect(classifyReceiptText('Visa\nTotal $40.00')).toBeNull();
  });

  it('does not decide when both kinds of word are there', () => {
    expect(classifyReceiptText('Interac e-Transfer\nAthletics and Recreation')).toBeNull();
  });

  it('does not take the club name for SFU Rec', () => {
    expect(classifyReceiptText('SFU')).toBeNull();
    expect(classifyReceiptText('SFU Badminton Club\nTotal $40.00')).toBeNull();
  });

  it('answers null for nothing and noise, and never throws', () => {
    expect(classifyReceiptText('')).toBeNull();
    expect(classifyReceiptText('   ')).toBeNull();
    expect(classifyReceiptText(null)).toBeNull();
    expect(classifyReceiptText(undefined)).toBeNull();
    expect(classifyReceiptText('~~ 1l|I ##')).toBeNull();
  });
});

describe('receipt methods', () => {
  it('knows the two a receipt can carry and nothing else', () => {
    expect(isReceiptMethod('e_transfer')).toBe(true);
    expect(isReceiptMethod('sfu_rec')).toBe(true);
    expect(isReceiptMethod('cash')).toBe(false);
    expect(isReceiptMethod(null)).toBe(false);
  });

  it('labels an SFU Rec purchase', () => {
    expect(formatPaymentMethod('sfu_rec')).toBe('SFU Rec website');
  });
});
