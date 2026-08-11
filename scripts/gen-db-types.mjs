#!/usr/bin/env node
// Regenerates packages/shared/src/types/database.gen.ts from a live database.
//
// WHY THIS EXISTS. The Supabase CLI's `supabase gen types typescript` wants a
// connection string, and the connection string carries the postgres password.
// Nobody working on this repo holds that password, and nothing should have to:
// every other piece of database access in this project goes through the Pi over
// ssh, where the credential never leaves the host. So this script reads the
// catalogs itself through exactly that path:
//
//   ssh <host> "docker exec -i <container> psql -U postgres -d postgres ..."
//
// and emits a file in the same shape the Supabase CLI emits, so the two
// importers (apps/admin/src/lib/tournament-types.ts and
// apps/admin/src/lib/notify.ts) keep compiling and a future `supabase gen
// types` would not be a rewrite.
//
// The output is a pure function of the schema — no timestamps, no hostnames,
// every collection explicitly sorted — so re-running against an unchanged
// database produces a byte-identical file and any diff is a real schema change.
//
// Usage:
//   node scripts/gen-db-types.mjs                       # write the file
//   node scripts/gen-db-types.mjs --stdout               # print, write nothing
//   node scripts/gen-db-types.mjs --container supabase-db --label production
//
// This script only ever READS. It issues SELECTs against pg_catalog and nothing
// else; there is no code path here that writes to the database.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    sshHost: 'pi',
    container: 'supabase-staging-db',
    database: 'postgres',
    user: 'postgres',
    schemas: 'graphql_public,public',
    label: 'staging',
    out: 'packages/shared/src/types/database.gen.ts',
    stdout: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--ssh-host': opts.sshHost = take(); break;
      case '--container': opts.container = take(); break;
      case '--database': opts.database = take(); break;
      case '--user': opts.user = take(); break;
      case '--schemas': opts.schemas = take(); break;
      case '--label': opts.label = take(); break;
      case '--out': opts.out = take(); break;
      case '--stdout': opts.stdout = true; break;
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

const HELP = `
Usage: node scripts/gen-db-types.mjs [options]

  --ssh-host   <host>   ssh destination running the database container (default: pi)
  --container  <name>   docker container name (default: supabase-staging-db)
  --database   <name>   database name (default: postgres)
  --user       <name>   postgres role (default: postgres)
  --schemas    <a,b>    schemas to emit (default: graphql_public,public)
  --label      <text>   how the header names this database (default: staging)
  --out        <path>   output path, relative to the repo root
  --stdout              print to stdout instead of writing the file
`;

// ---------------------------------------------------------------------------
// Talking to the database
// ---------------------------------------------------------------------------

const SPLIT = '===gen-db-types-split===';

function shellQuote(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

// Runs every query in one psql session and returns the parsed JSON results in
// order. SQL goes in over stdin (`psql -f -`) rather than through `-c`, so no
// part of a query ever has to survive two layers of shell quoting.
function runQueries(opts, queries) {
  const sql = queries.join(`\nSELECT ${shellQuoteSql(SPLIT)};\n`);
  const remote = [
    'docker', 'exec', '-i', shellQuote(opts.container),
    'psql',
    '-U', shellQuote(opts.user),
    '-d', shellQuote(opts.database),
    '-X', '-A', '-t', '-q',
    '-v', shellQuote('ON_ERROR_STOP=1'),
    '-v', shellQuote(`schemas=${opts.schemas}`),
    '-f', '-',
  ].join(' ');

  const res = spawnSync('ssh', ['-o', 'BatchMode=yes', opts.sshHost, remote], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`psql failed (exit ${res.status}):\n${res.stderr || res.stdout}`);
  }
  if (res.stderr.trim()) process.stderr.write(`psql: ${res.stderr.trim()}\n`);

  // Each query is a single-row, single-column `json_agg(...)::text`. JSON text
  // escapes newlines inside string values, so one query == one output line.
  const chunks = res.stdout.split(new RegExp(`^${SPLIT}$`, 'm'));
  if (chunks.length !== queries.length) {
    throw new Error(`expected ${queries.length} result blocks, got ${chunks.length}`);
  }
  return chunks.map((chunk, i) => {
    const text = chunk.trim();
    if (!text) throw new Error(`query ${i} returned nothing`);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`query ${i} did not return JSON: ${text.slice(0, 200)}`);
    }
  });
}

function shellQuoteSql(s) {
  return `'${String(s).replaceAll("'", "''")}'`;
}

const SCHEMA_FILTER = `n.nspname = ANY (string_to_array(:'schemas', ','))`;

// Every aggregate carries an explicit ORDER BY: an unordered json_agg is free
// to return rows in whatever order the plan happened to produce, which would
// make the output non-deterministic for no reason.
const QUERIES = [
  // 0 — the whole type catalog, resolved in Node.
  `SELECT coalesce(json_agg(json_build_object(
       'oid', t.oid::int8,
       'name', t.typname,
       'schema', n.nspname,
       'typtype', t.typtype,
       'category', t.typcategory,
       'elem', nullif(t.typelem, 0)::int8,
       'base', nullif(t.typbasetype, 0)::int8,
       'relid', nullif(t.typrelid, 0)::int8
     ) ORDER BY t.oid), '[]')::text
   FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace`,

  // 1 — enum labels, in declaration order.
  `SELECT coalesce(json_agg(x ORDER BY x->>'schema', x->>'name'), '[]')::text FROM (
     SELECT json_build_object(
       'schema', n.nspname,
       'name', t.typname,
       'oid', t.oid::int8,
       'labels', (
         SELECT coalesce(json_agg(l.enumlabel ORDER BY l.enumsortorder, l.oid), '[]')
         FROM pg_enum l WHERE l.enumtypid = t.oid
       )
     ) AS x
     FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE t.typtype = 'e' AND ${SCHEMA_FILTER}
   ) s`,

  // 2 — relations (tables, views, materialized views) and their columns.
  `SELECT coalesce(json_agg(x ORDER BY x->>'schema', x->>'name'), '[]')::text FROM (
     SELECT json_build_object(
       'schema', n.nspname,
       'name', c.relname,
       'oid', c.oid::int8,
       'relkind', c.relkind,
       'insertable', (pg_relation_is_updatable(c.oid, true) & 8) = 8,
       'updatable', (pg_relation_is_updatable(c.oid, true) & 4) = 4,
       'columns', (
         SELECT coalesce(json_agg(json_build_object(
           'name', a.attname,
           'num', a.attnum,
           'type', a.atttypid::int8,
           'notnull', a.attnotnull,
           'hasdefault', a.atthasdef,
           'identity', a.attidentity,
           'generated', a.attgenerated
         ) ORDER BY a.attnum), '[]')
         FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       )
     ) AS x
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${SCHEMA_FILTER}
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND NOT c.relispartition
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
         WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
       )
   ) s`,

  // 3 — outgoing foreign keys, one row per constraint.
  //
  // isOneToOne is "the referencing side is unique", i.e. there is a unique,
  // non-partial index on exactly the constraint's own columns. INCLUDE columns
  // are excluded by clipping to indnkeyatts.
  `SELECT coalesce(json_agg(x ORDER BY x->>'schema', x->>'table', x->>'name'), '[]')::text FROM (
     SELECT json_build_object(
       'schema', n.nspname,
       'table', c.relname,
       'name', con.conname,
       'columns', (
         SELECT coalesce(json_agg(a.attname ORDER BY u.ord), '[]')
         FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
       ),
       'ref_schema', rn.nspname,
       'ref_table', rc.relname,
       'ref_columns', (
         SELECT coalesce(json_agg(a.attname ORDER BY u.ord), '[]')
         FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = u.attnum
       ),
       'one_to_one', EXISTS (
         SELECT 1 FROM pg_index i
         WHERE i.indrelid = con.conrelid
           AND i.indisunique
           AND i.indpred IS NULL
           AND i.indnkeyatts = array_length(con.conkey, 1)
           AND (
             SELECT array_agg(DISTINCT u.k)
             FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS u(k, o)
             WHERE u.o <= i.indnkeyatts
           ) = (SELECT array_agg(DISTINCT k) FROM unnest(con.conkey) AS k)
       )
     ) AS x
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_class rc ON rc.oid = con.confrelid
     JOIN pg_namespace rn ON rn.oid = rc.relnamespace
     WHERE con.contype = 'f' AND ${SCHEMA_FILTER}
   ) s`,

  // 4 — functions and procedures, with argument modes so OUT/TABLE returns can
  // be rebuilt. Extension-owned functions are skipped; they are not the app's.
  `SELECT coalesce(json_agg(x ORDER BY x->>'schema', x->>'name', (x->>'oid')::int8), '[]')::text FROM (
     SELECT json_build_object(
       'schema', n.nspname,
       'name', p.proname,
       'oid', p.oid::int8,
       'retset', p.proretset,
       'rettype', p.prorettype::int8,
       'nargdefaults', p.pronargdefaults,
       'args', (
         SELECT coalesce(json_agg(json_build_object(
           'ord', u.ord,
           'name', coalesce((p.proargnames)[u.ord], ''),
           'type', u.t::int8,
           'mode', coalesce((p.proargmodes)[u.ord], 'i')
         ) ORDER BY u.ord), '[]')
         FROM unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]))
              WITH ORDINALITY AS u(t, ord)
       )
     ) AS x
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE ${SCHEMA_FILTER}
       AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
         WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
       )
   ) s`,
];

// ---------------------------------------------------------------------------
// Postgres type -> TypeScript
// ---------------------------------------------------------------------------

const BASE_TYPES = new Map(Object.entries({
  bool: 'boolean',
  int2: 'number', int4: 'number', int8: 'number',
  float4: 'number', float8: 'number', numeric: 'number', money: 'number',
  oid: 'number',
  text: 'string', varchar: 'string', bpchar: 'string', char: 'string',
  name: 'string', citext: 'string', uuid: 'string',
  date: 'string', time: 'string', timetz: 'string',
  timestamp: 'string', timestamptz: 'string', interval: 'string',
  bytea: 'string', inet: 'string', cidr: 'string', macaddr: 'string',
  macaddr8: 'string', tsvector: 'string', tsquery: 'string', xml: 'string',
  bit: 'string', varbit: 'string', ltree: 'string', vector: 'string',
  json: 'Json', jsonb: 'Json',
  void: 'undefined',
  record: 'Record<string, unknown>',
}));

class TypeResolver {
  constructor(types, enums, relations, emittedSchemas) {
    this.byOid = new Map(types.map((t) => [Number(t.oid), t]));
    this.enumsByOid = new Map(enums.map((e) => [Number(e.oid), e]));
    this.relByRowtype = new Map();
    for (const r of relations) {
      const t = types.find((x) => Number(x.relid) === Number(r.oid));
      if (t) this.relByRowtype.set(Number(t.oid), r);
    }
    this.emittedSchemas = new Set(emittedSchemas);
    this.unsupported = new Map(); // description -> count
    this.composites = new Set();
    this.domains = new Set();
  }

  note(kind, what) {
    const key = `${kind}: ${what}`;
    this.unsupported.set(key, (this.unsupported.get(key) ?? 0) + 1);
  }

  ts(oid) {
    const t = this.byOid.get(Number(oid));
    if (!t) {
      this.note('unknown oid', String(oid));
      return 'unknown';
    }

    // Arrays: `_int4` etc. Element unions get parenthesised so `A | B` does not
    // become `A | B[]`.
    if (t.category === 'A' && t.elem) {
      const inner = this.ts(t.elem);
      return /[|&\s]/.test(inner) && !inner.endsWith(']') ? `(${inner})[]` : `${inner}[]`;
    }

    if (t.typtype === 'e') {
      if (this.emittedSchemas.has(t.schema)) {
        return `Database[${JSON.stringify(t.schema)}]["Enums"][${JSON.stringify(t.name)}]`;
      }
      const e = this.enumsByOid.get(Number(t.oid));
      return e ? e.labels.map((l) => JSON.stringify(l)).join(' | ') : 'string';
    }

    // A domain is a base type plus constraints TypeScript cannot see, so it
    // resolves to its base type. Recorded so the header can say so.
    if (t.typtype === 'd' && t.base) {
      this.domains.add(`${t.schema}.${t.name}`);
      return this.ts(t.base);
    }

    if (t.typtype === 'c') {
      const rel = this.relByRowtype.get(Number(t.oid));
      if (rel && this.emittedSchemas.has(rel.schema)) {
        const bucket = rel.relkind === 'r' || rel.relkind === 'p' || rel.relkind === 'f'
          ? 'Tables'
          : 'Views';
        return `Database[${JSON.stringify(rel.schema)}][${JSON.stringify(bucket)}][${JSON.stringify(rel.name)}]["Row"]`;
      }
      // A standalone composite type. The generated-file shape has a
      // CompositeTypes slot, but nothing in this repo has ever put one there
      // and guessing the syntax would be inventing it.
      this.composites.add(`${t.schema}.${t.name}`);
      this.note('composite type', `${t.schema}.${t.name}`);
      return 'unknown';
    }

    const mapped = BASE_TYPES.get(t.name);
    if (mapped) return mapped;
    this.note('unmapped base type', `${t.schema}.${t.name}`);
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Rendering
//
// A tiny formatter that reproduces the layout the Supabase CLI's output has
// after Prettier: print a construct on one line when it fits inside 80 columns
// at its indent, otherwise break it. Nothing here can affect type checking —
// it exists so the regenerated file reads like the file it replaces.
// ---------------------------------------------------------------------------

const PRINT_WIDTH = 80;

const lit = (v) => ({ t: 'lit', v });
const obj = (entries, force = false) => ({ t: 'obj', entries, force });
const vobj = (entries, force = false) => ({ t: 'vobj', entries, force });
const union = (members) => ({ t: 'union', members });
const arr = (items, force = false) => ({ t: 'arr', items, force });
// `inner[]` — a TypeScript array *type*, distinct from `arr` which is a tuple
// literal. Used for set-returning functions.
const arrayOf = (inner) => ({ t: 'arrayOf', inner });

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k) => (IDENT.test(k) ? k : JSON.stringify(k));

function inline(node) {
  switch (node.t) {
    case 'lit':
      return node.v;
    case 'obj': {
      if (node.force) return null;
      if (node.entries.length === 0) return '{}';
      const parts = [];
      for (const [k, v] of node.entries) {
        const iv = inline(v);
        if (iv === null) return null;
        parts.push(`${key(k)}: ${iv}`);
      }
      return `{ ${parts.join('; ')} }`;
    }
    case 'vobj': {
      if (node.force) return null;
      if (node.entries.length === 0) return '{}';
      const parts = [];
      for (const [k, v] of node.entries) {
        const iv = inline(v);
        if (iv === null) return null;
        parts.push(`${key(k)}: ${iv}`);
      }
      return `{ ${parts.join(', ')} }`;
    }
    case 'union': {
      const parts = node.members.map(inline);
      if (parts.some((p) => p === null)) return null;
      return parts.join(' | ');
    }
    case 'arr': {
      if (node.force) return null;
      if (node.items.length === 0) return '[]';
      const parts = node.items.map(inline);
      if (parts.some((p) => p === null)) return null;
      return `[${parts.join(', ')}]`;
    }
    case 'arrayOf': {
      const iv = inline(node.inner);
      return iv === null ? null : `${iv}[]`;
    }
    default:
      throw new Error(`unknown node ${node.t}`);
  }
}

// Returns an array of lines. `prefix` is whatever sits before the node on its
// first line (`Args: `), `suffix` whatever follows the last (`,`, `[]`).
function emit(node, indent, prefix, suffix) {
  const pad = ' '.repeat(indent);
  const one = inline(node);
  if (one !== null && indent + prefix.length + one.length + suffix.length <= PRINT_WIDTH) {
    return [pad + prefix + one + suffix];
  }

  switch (node.t) {
    case 'lit':
      return [pad + prefix + node.v + suffix];

    case 'obj':
    case 'vobj': {
      if (node.entries.length === 0) return [pad + prefix + '{}' + suffix];
      const sep = node.t === 'vobj' ? ',' : '';
      const out = [pad + prefix + '{'];
      for (const [k, v] of node.entries) out.push(...emit(v, indent + 2, `${key(k)}: `, sep));
      out.push(pad + '}' + suffix);
      return out;
    }

    case 'union': {
      // `key:` alone, then one `| member` per line. Prettier treats the `| ` as
      // part of the member's indentation, so the member renders two columns in
      // and its own first line gets the bar written over that indent.
      const out = [pad + prefix.replace(/\s+$/, '')];
      for (const m of node.members) {
        const lines = emit(m, indent + 2, '', '');
        lines[0] = `${pad}| ${lines[0].slice(indent + 2)}`;
        out.push(...lines);
      }
      if (suffix) out[out.length - 1] += suffix;
      return out;
    }

    case 'arr': {
      if (node.items.length === 0) return [pad + prefix + '[]' + suffix];
      const out = [pad + prefix + '['];
      for (const it of node.items) out.push(...emit(it, indent + 2, '', ','));
      out.push(pad + ']' + suffix);
      return out;
    }

    case 'arrayOf':
      return emit(node.inner, indent, prefix, `[]${suffix}`);

    default:
      throw new Error(`unknown node ${node.t}`);
  }
}

const EMPTY_SECTION = obj([['[_ in never]', lit('never')]], true);

// ---------------------------------------------------------------------------
// Building the Database type
// ---------------------------------------------------------------------------

const TRIGGER_RETURNS = new Set(['trigger', 'event_trigger']);
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function buildRelation(rel, fks, tr) {
  const isView = rel.relkind === 'v' || rel.relkind === 'm';
  const columns = [...rel.columns].sort((a, b) => byName(a.name, b.name));

  const rowEntries = [];
  const insertEntries = [];
  const updateEntries = [];

  for (const col of columns) {
    const base = tr.ts(col.type);
    const nullable = isView || !col.notnull;
    const type = nullable ? `${base} | null` : base;

    rowEntries.push([col.name, lit(type)]);

    // A column may be omitted from an INSERT when the database can supply it:
    // nullable, defaulted, identity, or generated. Getting this backwards is
    // the one thing here that is worse than having no types at all.
    const optional = isView
      || nullable
      || col.hasdefault
      || col.identity === 'a' || col.identity === 'd'
      || col.generated === 's';
    insertEntries.push([`${col.name}${optional ? '?' : ''}`, lit(type)]);
    updateEntries.push([`${col.name}?`, lit(type)]);
  }

  const entries = [['Row', obj(rowEntries, true)]];
  if (!isView || rel.insertable) entries.push(['Insert', obj(insertEntries, true)]);
  if (!isView || rel.updatable) entries.push(['Update', obj(updateEntries, true)]);

  // Views deliberately report no relationships: a view's foreign keys have to
  // be traced through its base-table dependencies, which this generator does
  // not do. Empty here means "not computed", not "none exist".
  const relFks = isView
    ? []
    : fks
        .filter((f) => f.schema === rel.schema && f.table === rel.name)
        .sort((a, b) => byName(a.name, b.name) || byName(a.columns.join(), b.columns.join()));

  entries.push(['Relationships', arr(relFks.map((f) => obj([
    ['foreignKeyName', lit(JSON.stringify(f.name))],
    ['columns', arr(f.columns.map((c) => lit(JSON.stringify(c))))],
    ['isOneToOne', lit(String(f.one_to_one))],
    ['referencedRelation', lit(JSON.stringify(f.ref_table))],
    ['referencedColumns', arr(f.ref_columns.map((c) => lit(JSON.stringify(c))))],
  ], true)), relFks.length > 0)]);

  return obj(entries, true);
}

function buildFunction(fn, tr) {
  const rt = tr.byOid.get(Number(fn.rettype));
  if (rt && TRIGGER_RETURNS.has(rt.name)) return null;

  const inArgs = fn.args.filter((a) => a.mode === 'i' || a.mode === 'b' || a.mode === 'v');
  const outArgs = fn.args.filter((a) => a.mode === 'o' || a.mode === 'b' || a.mode === 't');

  // Defaults attach to the trailing input arguments.
  const firstDefaulted = inArgs.length - (fn.nargdefaults ?? 0);

  let argsNode;
  if (inArgs.length === 0) {
    argsNode = obj([]);
  } else if (inArgs.some((a) => !a.name)) {
    // Positional-only arguments cannot be named in an object literal.
    tr.note('function with unnamed arguments', `${fn.schema}.${fn.name}`);
    argsNode = lit('Record<string, unknown>');
  } else {
    const entries = inArgs
      .map((a, i) => ({ a, optional: i >= firstDefaulted }))
      .sort((x, y) => byName(x.a.name, y.a.name))
      .map(({ a, optional }) => [`${a.name}${optional ? '?' : ''}`, lit(tr.ts(a.type))]);
    argsNode = obj(entries);
  }

  let returns;
  if (outArgs.length > 0) {
    const entries = [...outArgs]
      .sort((a, b) => byName(a.name, b.name))
      .map((a) => [a.name, lit(tr.ts(a.type))]);
    returns = obj(entries);
  } else {
    returns = lit(tr.ts(fn.rettype));
  }

  // A set-returning function yields rows, so the whole return type is an array.
  if (fn.retset) returns = arrayOf(returns);

  return obj([['Args', argsNode], ['Returns', returns]]);
}

function buildDatabase(data, opts) {
  const [types, enums, relations, fks, functions] = data;
  const schemas = opts.schemas.split(',').map((s) => s.trim()).filter(Boolean).sort(byName);
  const tr = new TypeResolver(types, enums, relations, schemas);

  const schemaEntries = [];
  for (const schema of schemas) {
    const rels = relations.filter((r) => r.schema === schema).sort((a, b) => byName(a.name, b.name));
    const tables = rels.filter((r) => r.relkind === 'r' || r.relkind === 'p' || r.relkind === 'f');
    const views = rels.filter((r) => r.relkind === 'v' || r.relkind === 'm');

    const tablesNode = tables.length
      ? obj(tables.map((r) => [r.name, buildRelation(r, fks, tr)]), true)
      : EMPTY_SECTION;
    const viewsNode = views.length
      ? obj(views.map((r) => [r.name, buildRelation(r, fks, tr)]), true)
      : EMPTY_SECTION;

    // Overloads collapse into a union, ordered by their rendered text so the
    // result does not depend on which oid the catalog handed back first.
    const fnGroups = new Map();
    for (const fn of functions.filter((f) => f.schema === schema)) {
      const node = buildFunction(fn, tr);
      if (!node) continue;
      if (!fnGroups.has(fn.name)) fnGroups.set(fn.name, []);
      fnGroups.get(fn.name).push(node);
    }
    const fnNames = [...fnGroups.keys()].sort(byName);
    const functionsNode = fnNames.length
      ? obj(fnNames.map((name) => {
          const variants = fnGroups.get(name);
          if (variants.length === 1) return [name, variants[0]];
          const sorted = variants
            .map((v) => ({ v, k: emit(v, 0, '', '').join('\n') }))
            .sort((a, b) => byName(a.k, b.k))
            .map((x) => x.v);
          return [name, union(sorted)];
        }), true)
      : EMPTY_SECTION;

    const schemaEnums = enums.filter((e) => e.schema === schema).sort((a, b) => byName(a.name, b.name));
    const enumsNode = schemaEnums.length
      ? obj(schemaEnums.map((e) => [
          e.name,
          e.labels.length === 0
            ? lit('never')
            : union(e.labels.map((l) => lit(JSON.stringify(l)))),
        ]), true)
      : EMPTY_SECTION;

    schemaEntries.push([schema, obj([
      ['Tables', tablesNode],
      ['Views', viewsNode],
      ['Functions', functionsNode],
      ['Enums', enumsNode],
      ['CompositeTypes', EMPTY_SECTION],
    ], true)]);
  }

  const constants = vobj(schemas.map((schema) => {
    const schemaEnums = enums.filter((e) => e.schema === schema).sort((a, b) => byName(a.name, b.name));
    return [schema, vobj([
      ['Enums', schemaEnums.length
        ? vobj(schemaEnums.map((e) => [e.name, arr(e.labels.map((l) => lit(JSON.stringify(l))))]), true)
        : vobj([])],
    ], true)];
  }), true);

  return { database: obj(schemaEntries, true), constants, tr, relations, enums, schemas };
}

// ---------------------------------------------------------------------------
// The static tail: the Supabase helper types, carried verbatim.
// ---------------------------------------------------------------------------

const HELPER_TYPES = `type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never`;

const JSON_TYPE = `export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]`;

function header(opts, built) {
  const { tr, relations, enums } = built;
  const tables = relations.filter((r) => r.relkind === 'r' || r.relkind === 'p' || r.relkind === 'f');
  const views = relations.filter((r) => r.relkind === 'v' || r.relkind === 'm');

  const cmd = [
    'node scripts/gen-db-types.mjs',
    `--ssh-host ${opts.sshHost}`,
    `--container ${opts.container}`,
    `--database ${opts.database}`,
    `--label ${opts.label}`,
  ].join(' ');

  const lines = [
    '// ############################################################################',
    '// GENERATED FILE — DO NOT EDIT BY HAND.',
    '//',
    '// Produced by scripts/gen-db-types.mjs, which reads pg_class, pg_attribute,',
    '// pg_constraint, pg_proc and pg_enum straight out of the running database over',
    '// ssh. Regenerate with:',
    '//',
    '//   npm run gen:types',
    '//',
    '// which is:',
    '//',
    `//   ${cmd}`,
    '//',
    `// SOURCE DATABASE: ${opts.label} — container "${opts.container}" on ssh host`,
    `// "${opts.sshHost}", database "${opts.database}", schemas ${opts.schemas}.`,
    '//',
    `// Covers ${tables.length} tables, ${views.length} views and ${enums.length} enums.`,
    '//',
    '// A hand edit here is lost on the next run, and a hand-edited .gen.ts is',
    '// fiction that looks generated. If something below is wrong, the fix belongs',
    '// in the schema or in the generator, never in this file.',
    '//',
    '// There is deliberately NO generation timestamp: the output is a pure function',
    '// of the schema, so re-running against an unchanged database rewrites this file',
    '// byte for byte and every diff is a real schema change.',
    '//',
    '// NOT EXPRESSED HERE. View relationships are not computed — a view reporting',
    '// "Relationships: []" means "not traced", not "none exist". Tables report',
    '// theirs in full.',
  ];

  if (tr.composites.size === 0 && tr.domains.size === 0) {
    lines.push(
      '// This schema has no composite types and no domains, so the CompositeTypes',
      '// slot is empty for the honest reason.',
    );
  } else {
    if (tr.domains.size > 0) {
      lines.push(`// Domains resolve to their base type (constraints are invisible to TS): ${[...tr.domains].sort().join(', ')}.`);
    }
    if (tr.composites.size > 0) {
      lines.push(`// Standalone composite types are NOT expressed and appear as "unknown": ${[...tr.composites].sort().join(', ')}.`);
    }
  }

  lines.push('// ############################################################################');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const data = runQueries(opts, QUERIES);
  const built = buildDatabase(data, opts);

  const out = [];
  out.push(header(opts, built), '');
  out.push(JSON_TYPE, '');
  out.push(...emit(built.database, 0, 'export type Database = ', ''));
  out.push('');
  out.push(HELPER_TYPES, '');
  out.push(...emit(built.constants, 0, 'export const Constants = ', ' as const'));

  const text = `${out.join('\n')}\n`;

  for (const [what, n] of [...built.tr.unsupported].sort()) {
    process.stderr.write(`warning: ${what} (${n}×) — emitted as unknown\n`);
  }

  if (opts.stdout) {
    process.stdout.write(text);
  } else {
    const path = resolve(REPO_ROOT, opts.out);
    writeFileSync(path, text);
    process.stderr.write(`wrote ${opts.out} (${text.split('\n').length - 1} lines)\n`);
  }
}

main();
