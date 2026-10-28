import { resolve } from 'node:path'
import {
  disposableCommandError,
  installPackedHosts,
  packedHostNpmCache,
} from '../src/tests/support/packed-host-install'
import { packedHostVersions } from '../src/tests/support/packed-host-versions'

if (process.argv[2] === '--version-key') {
  console.log(`oc1-${packedHostVersions.oc1}-oc2-${packedHostVersions.oc2}`)
} else {
  const destination = process.argv[2]
  if (!destination)
    throw new Error('Usage: bun install-packed-hosts.ts <directory>')
  const root = resolve(destination)
  const password = 'packed-host-install-disposable-only'
  const started = performance.now()
  await installPackedHosts(root, {
    path: process.env.PATH ?? '',
    password,
    npmCache: packedHostNpmCache(resolve(import.meta.dir, '../../..')),
    async run(args, cwd, env, phase) {
      console.log(`[packed-hosts] ${phase}: ${args.join(' ')}`)
      const child = Bun.spawn(args, {
        cwd,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      process.stdout.write(stdout)
      process.stderr.write(stderr)
      if (exit !== 0)
        throw disposableCommandError(
          args,
          { stdout, stderr, exit, timedOut: false },
          (text) => text.replaceAll(password, '[redacted]'),
        )
      return { stdout }
    },
  })
  console.log(
    `[packed-hosts] Installed and verified both hosts in ${Math.round(performance.now() - started)}ms: ${root}`,
  )
}
