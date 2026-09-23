/**
 * Shared readers for the refusal learning scripts: runtime JSONL logs and
 * request dumps joined to the refusal that followed them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/
/** Real host sessions are UUIDs; test fixtures use names like ses_pi_*. */
export function isRealSession(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && UUID_PREFIX.test(sessionId)
}

export function readJsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  const out: Record<string, unknown>[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // Skip a torn line from a concurrent append.
    }
  }
  return out
}

export type RefusalRow = {
  timestamp: string
  sessionId: string
  model: string
  category: string | null
  requestHash: string
}

export type DumpRecord = {
  id: string
  createdAt: number
  sessionId: string
  model: string
  bodyPath: string
  bodyBytes: number
  diff?: {
    changed?: boolean
    firstByte?: number
    lastCurrentByte?: number
  }
}

const DUMP_SESSION =
  /-\d{6}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/
/** Background prewarm dumps (cache keepalive, prime, lane start) are not user turns. */
const PREWARM_TAG = /-(cachekeep|prime|start)(-|\.)/

export function loadDumps(dir: string): Map<string, DumpRecord[]> {
  const bySession = new Map<string, DumpRecord[]>()
  if (!existsSync(dir)) return bySession
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.meta.json') || PREWARM_TAG.test(name)) continue
    const sessionId = DUMP_SESSION.exec(name)?.[1]
    if (!sessionId) continue
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const files = meta.files as { body?: string } | undefined
    const body = meta.body as { model?: string } | undefined
    if (!files?.body || !body?.model || !existsSync(files.body)) continue
    const list = bySession.get(sessionId) ?? []
    list.push({
      id: String(meta.id),
      createdAt: Date.parse(String(meta.createdAt)),
      sessionId,
      model: body.model,
      bodyPath: files.body,
      bodyBytes: Number(meta.bodyBytes ?? 0),
      diff: meta.diff as DumpRecord['diff'],
    })
    bySession.set(sessionId, list)
  }
  for (const list of bySession.values())
    list.sort((a, b) => a.createdAt - b.createdAt)
  return bySession
}

/** Latest same-model dump at or before the refusal, within 15 minutes. */
export function matchRefusal(
  refusal: RefusalRow,
  dumps: Map<string, DumpRecord[]>,
): DumpRecord | undefined {
  const at = Date.parse(refusal.timestamp)
  let best: DumpRecord | undefined
  for (const dump of dumps.get(refusal.sessionId) ?? []) {
    if (dump.model !== refusal.model) continue
    if (dump.createdAt > at || at - dump.createdAt > 15 * 60_000) continue
    best = dump
  }
  return best
}

export function readTail(
  dump: DumpRecord,
  maxTailBytes: number,
): string | null {
  const diff = dump.diff
  if (
    !diff?.changed ||
    typeof diff.firstByte !== 'number' ||
    typeof diff.lastCurrentByte !== 'number'
  )
    return null
  const length = diff.lastCurrentByte - diff.firstByte + 1
  // A tail this large means the whole body was re-serialized (model switch,
  // new system prompt), not that new content arrived. It carries no signal.
  if (length <= 0 || length > maxTailBytes) return null
  const bytes = readFileSync(dump.bodyPath)
  return bytes
    .subarray(diff.firstByte, diff.lastCurrentByte + 1)
    .toString('utf8')
    .replace(/\\[nrt"\\]/g, ' ')
}
