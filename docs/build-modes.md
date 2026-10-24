# Build modes

The OpenCode package has a bundled deployment build and an unbundled development build. Run package-specific commands from the repository root:

```sh
bun run --cwd packages/opencode build
bun run --cwd packages/opencode build:dev
```

`build` uses Bun to bundle the OpenCode adapter and its shared host helpers into split `dist/` output, emits declarations, compiles the TUI and checks bundle globals. Core resolves from its installed `dist` rather than being bundled again. The OpenCode 1/2 plugin peers, `jsonc-parser`, `xxhash-wasm`, and the private-files, Claustrum and Subconscious client packages remain external so their resource and IPC loaders keep their package-relative paths. Preserve normal package installation and host module resolution.

`build:dev` emits individual JavaScript/declaration files with TypeScript and requires workspace dependencies. Build Core first when its source changes. For the full ordered Core/OpenCode/Pi build, use root `bun run build`; the root does not define a `build:dev` script.

## Local OpenCode workflow

OpenCode 2 resolves a local directory by looking for `server.js` or `index.js` and `tui.js`. It does not use the package's `exports` map for that directory. Pointing at `packages/opencode` alone silently omits the plugin because those files live elsewhere in this repository.

Build Core and OpenCode, then create a local wrapper directory from the repository root:

```sh
bun run --cwd packages/core build
bun run --cwd packages/opencode build
mkdir -p .opencode/local-anthropic-auth
printf '%s\n' 'export { default } from "../../packages/opencode/dist/v2/server.js"' > .opencode/local-anthropic-auth/server.js
printf '%s\n' 'export { default } from "../../packages/opencode/src/tui/entry.mjs"' > .opencode/local-anthropic-auth/tui.js
```

The TUI wrapper uses the full entrypoint, which adds the sidebar and sign-in link dialog. The `.opencode` directory is ignored by git. These shell commands work in Bash on Linux and macOS; on Windows, use Git Bash or create the two files with the same contents in your editor.

Point a disposable OpenCode 2 configuration at the wrapper directory:

```json
{
  "plugins": ["file:///path/to/anthropic-auth/.opencode/local-anthropic-auth"]
}
```

Substitute your checkout path (on Windows, include the drive letter, such as `file:///C:/path/to/anthropic-auth/.opencode/local-anthropic-auth`). Restart the server and TUI after changing the configuration. Rebuild after source changes. Use a disposable account pool when testing setup or migration.

For OpenCode 1, the root helper provides the local development loop:

```sh
bun run dev
bun run dev:clean
```

`dev` builds, symlinks output under `.opencode/plugins/` and starts TypeScript watch mode. Restart OpenCode after starting it and after rebuilds. `dev:clean` removes the development symlink.

## Package inspection

```sh
bun run pack:core:dry
bun run pack:opencode:dry
bun run pack:pi:dry
bun run --cwd packages/opencode smoke:tui
```

The dry pack commands inspect package contents without publishing. TUI smoke validates packed host renderer resolution and standalone CLI startup. See [development verification](development.md#verification) for test/typecheck/lint gates and fixture isolation, and [release workflow](releases.md#maintainer-release-workflow) for publication policy.

Implementation: [OpenCode scripts and externals](../packages/opencode/package.json), [workspace scripts](../package.json), [development helper](../scripts/dev.ts), and [TUI build](../packages/opencode/scripts/build-tui.ts).
