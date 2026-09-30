# @cortexkit/anthropic-auth-core

Shared Anthropic OAuth/WIF lifecycle, localhost callback, native secure-credential discovery, Rust-compatible account store, persistent device identity, trusted-device/attestation/Cowork protocols, quota, routing, cache, relay, dump, and exact Claude Code 2.1.233 request-signing helpers used by CortexKit's OpenCode and Pi integrations.

## Account store (Rust binding)

The shared account store `~/.anthropic-accounts/accounts.json` (override with `ANTHROPIC_ACCOUNTS_FILE` or `ANTHROPIC_ACCOUNTS_DIR`) is owned by the Rust `anthropic` crate through its Node-API binding `@coleleavitt/anthropic-napi`. Listing, selection, refresh (claimed, compare-and-swap, fail-closed), dead-token bookkeeping, keep-alive, login (including the non-persisting Console exchange), revoke, API-key rows, legacy-store adoption (`~/.grok`, `~/.config/jfc`, … for the default store), identity backfill and the one-time import of host-held credentials all happen in Rust; **refresh tokens never reach JavaScript**, and store API keys come back only from `getSharedApiKey` (listings show their last four characters). The host files (`anthropic-auth.json`, `anthropic-auth-state.json`) carry no OAuth token and no store API key: older token-bearing files are imported into the store once by `loadAccounts` (the store's copy wins) and rewritten without tokens.

**Claude Code stays logged in.** When the store refreshes a token that Claude Code's `.credentials.json` still holds (the login came from `import-native`, or both sides share a grant), the binding writes the rotation back into that file: only while it holds exactly the spent token, never creating it, never over an unparseable file, keeping every other field, `0600` via temp file and rename, under Claude Code's own `.storage-write.lock`. It is on by default; `ANTHROPIC_NATIVE_PUBLISH=0` turns it off. A keychain-backed (macOS) Claude Code credential cannot be published back.

Binding errors are `AnthropicAuthError` with `code` one of `auth_required`, `quota_reserve`, `invalid_grant`, `config`, `invalid_token` (a token or key passed in is malformed), `store_corrupt` (the store is not valid JSON, is a symlink, …) or `transient`.

The binding is a local `file:` dependency for now. Build it before `bun install`:

```sh
cd ~/RustProjects/active/anthropic/anthropic-napi
node scripts/build.mjs          # plain cargo on the pinned rustc-master toolchain
cd ~/WebstormProjects/forks/anthropic-auth-core-on-rust
bun install --force             # copies the package (with the .node file)
```

Bun copies a `file:` directory dependency, so after rebuilding the addon re-run `bun install --force` (or remove `node_modules/@coleleavitt` in the packages) to pick up the new `.node`. Publishing would need per-platform prebuilt addons (`anthropic-napi.<platform>-<arch>.node`, e.g. `optionalDependencies` per target like napi-rs does) and a registry version instead of the `file:` path; see the binding's README.

Tests point the binding at a temp store and local mock endpoints (`ANTHROPIC_OAUTH_TOKEN_URL`, `ANTHROPIC_OAUTH_REVOKE_URL`, `ANTHROPIC_OAUTH_PROFILE_URL`; see `src/tests/support/store-fixture.ts`) and always run through `scripts/test-isolated.ts` with a sandbox HOME. In OAuth test mode the binding never resolves Claude Code's real credential file; tests name a temp one explicitly.

`device.json` stores only the global 32-byte installation ID. Trusted-device tokens and Cowork private keys use auxiliary secure stores and never enter account JSON. Native Claude discovery checks its platform secure store before the private `~/.claude/.credentials.json` fallback, but copying into the shared store is always explicit. Custom proxy routes remain integration-specific because the shared schema does not carry endpoint metadata.

User-facing packages:

- `@cortexkit/opencode-anthropic-auth` for OpenCode
- `@cortexkit/pi-anthropic-auth` for Pi
