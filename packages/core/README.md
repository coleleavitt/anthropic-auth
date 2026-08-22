# @cortexkit/anthropic-auth-core

Shared Anthropic OAuth/WIF lifecycle, localhost callback, native secure-credential discovery, Rust-compatible account store, persistent device identity, trusted-device/attestation/Cowork protocols, quota, routing, cache, relay, dump, and exact Claude Code 2.1.233 request-signing helpers used by CortexKit's OpenCode and Pi integrations.

The canonical credential adapter reads and writes `~/.anthropic-accounts/accounts.json` (override with `ANTHROPIC_ACCOUNTS_FILE` or `ANTHROPIC_ACCOUNTS_DIR`). OAuth includes optional `refresh_expires_at`; rotations use locked compare-and-swap. `device.json` stores only the global 32-byte installation ID. Trusted-device tokens and Cowork private keys use auxiliary secure stores and never enter account JSON. Native Claude discovery checks its platform secure store before the private `~/.claude/.credentials.json` fallback, but copying into the shared store is always explicit. Custom proxy routes remain integration-specific because the shared schema does not carry endpoint metadata.

User-facing packages:

- `@cortexkit/opencode-anthropic-auth` for OpenCode
- `@cortexkit/pi-anthropic-auth` for Pi
