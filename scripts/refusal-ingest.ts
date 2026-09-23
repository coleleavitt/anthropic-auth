#!/usr/bin/env bun
/**
 * Refusal learning loop: ingest -> learn -> report.
 *
 * Folds the runtime logs into the local classifier database so the filter
 * vocabulary can be tuned from evidence instead of guesses:
 *
 *   refusal-events.jsonl           -> refusals
 *   content-filter-outcomes.jsonl  -> filter_outcomes (efficacy data)
 *   request dumps (+ refusal join) -> request_bodies, body_labels
 *   refused vs accepted dump tails -> term_tail_stats, term_cooccurrence,
 *                                     learned_terms (candidates)
 *
 * trigger_terms and rewrite_rules belong to the Python prototype
 * (~/.prime/agent/refusal_classifier.py) and are left untouched.
 *
 * A dump "tail" is the byte range that changed since the previous request in
 * the same session (dump metadata `diff`). The prefix before it was accepted
 * one turn earlier, so the tail is the best available view of what new
 * content was present when a request was refused.
 *
 * Learned terms are candidates for review. Nothing here changes the runtime
 * filter: promote a term by editing packages/core/src/content-filter.ts, so
 * each request stays deterministic and the prompt cache prefix stays stable.
 *
 * Usage:
 *   bun scripts/refusal-ingest.ts [--db PATH] [--log-dir DIR] [--dumps DIR]
 *     [--report] [--export PATH] [--max-tail-bytes N] [--dry-run]
 *
 * Every step is idempotent; re-running on the same inputs changes nothing.
 */
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { getContentFilterTermDictionaries } from '../packages/core/src/content-filter'
import {
  type DumpRecord,
  isRealSession,
  loadDumps,
  matchRefusal,
  type RefusalRow,
  readJsonLines,
  readTail,
} from './refusal-data'

type Args = {
  db: string
  logDir: string
  dumps: string
  report: boolean
  exportPath?: string
  maxTailBytes: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const logDir =
    process.env.REFUSAL_LOG_DIR || join(homedir(), '.prime', 'agent')
  const args: Args = {
    db: join(logDir, 'refusal-classifier.db'),
    logDir,
    dumps:
      process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR ||
      join(tmpdir(), 'opencode-anthropic-auth-dumps'),
    report: false,
    maxTailBytes: 64 * 1024,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    if (flag === '--db') args.db = value()
    else if (flag === '--log-dir') args.logDir = value()
    else if (flag === '--dumps') args.dumps = value()
    else if (flag === '--report') args.report = true
    else if (flag === '--export') args.exportPath = value()
    else if (flag === '--max-tail-bytes') args.maxTailBytes = Number(value())
    else if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--help' || flag === '-h') {
      console.log(readFileSync(import.meta.path, 'utf8').split('*/')[0])
      process.exit(0)
    } else throw new Error(`unknown flag ${flag}`)
  }
  return args
}

function sha16(text: string) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function ensureSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS refusals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    session_id TEXT,
    model TEXT,
    category TEXT,
    request_hash TEXT,
    body_size INTEGER,
    message_count INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    was_rerouted INTEGER,
    fallback_model TEXT,
    UNIQUE(request_hash, timestamp)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS trigger_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL UNIQUE,
    category TEXT,
    frequency INTEGER DEFAULT 1,
    first_seen TEXT,
    last_seen TEXT,
    confidence REAL DEFAULT 0.5
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS term_cooccurrence (
    term1 TEXT,
    term2 TEXT,
    count INTEGER DEFAULT 1,
    PRIMARY KEY (term1, term2)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS request_bodies (
    request_hash TEXT PRIMARY KEY,
    body_compressed BLOB,
    extracted_terms TEXT
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS learned_terms (
    id INTEGER PRIMARY KEY,
    term TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    weight REAL NOT NULL,
    source TEXT,
    created_at TEXT,
    hit_count INTEGER DEFAULT 1
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS filter_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    host TEXT,
    session_id TEXT,
    model TEXT,
    request_id TEXT,
    stop_reason TEXT,
    refusal_category TEXT,
    filter_ran INTEGER,
    blocks_scanned INTEGER,
    blocks_rewritten INTEGER,
    max_score_before REAL,
    max_score_after REAL,
    max_category TEXT,
    chars_scanned INTEGER,
    raw_totals TEXT,
    UNIQUE(timestamp, session_id, model, stop_reason)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS term_tail_stats (
    term TEXT PRIMARY KEY,
    category TEXT,
    refused_tails INTEGER NOT NULL,
    total_tails INTEGER NOT NULL,
    first_seen TEXT,
    last_seen TEXT,
    confidence REAL NOT NULL,
    updated_at TEXT
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS body_labels (
    dump_id TEXT PRIMARY KEY,
    request_hash TEXT,
    refused INTEGER NOT NULL,
    refusal_category TEXT,
    session_id TEXT,
    model TEXT,
    created_at TEXT,
    body_bytes INTEGER,
    tail_bytes INTEGER,
    tail_terms TEXT
  )`)
}

// ---------- 1. refusal events ----------

function ingestRefusals(db: Database, logDir: string) {
  const events = readJsonLines(join(logDir, 'refusal-events.jsonl'))
  const real: RefusalRow[] = []
  let fixtures = 0
  const insert = db.prepare(`INSERT OR IGNORE INTO refusals
    (timestamp, session_id, model, category, request_hash, body_size,
     message_count, input_tokens, output_tokens, was_rerouted, fallback_model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  let inserted = 0
  db.transaction(() => {
    for (const event of events) {
      if (!isRealSession(event.sessionId) || typeof event.model !== 'string') {
        fixtures++
        continue
      }
      const timestamp = String(event.timestamp ?? '')
      const requestHash =
        typeof event.requestId === 'string'
          ? event.requestId
          : sha16(JSON.stringify(event))
      const category =
        typeof event.category === 'string' ? event.category : null
      real.push({
        timestamp,
        sessionId: event.sessionId,
        model: event.model,
        category,
        requestHash,
      })
      const result = insert.run(
        timestamp,
        event.sessionId,
        event.model,
        category,
        requestHash,
        (event.bodySize as number | undefined) ?? null,
        (event.messageCount as number | undefined) ?? null,
        (event.inputTokens as number | undefined) ?? null,
        (event.outputTokens as number | undefined) ?? null,
        event.wasRerouted ? 1 : 0,
        (event.fallbackModel as string | undefined) ?? null,
      )
      inserted += result.changes
    }
  })()
  return { real, fixtures, inserted, total: events.length }
}

// ---------- 2. filter outcomes ----------

function ingestOutcomes(db: Database, logDir: string) {
  const events = readJsonLines(join(logDir, 'content-filter-outcomes.jsonl'))
  const insert = db.prepare(`INSERT OR IGNORE INTO filter_outcomes
    (timestamp, host, session_id, model, request_id, stop_reason,
     refusal_category, filter_ran, blocks_scanned, blocks_rewritten,
     max_score_before, max_score_after, max_category, chars_scanned,
     raw_totals)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  let inserted = 0
  let fixtures = 0
  db.transaction(() => {
    for (const event of events) {
      if (!isRealSession(event.sessionId)) {
        fixtures++
        continue
      }
      const filter = (event.filter ?? null) as Record<string, unknown> | null
      const result = insert.run(
        String(event.timestamp ?? ''),
        String(event.host ?? ''),
        event.sessionId,
        String(event.model ?? ''),
        (event.requestId as string | undefined) ?? null,
        String(event.stopReason ?? ''),
        (event.refusalCategory as string | undefined) ?? null,
        filter ? 1 : 0,
        (filter?.blocksScanned as number | undefined) ?? null,
        (filter?.blocksRewritten as number | undefined) ?? null,
        (filter?.maxScoreBefore as number | undefined) ?? null,
        (filter?.maxScoreAfter as number | undefined) ?? null,
        (filter?.maxCategory as string | undefined) ?? null,
        (filter?.charsScanned as number | undefined) ?? null,
        filter?.rawTotals ? JSON.stringify(filter.rawTotals) : null,
      )
      inserted += result.changes
    }
  })()
  return { inserted, fixtures, total: events.length }
}

// ---------- 3. dumps joined to refusals ----------

const DICTIONARIES = getContentFilterTermDictionaries()
const TERM_CATEGORY = new Map<string, string>()
for (const [category, terms] of Object.entries(DICTIONARIES))
  for (const term of Object.keys(terms))
    if (!TERM_CATEGORY.has(term.toLowerCase()))
      TERM_CATEGORY.set(term.toLowerCase(), category)

function dictionaryTermsIn(text: string): string[] {
  const lower = text.toLowerCase()
  const found: string[] = []
  for (const term of TERM_CATEGORY.keys()) {
    const hit =
      term.length <= 3
        ? new RegExp(
            `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          ).test(lower)
        : lower.includes(term)
    if (hit) found.push(term)
  }
  return found.sort()
}

type LabeledTail = {
  sessionId: string
  refused: boolean
  category: string | null
  timestamp: string
  tail: string
  terms: string[]
}

function ingestDumps(
  db: Database,
  refusals: RefusalRow[],
  dumps: Map<string, DumpRecord[]>,
  maxTailBytes: number,
) {
  const refusedDumps = new Map<string, RefusalRow>()
  for (const refusal of refusals) {
    const dump = matchRefusal(refusal, dumps)
    if (dump) refusedDumps.set(dump.id, refusal)
  }
  const refusedSessions = new Set(
    [...refusedDumps.values()].map((refusal) => refusal.sessionId),
  )
  const tails: LabeledTail[] = []
  const insertLabel = db.prepare(`INSERT OR REPLACE INTO body_labels
    (dump_id, request_hash, refused, refusal_category, session_id, model,
     created_at, body_bytes, tail_bytes, tail_terms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertBody = db.prepare(`INSERT OR IGNORE INTO request_bodies
    (request_hash, body_compressed, extracted_terms) VALUES (?, ?, ?)`)
  let bodiesStored = 0
  db.transaction(() => {
    // Accepted requests from the same sessions are the contrast set: same
    // project, same host, same prompt style, different outcome.
    for (const sessionId of refusedSessions) {
      for (const dump of dumps.get(sessionId) ?? []) {
        const refusal = refusedDumps.get(dump.id)
        const tail = readTail(dump, maxTailBytes)
        const terms = tail === null ? [] : dictionaryTermsIn(tail)
        insertLabel.run(
          dump.id,
          refusal?.requestHash ?? null,
          refusal ? 1 : 0,
          refusal?.category ?? null,
          sessionId,
          dump.model,
          new Date(dump.createdAt).toISOString(),
          dump.bodyBytes,
          tail?.length ?? null,
          JSON.stringify(terms),
        )
        if (refusal) {
          const body = readFileSync(dump.bodyPath)
          bodiesStored += insertBody.run(
            refusal.requestHash,
            Bun.gzipSync(body),
            JSON.stringify(terms),
          ).changes
        }
        if (tail !== null)
          tails.push({
            sessionId,
            refused: Boolean(refusal),
            category: refusal?.category ?? null,
            timestamp:
              refusal?.timestamp ?? new Date(dump.createdAt).toISOString(),
            tail,
            terms,
          })
      }
    }
  })()
  return { matched: refusedDumps.size, bodiesStored, tails }
}

// ---------- 4. learn ----------

function learnDictionaryStats(db: Database, tails: LabeledTail[]) {
  const stats = new Map<
    string,
    { refused: number; total: number; first?: string; last?: string }
  >()
  const pairs = new Map<string, number>()
  for (const tail of tails) {
    for (const term of tail.terms) {
      const entry = stats.get(term) ?? { refused: 0, total: 0 }
      entry.total++
      if (tail.refused) {
        entry.refused++
        if (!entry.first || tail.timestamp < entry.first)
          entry.first = tail.timestamp
        if (!entry.last || tail.timestamp > entry.last)
          entry.last = tail.timestamp
      }
      stats.set(term, entry)
    }
    if (!tail.refused) continue
    for (let i = 0; i < tail.terms.length; i++)
      for (let j = i + 1; j < tail.terms.length; j++) {
        const key = `${tail.terms[i]}\u0000${tail.terms[j]}`
        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
  }
  // Measured stats live in their own table: trigger_terms holds the Python
  // prototype's hand-seeded confidences, which a small sample must not
  // overwrite.
  const upsert = db.prepare(`INSERT INTO term_tail_stats
    (term, category, refused_tails, total_tails, first_seen, last_seen,
     confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(term) DO UPDATE SET category = excluded.category,
      refused_tails = excluded.refused_tails,
      total_tails = excluded.total_tails, first_seen = excluded.first_seen,
      last_seen = excluded.last_seen, confidence = excluded.confidence,
      updated_at = excluded.updated_at`)
  const now = new Date().toISOString()
  db.transaction(() => {
    for (const [term, entry] of stats) {
      // Laplace-smoothed P(refused | term in tail).
      const confidence = (entry.refused + 1) / (entry.total + 2)
      upsert.run(
        term,
        TERM_CATEGORY.get(term) ?? null,
        entry.refused,
        entry.total,
        entry.first ?? null,
        entry.last ?? null,
        Math.round(confidence * 10000) / 10000,
        now,
      )
    }
    db.run('DELETE FROM term_cooccurrence')
    const insertPair = db.prepare(
      'INSERT INTO term_cooccurrence (term1, term2, count) VALUES (?, ?, ?)',
    )
    for (const [key, count] of pairs) {
      const [a, b] = key.split('\u0000')
      insertPair.run(a ?? '', b ?? '', count)
    }
  })()
  return { terms: stats.size, pairs: pairs.size }
}

const TOKEN = /[a-z][a-z0-9_]{2,30}/g

function tailTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(TOKEN) ?? []
  const out = new Set<string>(words)
  for (let i = 0; i + 1 < words.length; i++)
    out.add(`${words[i]} ${words[i + 1]}`)
  return out
}

type LearnedTerm = {
  term: string
  category: string
  z: number
  refusedDocs: number
  acceptedDocs: number
}

/**
 * Log-odds ratio with an informative Dirichlet prior (Monroe, Colaresi &
 * Quinn 2008) over document frequencies: which tail tokens are over-
 * represented in refused tails relative to accepted tails from the same
 * sessions. Returns candidates with z >= 1.96, >= 3 refused documents from
 * >= 2 sessions, present in at most half of the accepted tails.
 */
function learnCandidateTerms(tails: LabeledTail[]): LearnedTerm[] {
  const refused = tails.filter((tail) => tail.refused)
  const accepted = tails.filter((tail) => !tail.refused)
  if (refused.length < 3 || accepted.length < 3) return []
  const docFreq = (group: LabeledTail[]) => {
    const counts = new Map<string, number>()
    const sessions = new Map<string, Set<string>>()
    const categories = new Map<string, Map<string, number>>()
    for (const tail of group)
      for (const token of tailTokens(tail.tail)) {
        counts.set(token, (counts.get(token) ?? 0) + 1)
        const seen = sessions.get(token) ?? new Set<string>()
        seen.add(tail.sessionId)
        sessions.set(token, seen)
        if (tail.category) {
          const byCategory = categories.get(token) ?? new Map<string, number>()
          byCategory.set(
            tail.category,
            (byCategory.get(tail.category) ?? 0) + 1,
          )
          categories.set(token, byCategory)
        }
      }
    return { counts, sessions, categories }
  }
  const r = docFreq(refused)
  const a = docFreq(accepted)
  const n1 = refused.length
  const n2 = accepted.length
  const alpha0 = 10
  const out: LearnedTerm[] = []
  for (const [token, y1] of r.counts) {
    if (y1 < 3) continue
    const y2 = a.counts.get(token) ?? 0
    const background = (y1 + y2) / (n1 + n2)
    const alpha = Math.max(alpha0 * background, 0.01)
    const delta =
      Math.log((y1 + alpha) / (n1 + alpha0 - y1 - alpha + 1e-9)) -
      Math.log((y2 + alpha) / (n2 + alpha0 - y2 - alpha + 1e-9))
    const z = delta / Math.sqrt(1 / (y1 + alpha) + 1 / (y2 + alpha))
    if (!(z >= 1.96)) continue
    if (TERM_CATEGORY.has(token)) continue
    // One chatty session can dominate a small refused set; require two.
    if ((r.sessions.get(token)?.size ?? 0) < 2) continue
    // Structure words (JSON keys, role names) sit in most accepted tails too.
    if (y2 / n2 > 0.5) continue
    const byCategory = r.categories.get(token)
    const category =
      [...(byCategory ?? new Map()).entries()].sort(
        (x, y) => y[1] - x[1],
      )[0]?.[0] ?? 'unknown'
    out.push({
      term: token,
      category,
      z: Math.round(z * 1000) / 1000,
      refusedDocs: y1,
      acceptedDocs: y2,
    })
  }
  return out.sort((x, y) => y.z - x.z).slice(0, 200)
}

function storeLearnedTerms(db: Database, learned: LearnedTerm[]) {
  const insert = db.prepare(`INSERT INTO learned_terms
    (term, category, weight, source, created_at, hit_count)
    VALUES (?, ?, ?, 'tail-logodds', ?, ?)
    ON CONFLICT(term) DO UPDATE SET category = excluded.category,
      weight = excluded.weight, hit_count = excluded.hit_count
    WHERE learned_terms.source = 'tail-logodds'`)
  const now = new Date().toISOString()
  db.transaction(() => {
    // Recompute: drop generated candidates, keep manual entries.
    db.run("DELETE FROM learned_terms WHERE source = 'tail-logodds'")
    for (const term of learned)
      insert.run(term.term, term.category, term.z, now, term.refusedDocs)
  })()
}

// ---------- 5. report ----------

function report(db: Database) {
  const rows = db
    .query(`SELECT filter_ran, blocks_rewritten, max_score_before, stop_reason
      FROM filter_outcomes`)
    .all() as Array<{
    filter_ran: number
    blocks_rewritten: number | null
    max_score_before: number | null
    stop_reason: string
  }>
  const table = new Map<string, { n: number; refused: number }>()
  const bump = (key: string, refused: boolean) => {
    const entry = table.get(key) ?? { n: 0, refused: 0 }
    entry.n++
    if (refused) entry.refused++
    table.set(key, entry)
  }
  for (const row of rows) {
    const refused = row.stop_reason === 'refusal'
    bump('all', refused)
    if (!row.filter_ran) {
      bump('filter did not run', refused)
      continue
    }
    bump(
      (row.blocks_rewritten ?? 0) > 0 ? 'filter rewrote' : 'filter passed',
      refused,
    )
    const score = row.max_score_before ?? 0
    bump(
      score >= 0.65
        ? 'max score >= 0.65'
        : score >= 0.4
          ? 'max score 0.40-0.65'
          : 'max score < 0.40',
      refused,
    )
  }
  console.log('\nFilter efficacy (content-filter-outcomes):')
  if (rows.length === 0) console.log('  no outcomes logged yet')
  for (const [key, entry] of table)
    console.log(
      `  ${key.padEnd(22)} n=${String(entry.n).padStart(6)} refused=${String(entry.refused).padStart(4)} rate=${((100 * entry.refused) / entry.n).toFixed(2)}%`,
    )
  console.log(
    '  Note: the filter runs on every request, so "rewrote" vs "passed" differ\n' +
      '  in content as well as treatment. Read these rates as correlations.',
  )
  const categories = db
    .query(
      "SELECT COALESCE(category, 'unknown') AS category, COUNT(*) AS n FROM refusals GROUP BY 1 ORDER BY 2 DESC",
    )
    .all() as Array<{ category: string; n: number }>
  console.log('\nRefusals by category:')
  for (const row of categories)
    console.log(`  ${row.category.padEnd(22)} ${row.n}`)
  const learned = db
    .query(
      'SELECT term, category, weight, hit_count FROM learned_terms ORDER BY weight DESC LIMIT 25',
    )
    .all() as Array<{
    term: string
    category: string
    weight: number
    hit_count: number
  }>
  console.log('\nTop learned candidate terms (review before promoting):')
  if (learned.length === 0) console.log('  none yet (needs >= 3 refused tails)')
  for (const row of learned)
    console.log(
      `  ${row.term.padEnd(32)} ${row.category.padEnd(20)} z=${row.weight.toFixed(2)} refused_docs=${row.hit_count}`,
    )
}

// ---------- main ----------

function main() {
  const args = parseArgs(process.argv.slice(2))
  const db = new Database(args.dryRun ? ':memory:' : args.db, { create: true })
  ensureSchema(db)
  const refusals = ingestRefusals(db, args.logDir)
  console.log(
    `refusal events: ${refusals.total} read, ${refusals.real.length} real, ${refusals.fixtures} fixtures skipped, ${refusals.inserted} new`,
  )
  const outcomes = ingestOutcomes(db, args.logDir)
  console.log(
    `filter outcomes: ${outcomes.total} read, ${outcomes.fixtures} fixtures skipped, ${outcomes.inserted} new`,
  )
  const dumps = loadDumps(args.dumps)
  const joined = ingestDumps(db, refusals.real, dumps, args.maxTailBytes)
  const refusedTails = joined.tails.filter((tail) => tail.refused).length
  console.log(
    `dumps: ${dumps.size} sessions, ${joined.matched} refusals matched to a body, ${joined.bodiesStored} new bodies stored, ${joined.tails.length} usable tails (${refusedTails} refused)`,
  )
  const dictionary = learnDictionaryStats(db, joined.tails)
  const learned = learnCandidateTerms(joined.tails)
  storeLearnedTerms(db, learned)
  if (refusedTails < 20)
    console.log(
      `warning: only ${refusedTails} refused tails; learned candidates are noise-prone until ~20`,
    )
  console.log(
    `learned: ${dictionary.terms} dictionary terms scored, ${dictionary.pairs} co-occurring pairs, ${learned.length} candidate terms`,
  )
  if (args.exportPath) {
    writeFileSync(args.exportPath, `${JSON.stringify(learned, null, 2)}\n`)
    console.log(`exported candidates to ${args.exportPath}`)
  }
  if (args.report) report(db)
  db.close()
}

main()
