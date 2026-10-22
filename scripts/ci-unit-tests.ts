import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const unitJobs = [
  { suite: 'core', shard: '1/1' },
  // OpenCode took 427s versus Core's 123s; four stable Bun file shards keep it off the critical path.
  ...['1/4', '2/4', '3/4', '4/4'].map((shard) => ({
    suite: 'opencode',
    shard,
  })),
  { suite: 'opencode', shard: 'miniflare' },
  { suite: 'pi', shard: '1/1' },
] as const

type UnitJob = (typeof unitJobs)[number]
type Counts = Record<'core' | 'opencode' | 'pi', number>

export function reportName(job: UnitJob): string {
  return `${job.suite}-${job.shard.replace('/', '-of-')}.json`
}

export function parseTestCount(suite: string, output: string): number {
  const match = output.match(/^\s*(\d+) pass\s*$/m)
  if (!match) throw new Error(`could not parse ${suite} test count`)
  const count = Number(match[1])
  if (!Number.isSafeInteger(count))
    throw new Error(`could not parse ${suite} test count`)
  return count
}

export async function collectUnitCounts(directory: string): Promise<Counts> {
  const names = (await readdir(directory)).sort()
  const expected = unitJobs.map(reportName).sort()
  if (names.join(',') !== expected.join(',')) {
    throw new Error(
      `unit count reports must contain exactly: ${expected.join(', ')}`,
    )
  }
  const counts: Counts = { core: 0, opencode: 0, pi: 0 }
  for (const job of unitJobs) {
    const path = join(directory, reportName(job))
    let report: unknown
    try {
      report = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      throw new Error(`${path}: missing or invalid unit count report`)
    }
    const value = report as Record<string, unknown> | null
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'count,shard,suite' ||
      value.suite !== job.suite ||
      value.shard !== job.shard ||
      typeof value.count !== 'number' ||
      !Number.isSafeInteger(value.count) ||
      value.count < 0
    ) {
      throw new Error(`${path}: invalid unit count report`)
    }
    const suite = job.suite as keyof Counts
    counts[suite] += value.count
    if (!Number.isSafeInteger(counts[suite]))
      throw new Error(`${suite}: unit count total is not a safe integer`)
  }
  return counts
}

async function main(args: string[]) {
  const options: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (
      !['--suite', '--shard', '--output-dir'].includes(flag ?? '') ||
      !value ||
      value.startsWith('--') ||
      options[flag as string] !== undefined
    ) {
      throw new Error('expected --suite, --shard and --output-dir once each')
    }
    options[flag as string] = value
  }
  const job = unitJobs.find(
    (entry) =>
      entry.suite === options['--suite'] && entry.shard === options['--shard'],
  )
  const directory = options['--output-dir']
  if (!job || !directory)
    throw new Error('invalid unit suite/shard or output directory')

  const miniflare = 'src/tests/relay-worker-miniflare.test.ts'
  const command = [
    'bun',
    'test',
    job.shard === 'miniflare' ? `./${miniflare}` : 'src/tests',
  ]
  if (job.shard !== '1/1' && job.shard !== 'miniflare') {
    command.push(`--shard=${job.shard}`)
    // The sidebar rendering tests lost subprocess pipes or hung on child exit
    // when run alongside Miniflare. Keep Miniflare in a separate process.
    command.push(`--path-ignore-patterns=${miniflare}`)
  }
  console.log(`MEASURE: ${job.suite} shard=${job.shard}`)
  const result = Bun.spawnSync(command, {
    cwd: join('packages', job.suite),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`
  process.stdout.write(output)
  if (result.exitCode !== 0)
    throw new Error(`${job.suite} test command exited ${result.exitCode}`)
  const count = parseTestCount(job.suite, output)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, reportName(job)),
    `${JSON.stringify({ ...job, count })}\n`,
  )
  console.log(`MEASURED: ${job.suite} ${count} shard=${job.shard}`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
}
