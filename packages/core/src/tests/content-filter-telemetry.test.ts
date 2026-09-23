import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { filterRequestBody } from '../content-filter'
import {
  getContentFilterOutcomeLogPath,
  getLogPath,
  getRefusedBodyDir,
  logContentFilterOutcome,
  saveRefusedRequestBody,
} from '../refusal-logger'

describe('filterRequestBody summary', () => {
  it('counts every scanned block and reports the strongest one', () => {
    const body = {
      system: [{ type: 'text', text: 'You are a helpful assistant.' }],
      messages: [
        { role: 'user', content: 'hello there' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'verified against docs/a.md: refuted vs real',
            },
          ],
        },
      ],
    }
    const { summary } = filterRequestBody(body)
    expect(summary.blocksScanned).toBe(5)
    expect(summary.charsScanned).toBeGreaterThan(0)
    expect(summary.maxCategory).toBe('reasoning_extraction')
    expect(summary.maxScoreBefore).toBeGreaterThan(0.4)
    expect(summary.blocksFlagged).toBeGreaterThanOrEqual(1)
    expect(summary.rawTotals.reasoning_extraction).toBeGreaterThan(0)
  })

  it('reports an empty summary for a body with no text', () => {
    const { summary, filtered } = filterRequestBody({ messages: [] })
    expect(filtered).toBe(false)
    expect(summary).toEqual({
      blocksScanned: 0,
      charsScanned: 0,
      blocksFlagged: 0,
      blocksRewritten: 0,
      maxScoreBefore: 0,
      maxScoreAfter: 0,
      maxCategory: null,
      rawTotals: {},
    })
  })
})

describe('logContentFilterOutcome', () => {
  let dir: string
  let previous: string | undefined
  beforeEach(() => {
    previous = process.env.REFUSAL_LOG_DIR
    dir = mkdtempSync(join(tmpdir(), 'cf-outcome-'))
    // Set after the module loaded: the path must still follow it.
    process.env.REFUSAL_LOG_DIR = dir
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.REFUSAL_LOG_DIR
    else process.env.REFUSAL_LOG_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves both log paths from REFUSAL_LOG_DIR at call time', () => {
    expect(getLogPath()).toBe(join(dir, 'refusal-events.jsonl'))
    expect(getContentFilterOutcomeLogPath()).toBe(
      join(dir, 'content-filter-outcomes.jsonl'),
    )
  })

  it('appends one JSON line per outcome', () => {
    const { summary } = filterRequestBody({
      messages: [{ role: 'user', content: 'plain text' }],
    })
    logContentFilterOutcome({
      host: 'pi',
      sessionId: 's1',
      model: 'claude-opus-5',
      requestId: 'req_1',
      stopReason: 'end_turn',
      filter: summary,
    })
    logContentFilterOutcome({
      host: 'opencode',
      model: 'claude-opus-5',
      stopReason: 'refusal',
      refusalCategory: 'cyber',
      filter: null,
    })
    const lines = readFileSync(getContentFilterOutcomeLogPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0].filter.blocksScanned).toBe(1)
    expect(typeof lines[0].timestamp).toBe('string')
    expect(lines[1]).toMatchObject({
      host: 'opencode',
      stopReason: 'refusal',
      refusalCategory: 'cyber',
      filter: null,
    })
  })

  it('never throws when the directory cannot be created', () => {
    process.env.REFUSAL_LOG_DIR = '/proc/definitely-not-writable/x'
    expect(() =>
      logContentFilterOutcome({
        host: 'pi',
        model: 'm',
        stopReason: 'end_turn',
        filter: null,
      }),
    ).not.toThrow()
    expect(existsSync('/proc/definitely-not-writable')).toBe(false)
  })
})

describe('saveRefusedRequestBody', () => {
  let dir: string
  let previous: string | undefined
  beforeEach(() => {
    previous = process.env.REFUSAL_LOG_DIR
    dir = mkdtempSync(join(tmpdir(), 'refused-body-'))
    process.env.REFUSAL_LOG_DIR = dir
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.REFUSAL_LOG_DIR
    else process.env.REFUSAL_LOG_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the exact body as private gzip JSON', () => {
    const body = JSON.stringify({ model: 'claude-opus-5', messages: [] })
    const path = saveRefusedRequestBody({
      host: 'pi',
      body,
      sessionId: 's1',
      model: 'claude-opus-5',
      requestId: 'req_abc/../x',
      category: 'cyber',
    })
    expect(path).toBeDefined()
    expect(path?.startsWith(getRefusedBodyDir())).toBe(true)
    // Path separators in the request id cannot escape the directory.
    expect(path).toContain('req_abc____x')
    const record = JSON.parse(
      gunzipSync(readFileSync(path as string)).toString('utf8'),
    )
    expect(record).toMatchObject({
      host: 'pi',
      sessionId: 's1',
      model: 'claude-opus-5',
      requestId: 'req_abc/../x',
      category: 'cyber',
      body,
    })
    if (process.platform !== 'win32') {
      expect(statSync(path as string).mode & 0o777).toBe(0o600)
      expect(statSync(getRefusedBodyDir()).mode & 0o777).toBe(0o700)
    }
  })

  it('removes the oldest files once over the cap, never the newest', async () => {
    const big = 'x'.repeat(20_000)
    const paths: string[] = []
    for (let i = 0; i < 4; i++) {
      paths.push(
        saveRefusedRequestBody(
          {
            host: 'opencode',
            body: `${big}${i}${Math.random()}`.repeat(3),
            model: 'm',
            requestId: `req_${i}`,
          },
          // gzip shrinks the repeated text to well under 1KB per file.
          { maxBytes: 1 },
        ) as string,
      )
      await Bun.sleep(2)
    }
    const left = readdirSync(getRefusedBodyDir())
    expect(left).toHaveLength(1)
    expect(join(getRefusedBodyDir(), left[0] as string)).toBe(
      paths[3] as string,
    )
  })

  it('never throws when the directory cannot be created', () => {
    process.env.REFUSAL_LOG_DIR = '/proc/definitely-not-writable/x'
    expect(
      saveRefusedRequestBody({ host: 'pi', body: '{}', model: 'm' }),
    ).toBeUndefined()
  })
})
