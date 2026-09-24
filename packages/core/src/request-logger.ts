import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ANTHROPIC_REQUESTS_DB_PATH = join(
  homedir(),
  '.config/opencode/anthropic-requests.db',
)
const ANTHROPIC_USAGE_DB_PATH = join(
  homedir(),
  '.config/opencode/anthropic-usage.db',
)

export const CLAUDE_USAGE_COMMAND_NAME = 'claude-usage'

export function executeUsageCommand(): string {
  return getUsageSummaryReport()
}

export type ModelPricing = {
  input: number // Cost per 1M tokens in USD
  output: number // Cost per 1M tokens in USD
  cacheRead: number // Cost per 1M tokens in USD
  cacheWrite: number // Cost per 1M tokens in USD
}

export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Opus Models
  'claude-opus-4-6': {
    input: 15.0,
    output: 75.0,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  'claude-opus-4-5': {
    input: 15.0,
    output: 75.0,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  'claude-opus-4': {
    input: 15.0,
    output: 75.0,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  'claude-3-opus': {
    input: 15.0,
    output: 75.0,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },

  // Sonnet Models
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  'claude-sonnet-4-5': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  'claude-3-5-sonnet': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  'claude-sonnet-4': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },

  // Haiku Models
  'claude-haiku-4-5': {
    input: 0.8,
    output: 4.0,
    cacheRead: 0.08,
    cacheWrite: 1.0,
  },
  'claude-haiku-3-5': {
    input: 0.8,
    output: 4.0,
    cacheRead: 0.08,
    cacheWrite: 1.0,
  },
  'claude-3-haiku': {
    input: 0.25,
    output: 1.25,
    cacheRead: 0.03,
    cacheWrite: 0.3,
  },
}

export function getModelPricing(modelName?: string): ModelPricing {
  if (!modelName)
    return { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 }
  const cleanName = modelName.toLowerCase()
  for (const [key, pricing] of Object.entries(DEFAULT_PRICING)) {
    if (cleanName.includes(key.toLowerCase())) {
      return pricing
    }
  }
  return { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 }
}

export function calculateCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  const pricing = getModelPricing(model)
  const inputCost = (inputTokens / 1_000_000) * pricing.input
  const outputCost = (outputTokens / 1_000_000) * pricing.output
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheRead
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cacheWrite
  return inputCost + outputCost + cacheReadCost + cacheWriteCost
}

export type RecordUsageInput = {
  accountEmail?: string
  accountName?: string
  model?: string
  agent?: string
  sessionId?: string
  messageId?: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  durationMs?: number
  statusCode?: number
}

type SqliteDatabase = import('bun:sqlite').Database

let requestsDbInstance: SqliteDatabase | null = null
let usageDbInstance: SqliteDatabase | null = null

function getRequestsDb() {
  if (requestsDbInstance) return requestsDbInstance
  try {
    const dir = join(homedir(), '.config/opencode')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    // Natively import Bun:sqlite
    const { Database } = require('bun:sqlite')
    const db: SqliteDatabase = new Database(ANTHROPIC_REQUESTS_DB_PATH)
    db.run('PRAGMA journal_mode = WAL;')
    db.run(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        session_id TEXT,
        message_id TEXT,
        agent TEXT,
        model TEXT,
        provider TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER,
        status_code INTEGER,
        account_email TEXT,
        account_name TEXT
      );
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS daily_aggregates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE NOT NULL,
        agent TEXT,
        model TEXT,
        request_count INTEGER DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_cache_read_tokens INTEGER DEFAULT 0,
        total_cache_write_tokens INTEGER DEFAULT 0,
        total_cost_usd REAL DEFAULT 0,
        account_email TEXT,
        account_name TEXT,
        UNIQUE(date, agent, model, account_email)
      );
    `)
    requestsDbInstance = db
    return db
  } catch (err) {
    console.error('[anthropic-auth] SQLite requests DB init error:', err)
    return null
  }
}

function getUsageDb() {
  if (usageDbInstance) return usageDbInstance
  try {
    const dir = join(homedir(), '.config/opencode')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const { Database } = require('bun:sqlite')
    const db: SqliteDatabase = new Database(ANTHROPIC_USAGE_DB_PATH)
    db.run('PRAGMA journal_mode = WAL;')
    db.run(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        account_name TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        request_id TEXT,
        duration_ms INTEGER,
        status_code INTEGER
      );
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS daily_summary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        date DATE NOT NULL,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_cache_tokens INTEGER DEFAULT 0,
        total_cost_usd REAL DEFAULT 0,
        request_count INTEGER DEFAULT 0,
        UNIQUE(account_id, date)
      );
    `)
    usageDbInstance = db
    return db
  } catch (err) {
    console.error('[anthropic-auth] SQLite usage DB init error:', err)
    return null
  }
}

export function recordRequestUsage(input: RecordUsageInput): boolean {
  try {
    const email = input.accountEmail || 'unknown'
    const name = input.accountName || email
    const model = input.model || 'claude-sonnet-4-6'
    const agent = input.agent || 'opencode'
    const provider = input.provider || 'anthropic'
    const inTokens = Math.max(0, input.inputTokens || 0)
    const outTokens = Math.max(0, input.outputTokens || 0)
    const cacheRead = Math.max(0, input.cacheReadTokens || 0)
    const cacheWrite = Math.max(0, input.cacheWriteTokens || 0)
    const duration = input.durationMs || 0
    const statusCode = input.statusCode || 200

    const costUsd = calculateCostUSD(
      model,
      inTokens,
      outTokens,
      cacheRead,
      cacheWrite,
    )

    // 1. Record into anthropic-requests.db
    const rDb = getRequestsDb()
    if (rDb) {
      rDb
        .prepare(`
        INSERT INTO requests (
          session_id, message_id, agent, model, provider,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, duration_ms, status_code, account_email, account_name, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `)
        .run(
          input.sessionId || null,
          input.messageId || null,
          agent,
          model,
          provider,
          inTokens,
          outTokens,
          cacheRead,
          cacheWrite,
          costUsd,
          duration,
          statusCode,
          email,
          name,
        )

      const today = new Date().toISOString().slice(0, 10)
      try {
        rDb
          .prepare(`
          INSERT INTO daily_aggregates (
            date, agent, model, request_count,
            total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens,
            total_cost_usd, account_email, account_name
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            today,
            agent,
            model,
            inTokens,
            outTokens,
            cacheRead,
            cacheWrite,
            costUsd,
            email,
            name,
          )
      } catch (_err) {
        rDb
          .prepare(`
          UPDATE daily_aggregates SET
            request_count = request_count + 1,
            total_input_tokens = total_input_tokens + ?,
            total_output_tokens = total_output_tokens + ?,
            total_cache_read_tokens = total_cache_read_tokens + ?,
            total_cache_write_tokens = total_cache_write_tokens + ?,
            total_cost_usd = total_cost_usd + ?
          WHERE date = ? AND agent = ? AND model = ? AND account_email = ?
        `)
          .run(
            inTokens,
            outTokens,
            cacheRead,
            cacheWrite,
            costUsd,
            today,
            agent,
            model,
            email,
          )
      }
    }

    // 2. Record into anthropic-usage.db
    const uDb = getUsageDb()
    if (uDb) {
      uDb
        .prepare(`
        INSERT INTO usage_records (
          account_id, account_name, model, input_tokens, output_tokens,
          cache_tokens, cost_usd, request_id, duration_ms, status_code, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `)
        .run(
          email,
          name,
          model,
          inTokens,
          outTokens,
          cacheRead + cacheWrite,
          costUsd,
          input.messageId || null,
          duration,
          statusCode,
        )

      const today = new Date().toISOString().slice(0, 10)
      try {
        uDb
          .prepare(`
          INSERT INTO daily_summary (
            account_id, date, total_input_tokens, total_output_tokens,
            total_cache_tokens, total_cost_usd, request_count
          ) VALUES (?, ?, ?, ?, ?, ?, 1)
        `)
          .run(
            email,
            today,
            inTokens,
            outTokens,
            cacheRead + cacheWrite,
            costUsd,
          )
      } catch (_err) {
        uDb
          .prepare(`
          UPDATE daily_summary SET
            total_input_tokens = total_input_tokens + ?,
            total_output_tokens = total_output_tokens + ?,
            total_cache_tokens = total_cache_tokens + ?,
            total_cost_usd = total_cost_usd + ?,
            request_count = request_count + 1
          WHERE account_id = ? AND date = ?
        `)
          .run(
            inTokens,
            outTokens,
            cacheRead + cacheWrite,
            costUsd,
            email,
            today,
          )
      }
    }

    return true
  } catch (err) {
    console.error('[anthropic-auth] Error recording request usage:', err)
    return false
  }
}

type UsageTotalsRow = {
  cnt: number
  total_in: number
  total_out: number
  cache_r: number
  cache_w: number
  total_cost: number
}

type AccountUsageRow = {
  account_email: string | null
  cnt: number
  total_in: number
  total_out: number
  total_cost: number
}

export function getUsageSummaryReport(): string {
  try {
    const rDb = getRequestsDb()
    if (!rDb) return 'Database unavailable.'

    const totals = rDb
      .prepare<UsageTotalsRow, []>(`
      SELECT 
        COUNT(*) as cnt,
        COALESCE(SUM(input_tokens), 0) as total_in,
        COALESCE(SUM(output_tokens), 0) as total_out,
        COALESCE(SUM(cache_read_tokens), 0) as cache_r,
        COALESCE(SUM(cache_write_tokens), 0) as cache_w,
        COALESCE(SUM(cost_usd), 0) as total_cost
      FROM requests
    `)
      .get()

    const accounts = rDb
      .prepare<AccountUsageRow, []>(`
      SELECT 
        account_email,
        COUNT(*) as cnt,
        COALESCE(SUM(input_tokens), 0) as total_in,
        COALESCE(SUM(output_tokens), 0) as total_out,
        COALESCE(SUM(cost_usd), 0) as total_cost
      FROM requests
      GROUP BY account_email
      ORDER BY total_cost DESC
    `)
      .all()

    if (!totals) return 'No usage recorded yet.'

    const lines: string[] = [
      '## Anthropic Usage Report',
      '',
      `**Total Requests**: ${totals.cnt.toLocaleString()}`,
      `**Total Input Tokens**: ${totals.total_in.toLocaleString()}`,
      `**Total Output Tokens**: ${totals.total_out.toLocaleString()}`,
      `**Total Cache Tokens**: ${(totals.cache_r + totals.cache_w).toLocaleString()}`,
      `**Total Estimated Cost**: $${totals.total_cost.toFixed(2)}`,
      '',
      '### Breakdown by Account:',
    ]

    for (const acc of accounts) {
      lines.push(
        `- **${acc.account_email || 'Unknown'}**: ${acc.cnt.toLocaleString()} reqs | In: ${acc.total_in.toLocaleString()} | Out: ${acc.total_out.toLocaleString()} | Cost: $${acc.total_cost.toFixed(2)}`,
      )
    }

    return lines.join('\n')
  } catch (err) {
    return `Error generating usage report: ${err}`
  }
}

export function recordResponseUsage(
  accountEmail: string,
  model: string,
  headers?: Headers,
  durationMs: number = 0,
  statusCode: number = 200,
  bodyUsage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
  extra?: {
    agent?: string
    sessionId?: string
    messageId?: string
  },
): boolean {
  const inTokens =
    bodyUsage?.input_tokens ??
    parseInt(headers?.get('x-anthropic-input-tokens') || '0', 10)
  const outTokens =
    bodyUsage?.output_tokens ??
    parseInt(headers?.get('x-anthropic-output-tokens') || '0', 10)
  const cacheRead =
    bodyUsage?.cache_read_input_tokens ??
    parseInt(
      headers?.get('x-anthropic-cache-read-input-tokens') ||
        headers?.get('x-anthropic-cache-read-tokens') ||
        '0',
      10,
    )
  const cacheWrite =
    bodyUsage?.cache_creation_input_tokens ??
    parseInt(
      headers?.get('x-anthropic-cache-creation-input-tokens') ||
        headers?.get('x-anthropic-cache-creation-tokens') ||
        '0',
      10,
    )

  return recordRequestUsage({
    accountEmail,
    model,
    inputTokens: inTokens,
    outputTokens: outTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    durationMs,
    statusCode,
    agent: extra?.agent || 'opencode',
    sessionId: extra?.sessionId,
    messageId: extra?.messageId,
  })
}
