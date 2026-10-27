import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { type WriterStamp, writerStamp } from '@cortexkit/anthropic-auth-core'

export interface PortFileEntry {
  port: number
  token: string
  pid: number
  startedAt: number
  /**
   * Present in files written by 2.3.0 and later, so a later version can tell
   * them from files of older versions. Older readers ignore it.
   */
  writer?: WriterStamp
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function writePortFile(
  dir: string,
  entry: { port: number; token: string; pid: number },
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const full: PortFileEntry = {
    ...entry,
    startedAt: Date.now(),
    writer: writerStamp(),
  }
  const target = join(dir, `port-${entry.pid}.json`)
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(full), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, target)
  return target
}

export async function discoverPortFile(
  dir: string,
  expectedPid?: number,
): Promise<PortFileEntry | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const live: PortFileEntry[] = []
  for (const name of names) {
    if (!name.startsWith('port-') || !name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(
        await readFile(join(dir, name), 'utf8'),
      ) as PortFileEntry
      if (Number.isFinite(parsed.port)) {
        if (pidAlive(parsed.pid)) live.push(parsed)
        else unlink(join(dir, name)).catch(() => {})
      }
    } catch {}
  }
  if (live.length === 0) return null
  const candidates =
    expectedPid && expectedPid >= 1
      ? live.filter((entry) => entry.pid === expectedPid)
      : []
  const entries = candidates.length > 0 ? candidates : live
  return entries.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
}
