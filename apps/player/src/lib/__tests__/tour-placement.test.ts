import { describe, it, expect } from 'vitest';
import { clampRectToViewport, placePopover } from '@badminton/ui/src/tour';

// WHERE THE TOUR CARD GOES. Pure arithmetic; nothing here proves a real
// browser measures the same rectangles.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const CARD = { width: 340, height: 200 };
const NO_BARS = { top: 0, bottom: 0 };
// The tab bar, with a safe-area inset under it.
const TAB_BAR = { top: 0, bottom: 84 };

describe('placePopover', () => {
  it('goes below a target near the top', () => {
    const p = placePopover({ top: 100, left: 500, width: 200, height: 40 }, CARD, DESKTOP, NO_BARS);
    expect(p.side).toBe('below');
    expect(p.top).toBe(100 + 40 + 12);
    expect(p.left).toBe(500 + 100 - 170);
  });

  it('goes above a target with no room below', () => {
    const p = placePopover({ top: 600, left: 500, width: 200, height: 100 }, CARD, DESKTOP, NO_BARS);
    expect(p.side).toBe('above');
    expect(p.top).toBe(600 - 12 - 200);
  });

  it('goes above a target in the tab bar band, and stays clear of the bar', () => {
    const tab = { top: 770, left: 150, width: 78, height: 60 };
    const p = placePopover(tab, CARD, PHONE, TAB_BAR);
    expect(p.side).toBe('above');
    expect(p.top + CARD.height).toBeLessThanOrEqual(PHONE.height - TAB_BAR.bottom);
  });

  it('keeps a below-card out of the tab bar band', () => {
    // Room below in the raw viewport, none once the bar is reserved.
    const p = placePopover({ top: 500, left: 20, width: 350, height: 40 }, CARD, PHONE, TAB_BAR);
    expect(p.top + CARD.height).toBeLessThanOrEqual(PHONE.height - TAB_BAR.bottom - 12);
  });

  it('clamps to the screen edge on a 390px phone', () => {
    const left = placePopover({ top: 100, left: 0, width: 40, height: 40 }, CARD, PHONE, NO_BARS);
    expect(left.left).toBe(12);
    const right = placePopover({ top: 100, left: 360, width: 30, height: 40 }, CARD, PHONE, NO_BARS);
    expect(right.left).toBe(390 - 12 - 340);
  });

  it('centres with no target', () => {
    const p = placePopover(null, CARD, DESKTOP, NO_BARS);
    expect(p.side).toBe('center');
    expect(p.left).toBe((1280 - 340) / 2);
    expect(p.top).toBe((800 - 200) / 2);
  });

  it('centres in the space above the tab bar', () => {
    const p = placePopover(null, CARD, PHONE, TAB_BAR);
    expect(p.top).toBe((PHONE.height - TAB_BAR.bottom - CARD.height) / 2);
  });

  it('takes the roomier side and clamps when neither fits', () => {
    const tall = { width: 340, height: 500 };
    const p = placePopover({ top: 300, left: 20, width: 350, height: 200 }, tall, PHONE, NO_BARS);
    expect(p.top).toBeGreaterThanOrEqual(12);
    expect(p.top + tall.height).toBeLessThanOrEqual(PHONE.height - 12);
  });

  it('places the wider desktop card on a 1280px screen', () => {
    const wide = { width: 460, height: 240 };
    const p = placePopover({ top: 120, left: 1100, width: 150, height: 40 }, wide, DESKTOP, NO_BARS);
    expect(p.side).toBe('below');
    expect(p.left).toBe(1280 - 12 - 460);
    expect(p.left + wide.width).toBeLessThanOrEqual(1280 - 12);
  });
});

describe('clampRectToViewport', () => {
  it('cuts a tall table on a phone to what is above the tab bar', () => {
    const table = { top: 200, left: 12, width: 366, height: 2000 };
    expect(clampRectToViewport(table, PHONE, TAB_BAR)).toEqual({ top: 200, left: 12, width: 366, height: PHONE.height - TAB_BAR.bottom - 200 });
  });

  it('cuts a tall table on a desktop to the screen', () => {
    const table = { top: -300, left: 40, width: 800, height: 3000 };
    expect(clampRectToViewport(table, DESKTOP, NO_BARS)).toEqual({ top: 0, left: 40, width: 800, height: 800 });
  });

  it('leaves a target that fits alone', () => {
    const r = { top: 100, left: 20, width: 200, height: 40 };
    expect(clampRectToViewport(r, DESKTOP, NO_BARS)).toEqual(r);
  });

  it('keeps the tab bar itself, which sits inside the bottom band', () => {
    const bar = { top: PHONE.height - TAB_BAR.bottom, left: 0, width: 390, height: TAB_BAR.bottom };
    expect(clampRectToViewport(bar, PHONE, TAB_BAR)).toEqual(bar);
  });

  it('is null for a target entirely off screen', () => {
    expect(clampRectToViewport({ top: 900, left: 0, width: 100, height: 50 }, DESKTOP, NO_BARS)).toBeNull();
    expect(clampRectToViewport({ top: -200, left: 0, width: 100, height: 50 }, DESKTOP, NO_BARS)).toBeNull();
  });
});
