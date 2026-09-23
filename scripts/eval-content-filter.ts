#!/usr/bin/env bun
/**
 * Offline check of the content-filter scoring against real outcomes.
 *
 * Joins request dumps to the refusal that followed them (same session, same
 * model, within 15 minutes), then asks: does a score rank refused requests
 * above accepted ones? It reports ROC AUC two ways:
 *
 * - pooled: all labelled requests together. Inflated by session identity,
 *   because a few sessions hold most refusals.
 * - within-session: only pairs from the same session. This is the fair test
 *   for a per-request signal.
 *
 * Scores compared: the shipped length normalization (score / sqrt(len/1000)),
 * no normalization, log normalization, the filter's per-block maximum, the
 * summed per-block raw totals, and body length alone.
 *
 * Usage: bun scripts/eval-content-filter.ts [--log-dir DIR] [--dumps DIR]
 */
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classify,
  filterRequestBody,
} from '../packages/core/src/content-filter'
import {
  isRealSession,
  loadDumps,
  matchRefusal,
  type RefusalRow,
  readJsonLines,
} from './refusal-data'

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const logDir = arg(
  '--log-dir',
  process.env.REFUSAL_LOG_DIR || join(homedir(), '.prime', 'agent'),
)
const dumpDir = arg(
  '--dumps',
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR ||
    join(tmpdir(), 'opencode-anthropic-auth-dumps'),
)

function bodyTexts(body: Record<string, unknown>): string[] {
  const out: string[] = []
  const system = Array.isArray(body.system) ? body.system : []
  for (const block of system)
    if (typeof block?.text === 'string') out.push(block.text)
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    if (typeof message?.content === 'string') {
      out.push(message.content)
      continue
    }
    for (const block of Array.isArray(message?.content)
      ? message.content
      : []) {
      if (typeof block?.text === 'string') out.push(block.text)
      if (typeof block?.thinking === 'string') out.push(block.thinking)
      if (block?.type === 'tool_use')
        out.push(JSON.stringify(block.input ?? {}))
      if (block?.type === 'tool_result') {
        if (typeof block.content === 'string') out.push(block.content)
        else
          for (const part of Array.isArray(block.content) ? block.content : [])
            if (typeof part?.text === 'string') out.push(part.text)
      }
    }
  }
  return out
}

type Row = {
  sessionId: string
  refused: boolean
  features: Record<string, number>
}

const refusals: RefusalRow[] = []
for (const event of readJsonLines(join(logDir, 'refusal-events.jsonl'))) {
  if (!isRealSession(event.sessionId) || typeof event.model !== 'string')
    continue
  refusals.push({
    timestamp: String(event.timestamp ?? ''),
    sessionId: event.sessionId,
    model: event.model,
    category: typeof event.category === 'string' ? event.category : null,
    requestHash: String(event.requestId ?? ''),
  })
}
const dumps = loadDumps(dumpDir)
const refusedIds = new Set<string>()
for (const refusal of refusals) {
  const dump = matchRefusal(refusal, dumps)
  if (dump) refusedIds.add(dump.id)
}
const refusedSessions = new Set(
  refusals
    .filter((refusal) => matchRefusal(refusal, dumps))
    .map((refusal) => refusal.sessionId),
)

const rows: Row[] = []
for (const sessionId of refusedSessions) {
  for (const dump of dumps.get(sessionId) ?? []) {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(readFileSync(dump.bodyPath, 'utf8'))
    } catch {
      continue
    }
    const text = bodyTexts(body).join('\n')
    const length = text.length
    const scale = Math.sqrt(Math.max(1, length / 1000))
    const shipped = Math.max(0, ...Object.values(classify(text).scores))
    const raw = shipped * scale
    const { summary } = filterRequestBody(body)
    rows.push({
      sessionId,
      refused: refusedIds.has(dump.id),
      features: {
        'shipped sqrt norm': shipped,
        'no normalization': raw,
        'log normalization': raw / Math.log2(2 + length / 1000),
        'per-block max': summary.maxScoreBefore,
        'summed block raw': Object.values(summary.rawTotals).reduce(
          (sum, value) => sum + value,
          0,
        ),
        'body length': length,
      },
    })
  }
}

function auc(pairs: Array<[number, number]>) {
  if (pairs.length === 0) return Number.NaN
  let wins = 0
  for (const [positive, negative] of pairs)
    wins += positive > negative ? 1 : positive === negative ? 0.5 : 0
  return wins / pairs.length
}

function pairsFor(feature: string, withinSession: boolean) {
  const pairs: Array<[number, number]> = []
  for (const positive of rows)
    if (positive.refused)
      for (const negative of rows)
        if (
          !negative.refused &&
          (!withinSession || negative.sessionId === positive.sessionId)
        )
          pairs.push([
            positive.features[feature] ?? 0,
            negative.features[feature] ?? 0,
          ])
  return pairs
}

const positives = rows.filter((row) => row.refused).length
console.log(
  `${rows.length} requests from ${refusedSessions.size} sessions, ${positives} refused`,
)
console.log('feature                 pooled AUC   within-session AUC')
for (const feature of Object.keys(rows[0]?.features ?? {}))
  console.log(
    `${feature.padEnd(22)}  ${auc(pairsFor(feature, false)).toFixed(3).padStart(10)}   ${auc(pairsFor(feature, true)).toFixed(3).padStart(18)}`,
  )
console.log(
  'AUC 0.5 = no signal. Below 0.5 = the score is higher on accepted requests.',
)
