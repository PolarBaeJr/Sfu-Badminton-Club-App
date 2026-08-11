import { describe, it, expect } from 'vitest';
import { TOURNAMENT_EVENT_STATUS_LABELS } from '@badminton/shared';
import { hasResultsTab } from '../event-tabs';

// The event page reads platform_settings.tournament_bonuses for exactly one
// consumer — the Results tab — and used to read it on every load, including for
// events that have no Results tab to render it in.
//
// The fetch is conditional now, which means the page and EventControlCenter both
// have to answer the same question, so they ask it here. These are the answers
// the tab list gave before either of them moved: `completed`, and nothing else.
// If a later change gives Results a second status it has to come through this
// function, or the tab appears with no settings behind it and silently draws
// nothing.

// Every status the CHECK constraint allows (00001_schema.sql:659), taken from
// the shared label map rather than written out again — a sixth status added
// there will arrive here on its own and has to answer this question.
const ALL_STATUSES = Object.keys(TOURNAMENT_EVENT_STATUS_LABELS);

describe('hasResultsTab', () => {
  it('is true for a completed event and nothing else', () => {
    expect(ALL_STATUSES.filter(hasResultsTab)).toEqual(['completed']);
  });

  it('says no to a status it has never heard of', () => {
    // An allow-list, so a migration adding a sixth status does not open the tab
    // — and does not start a round trip to platform_settings — by default.
    expect(hasResultsTab('archived')).toBe(false);
    expect(hasResultsTab('')).toBe(false);
  });
});
