import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Host SDK packages whose bare specifier a Pi host rewrites.
 *
 * A pi extension is loaded through the host's extension loader, which serves
 * these specifiers from the host's own bundled compatibility surface rather than
 * the `@earendil-works/*` version the extension was built against. Oh My Pi
 * answers them with its `@oh-my-pi/pi-ai` fork plus `legacy-pi-ai-shim.ts`, and
 * that fork has no transcript-replay helpers, so importing them at runtime threw
 * `Export named 'collapseSystemMessages' not found in module
 * 'omp-legacy-pi-bundled:@oh-my-pi/pi-ai'` while the extension loaded and no
 * request was ever built (v1.23.0).
 *
 * Type-only imports are safe, because TypeScript erases them, so this checks the
 * shipped JavaScript. Anything a host might not publish is ported locally
 * instead (packages/pi/src/transcript.ts).
 */
const HOST_PI_PACKAGE = /^@(?:earendil-works|oh-my-pi|mariozechner)\/(.+)$/

/**
 * Host runtime imports this extension relies on, and why each cannot be ported:
 * the object must be the host's own, or must match the host's own accounting.
 * Reviewed against the host's legacy compat surface, not against
 * `@earendil-works/pi-ai` — the two have already diverged once.
 */
const ALLOWED_HOST_RUNTIME_IMPORTS: Record<string, readonly string[]> = {
  '@oh-my-pi/pi-ai': [
    // The stream handed back to the host must be the host's event-stream class.
    'createAssistantMessageEventStream',
    // Costs must use the host's pricing so its usage reporting agrees.
    'calculateCost',
  ],
}

/** Names in one emitted `import { … }` clause, ignoring re-aliasing. */
function clauseNames(clause: string): string[] {
  return clause
    .split(',')
    .map((entry) => entry.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((entry) => entry.split(/\s+as\s+/)[0]?.trim() ?? '')
}

/**
 * Names one host specifier is imported for, or `undefined` when the statement is
 * not a named-import clause. The specifier comes from Bun's scanner, so comment
 * and string text can never reach here.
 */
function hostImportNames(
  source: string,
  specifier: string,
): string[] | undefined {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const named = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escaped}['"]`,
  ).exec(source)
  if (named?.[1] !== undefined) return clauseNames(named[1])
  return new RegExp(`import\\s+[^'";]+from\\s*['"]${escaped}['"]`).test(source)
    ? undefined
    : []
}

export async function verifyPiDistRuntimeImports(): Promise<string> {
  const distRoot = join(import.meta.dir, '..', 'packages', 'pi', 'dist')
  let files: string[]
  try {
    files = (await readdir(distRoot, { recursive: true }))
      .filter((entry) => entry.endsWith('.js'))
      .map((entry) => join(distRoot, entry))
  } catch {
    throw new Error(
      `Missing ${relative(process.cwd(), distRoot)}: run \`bun run build\` first`,
    )
  }

  const transpiler = new Bun.Transpiler({ loader: 'js' })
  const findings: string[] = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const origin = relative(distRoot, file)
    for (const { path: specifier } of transpiler.scanImports(source)) {
      const matched = HOST_PI_PACKAGE.exec(specifier)
      if (!matched) continue
      const canonical = `@oh-my-pi/${matched[1]}`
      const allowed = ALLOWED_HOST_RUNTIME_IMPORTS[canonical]
      if (!allowed) {
        findings.push(
          `${origin}: runtime import from '${specifier}' — port what is needed locally (see packages/pi/src/transcript.ts)`,
        )
        continue
      }
      const names = hostImportNames(source, specifier)
      if (!names) {
        findings.push(
          `${origin}: '${specifier}' must be imported only by name, not as a namespace or default`,
        )
        continue
      }
      for (const name of names) {
        if (!allowed.includes(name)) {
          findings.push(
            `${origin}: '${specifier}' exports '${name}' to this build, but the host's compat surface is not guaranteed to`,
          )
        }
      }
      if (names.length === 0) {
        findings.push(
          `${origin}: side-effect import of '${specifier}' loads the host's copy`,
        )
      }
    }
  }

  if (findings.length > 0) {
    throw new Error(
      `Pi extension reaches into host SDK packages at runtime:\n${findings
        .map((finding) => `  ${finding}`)
        .join('\n')}`,
    )
  }
  return `packages/pi/dist: ${files.length} files, host runtime imports held to the reviewed compat surface`
}

if (import.meta.main) {
  try {
    console.log(await verifyPiDistRuntimeImports())
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
