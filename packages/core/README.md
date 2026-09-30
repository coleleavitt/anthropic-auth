# @cortexkit/anthropic-auth-core

Shared Anthropic OAuth/WIF lifecycle, localhost callback, native secure-credential discovery, Rust-compatible account store, persistent device identity, trusted-device/attestation/Cowork protocols, quota, routing, cache, relay, dump, and exact Claude Code 2.1.233 request-signing helpers used by CortexKit's OpenCode and Pi integrations.

## Account store (Rust binding)

The shared account store `~/.anthropic-accounts/accounts.json` (override with `ANTHROPIC_ACCOUNTS_FILE` or `ANTHROPIC_ACCOUNTS_DIR`) is owned by the Rust `anthropic` crate through its Node-API binding `@coleleavitt/anthropic-napi`. Listing, selection, refresh (claimed, compare-and-swap, fail-closed), dead-token bookkeeping, keep-alive, the login code exchange and the one-time import of host-held credentials all happen in Rust; **refresh tokens never reach JavaScript**. The host files (`anthropic-auth.json`, `anthropic-auth-state.json`) carry no OAuth token: older token-bearing files are imported into the store once by `loadAccounts` (the store's copy wins) and rewritten without tokens.

The binding is a local `file:` dependency for now. Build it before `bun install`:

```sh
cd ~/RustProjects/active/anthropic/anthropic-napi
node scripts/build.mjs          # plain cargo on the pinned rustc-master toolchain
cd ~/WebstormProjects/forks/anthropic-auth-core-on-rust
bun install                     # copies the package (with the .node file)
```

Bun copies a `file:` directory dependency, so after rebuilding the addon re-run `bun install --force` (or remove `node_modules/@coleleavitt` in the packages) to pick up the new `.node`. Publishing would need per-platform prebuilt addons (`anthropic-napi.<platform>-<arch>.node`, e.g. `optionalDependencies` per target like napi-rs does) and a registry version instead of the `file:` path.

Tests point the binding at a temp store and a mock token endpoint (`ANTHROPIC_OAUTH_TOKEN_URL`; see `src/tests/support/store-fixture.ts`) and always run through `scripts/test-isolated.ts` with a sandbox HOME.

`device.json` stores only the global 32-byte installation ID. Trusted-device tokens and Cowork private keys use auxiliary secure stores and never enter account JSON. Native Claude discovery checks its platform secure store before the private `~/.claude/.credentials.json` fallback, but copying into the shared store is always explicit. Custom proxy routes remain integration-specific because the shared schema does not carry endpoint metadata.

User-facing packages:

- `@cortexkit/opencode-anthropic-auth` for OpenCode
- `@cortexkit/pi-anthropic-auth` for Pi
