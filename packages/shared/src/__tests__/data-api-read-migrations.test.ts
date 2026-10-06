import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_API_SCOPES } from '../utils/data-api-key';

// 00264 TO 00267, 00270 AND 00277, READ OFF DISK. The data API's read surface is a set
// of SECURITY DEFINER functions, which run as their owner and so bypass every
// grant and policy the reader role would otherwise meet. What they return is
// therefore the whole privacy boundary, and these properties pin it: a later
// edit that widens a grant, reads around the one match gate or selects a
// free-text column fails here before it reaches a database.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

function migration(prefix: string): string {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith(prefix));
  if (!name) throw new Error(`no migration starting ${prefix}`);
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

const scopes = migration('00264_');
const history = migration('00265_');
const schedule = migration('00266_');
const header = migration('00267_');
const external = migration('00270_');
const staged = migration('00277_');
const both = `${history}\n${schedule}\n${header}\n${external}\n${staged}`;

/**
 * The body of one CREATE FUNCTION, from its header to the closing tag. The
 * LAST definition, since that is the one a database ends up with.
 */
function functionBody(name: string): string {
  const start = both.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const end = both.indexOf('$function$;', start);
  return both.slice(start, end);
}

/** SQL with comments, COMMENT ON statements and the verify blocks removed. */
function code(sql: string): string {
  return sql
    .replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, '')
    .replace(/DO \$verify\$[\s\S]*?\$verify\$;/g, '')
    .replace(/--[^\n]*/g, '');
}

const PUBLIC_FUNCTIONS: Record<string, string> = {
  data_api_active_season: 'uuid',
  data_api_matches:
    'uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean, text, timestamptz, int, int',
  data_api_match_by_ref: 'uuid, text',
  data_api_player_published: 'uuid, text',
  data_api_head_to_head: 'uuid, text, text, text, uuid',
  data_api_player_seasons: 'uuid, text',
  data_api_rating_history: 'uuid, text, text, uuid, timestamptz, timestamptz, int, int',
  data_api_seasons: 'uuid, uuid',
  data_api_season_standings: 'uuid, uuid',
  data_api_season_header: 'uuid, uuid',
  data_api_tournaments: 'uuid, uuid, uuid',
  data_api_tournament_events: 'uuid, uuid',
  data_api_tournament_entrants: 'uuid, uuid',
  data_api_tournament_draw: 'uuid, uuid',
  data_api_tournament_events_v2: 'uuid, uuid',
  data_api_tournament_entrants_v2: 'uuid, uuid',
  data_api_tournament_draw_v2: 'uuid, uuid',
  data_api_sessions: 'uuid, timestamptz, timestamptz',
  data_api_club_events: 'uuid, timestamptz, timestamptz',
};

const INTERNAL_FUNCTIONS: Record<string, string> = {
  data_api_published_player: 'uuid',
  data_api_visible_season: 'uuid',
  data_api_match_ref: 'uuid, text, uuid',
  data_api_resolve_ref: 'uuid, text',
  data_api_tournament_match_players: 'uuid',
  data_api_tournament_match_publishable: 'uuid',
  data_api_match_rows: '',
  data_api_sides: 'uuid, jsonb, boolean',
  data_api_external_ref: 'uuid, uuid',
  data_api_draw_side: 'uuid, uuid, text',
};

describe('00264: the scope vocabulary', () => {
  it('admits exactly DATA_API_SCOPES, in order', () => {
    const check = /ADD CONSTRAINT data_api_keys_scope_vocabulary\s+CHECK \(scopes <@ ARRAY\[([^\]]+)\]/.exec(scopes);
    expect(check).not.toBeNull();
    const admitted = [...check![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(admitted).toEqual([...DATA_API_SCOPES]);
  });

  it('leaves the not-empty constraint alone', () => {
    expect(code(scopes)).not.toContain('data_api_keys_scope_not_empty');
  });
});

describe('00265 to 00277: every data API read function', () => {
  const all = { ...PUBLIC_FUNCTIONS, ...INTERNAL_FUNCTIONS };

  for (const [name, args] of Object.entries(all)) {
    it(`${name} is SECURITY DEFINER with a pinned search_path`, () => {
      const body = functionBody(name);
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    });

    it(`${name} is revoked from PUBLIC, anon and authenticated`, () => {
      expect(both).toContain(`REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated;`);
    });
  }

  for (const [name, args] of Object.entries(PUBLIC_FUNCTIONS)) {
    it(`${name} is granted to data_api_reader and nobody else`, () => {
      // 00270 recreates three of them and grants again, so a function may be
      // granted more than once, but always the same thing to the same role.
      const grants = [...both.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO (\\w+);`, 'g'))];
      expect(grants.length).toBeGreaterThan(0);
      expect([...new Set(grants.map((g) => `${g[1]} TO ${g[2]}`))]).toEqual([`${args} TO data_api_reader`]);
    });

    it(`${name} takes the consumer id first`, () => {
      expect(functionBody(name)).toMatch(new RegExp(`FUNCTION public\\.${name}\\(\\s*p_consumer_id uuid`));
    });
  }

  for (const name of Object.keys(INTERNAL_FUNCTIONS)) {
    it(`${name} is granted to nobody`, () => {
      expect(code(both)).not.toMatch(new RegExp(`GRANT[^;]*public\\.${name}\\(`));
    });
  }

  it('grants nothing on any table or view', () => {
    expect(code(both)).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
  });

  it('uses the built-in sha256, never pgcrypto', () => {
    expect(code(both)).not.toMatch(/\bdigest\s*\(|pgcrypto|extensions\./i);
  });
});

describe('the one gate', () => {
  const MATCH_READERS = [
    'data_api_matches',
    'data_api_match_by_ref',
    'data_api_head_to_head',
    'data_api_player_seasons',
    'data_api_rating_history',
    'data_api_seasons',
    'data_api_season_standings',
  ];

  for (const name of MATCH_READERS) {
    it(`${name} reads matches only through data_api_match_rows()`, () => {
      const body = code(functionBody(name));
      expect(body).toContain('data_api_match_rows()');
      expect(body).not.toMatch(/\bFROM\s+(public\.)?(matches|match_participants|tournament_matches)\b/i);
      expect(body).not.toMatch(/\bJOIN\s+(public\.)?(matches|match_participants|tournament_matches)\b/i);
    });
  }

  it('the gate keeps a club match only when every participant is published', () => {
    const body = code(functionBody('data_api_match_rows'));
    expect(body).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM match_participants[\s\S]*?NOT data_api_published_player/);
    expect(body).toContain('data_api_tournament_match_publishable(tm.id)');
    expect(body.match(/data_api_visible_season\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  for (const name of ['data_api_tournament_draw', 'data_api_tournament_draw_v2']) {
    it(`${name} withholds a slot the gate would drop`, () => {
      const body = code(functionBody(name));
      expect(body).toContain('data_api_tournament_match_publishable');
      expect(body).toMatch(/withheld/);
    });
  }

  it('the history test is the two privacy controls and the approval check', () => {
    const body = code(functionBody('data_api_published_player'));
    expect(body).toContain('p.hide_from_leaderboard = FALSE');
    expect(body).toContain('p.deletion_requested_at IS NULL');
    expect(body).toContain("p.status <> 'pending_approval'");
  });

  it('the standings keep 00241\'s roster test', () => {
    const body = code(functionBody('data_api_season_standings'));
    for (const clause of [
      'p.active_flag = TRUE',
      "p.status NOT IN ('pending_approval', 'suspended')",
      'p.hide_from_leaderboard = FALSE',
      'p.deletion_requested_at IS NULL',
    ]) {
      expect(body).toContain(clause);
    }
  });
});

describe('00270: external teams', () => {
  it('every function 00270 drops is recreated and revoked in the same file', () => {
    const dropped = [...external.matchAll(/DROP FUNCTION IF EXISTS public\.(\w+)\(([^)]*)\);/g)];
    expect(dropped.length).toBeGreaterThan(0);
    for (const [, name, args] of dropped) {
      expect(external).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
      expect(external).toContain(`REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon, authenticated;`);
    }
  });

  it('an external ref is tagged apart from player and match refs', () => {
    const body = code(functionBody('data_api_external_ref'));
    expect(body).toContain("':x:'");
    expect(body).toContain('sha256(');
  });

  for (const name of ['data_api_tournament_draw', 'data_api_tournament_draw_v2']) {
    it(`${name} still withholds by the match gate outside an external event`, () => {
      const body = code(functionBody(name));
      expect(body).toMatch(/NOT te\.external_event AND NOT data_api_tournament_match_publishable\(tm\.id\)/);
      expect(body).toContain("tm.status = 'disputed'");
    });
  }

  it('the match gate is not touched, so external matches stay out of history', () => {
    expect(code(external)).not.toContain('FUNCTION public.data_api_match_rows(');
    expect(code(external)).not.toContain('FUNCTION public.data_api_tournament_match_publishable(');
  });
});

describe('00277: staged draws', () => {
  it('never reads format_config whole, only a path into it', () => {
    const uses = [...code(staged).matchAll(/format_config/g)];
    expect(uses.length).toBeGreaterThan(0);
    expect(code(staged)).not.toMatch(/format_config(?!\s*(->|#>))/);
  });

  it('never names a stage\'s courts or a court id', () => {
    expect(code(staged)).not.toContain("'courts'");
    expect(code(staged)).not.toMatch(/court_id/i);
  });

  it('withholds the head starts of a withheld slot', () => {
    const body = code(functionBody('data_api_tournament_draw_v2'));
    expect(body).toContain('CASE WHEN x.withheld THEN NULL ELSE tm.handicap_a::int END');
    expect(body).toContain('CASE WHEN x.withheld THEN NULL ELSE tm.handicap_b::int END');
  });

  it('changes nothing in the match gate but the bracket keys', () => {
    const before = code(history.slice(history.indexOf('CREATE OR REPLACE FUNCTION public.data_api_match_rows(')))
      .split('$function$;')[0];
    const after = code(functionBody('data_api_match_rows'));
    const added = "'is_third_place', tm.is_third_place,\n      'stage', tm.stage,\n      'match_label', tm.match_label,\n      'handicap_a', tm.handicap_a,\n      'handicap_b', tm.handicap_b\n";
    expect(after).toBe(before!.replace("'is_third_place', tm.is_third_place\n", added));
  });
});

describe('no identity, no free text', () => {
  // Columns that name a member, or that hold text a person wrote. None may be
  // selected by any function in these files. Comments that name them as NOT
  // served are stripped before the scan.
  const FORBIDDEN = [
    'full_name',
    'first_name',
    'last_name',
    'display_name',
    'email',
    'phone',
    'discord_id',
    'discord_username',
    'avatar_url',
    'student_number',
    'member_code',
    'notes',
    'walkover_reason',
    'suspension_reason',
    'cancelled_reason',
    'pair_name',
    'court',
    'description',
    'waiver_text',
    'external1_name',
    'external2_name',
  ];

  for (const column of FORBIDDEN) {
    it(`never reads ${column}`, () => {
      expect(code(both)).not.toMatch(new RegExp(`\\b${column}\\b`, 'i'));
    });
  }

  it('never returns a raw player id from a public function', () => {
    for (const name of Object.keys(PUBLIC_FUNCTIONS)) {
      const header = functionBody(name).split('AS $function$')[0]!;
      expect(header, name).not.toMatch(/\bplayer_id\b|\bplayer1_id\b|\bplayer2_id\b/);
    }
  });
});
