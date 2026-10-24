# OpenCode 2

OpenCode 1 and OpenCode 2 use the same native account pool for a given OpenCode configuration. OpenCode 2 uses a registered provider source rather than the OpenCode 1 fetch wrapper. Pi has its own pool and enrollment authority.

## Empty initialization

Stop every OpenCode, LiteCode and Pi process, then run:

```sh
npx @cortexkit/opencode-anthropic-auth setup --yes --opencode=2
```

Without `--login`, generation-2-only local setup registers the main OpenCode config and initializes an empty native account pool, or reuses matching completed setup. A version-5 `empty-init` journal records that the pool is ready for sign-in. Setup does not read or write OpenCode 1's auth file, install an OpenCode 1 placeholder, create an OpenCode 2 connection, or access an OpenCode database.

Setup initializes storage; model access requires a separate connection step:

1. Start OpenCode's registered pool login:

   ```sh
   opencode auth login anthropic --method native-claude-oauth
   ```

   In the TUI, choose Anthropic's **Claude Pro / Max (native account pool)** login method. If Anthropic is already connected, use **Add account** to choose this method.

2. Complete the browser sign-in and paste the returned code. This saves the account as the pool's main account and creates OpenCode's plugin connection.
3. Select an `anthropic/` model and send a short message to verify model access.
4. Add other subscription accounts through `/claude` → **Accounts** → **Start OAuth sign-in**, then **Finish OAuth sign-in**. Use **View status** to see the main account, fallbacks, and enabled/disabled states.

**Do the provider connection before adding fallback accounts.** Signing in through `/claude` only adds an account to the pool. It does not select the plugin's login method or replace an existing OpenCode Anthropic connection. Quota refresh can succeed while model requests still use that separate connection.

The registered provider login verifies the Claude account identity and commits its credentials to the native pool. Only a fixed, non-secret plugin marker is returned to OpenCode through the host API. Requests carrying that marker use the pool; other OpenCode credentials pass through unchanged. Startup never replaces an existing connection automatically. See [connection troubleshooting](troubleshooting.md#quota-refresh-works-but-anthropic-model-requests-fail-in-opencode-2) if model access still fails.

Fresh initialization writes the journal and main config, not the TUI sidebar config or legacy account/state/routing sidecars. A rerun preserves existing pool and journal bytes, including accounts added later. Conflicting files or unfinished migrations refuse instead of being overwritten; see [recovery](releases.md#upgrade-and-recovery).

## Setup login and host selection

`setup --login` is an explicit OpenCode 1/Pi sign-in, not an OpenCode 2 login:

- `--login --opencode=2` exits 1 before the runner, prints the pool-login step above and writes nothing, on both real and dry runs.
- A real run that detects or interactively chooses generation 2 alone also refuses `--login` in the first preflight, before any selected host writes. If Pi is selected too, Pi does not proceed alone.
- A dry run without the explicit `--opencode=2` argument invokes no callbacks: it can print `Would sign in locally for opencode.` and exit 0 even when a real run would refuse.
- `--login --claustrum` is separately refused: local sign-in and vault setup are different choices.

`--yes` (or `-y`) selects every detected host. There is no host-exclusion flag. On a machine with OpenCode 2 and Pi, a noninteractive `--login` cannot select Pi alone; use interactive host deselection to choose Pi without OpenCode. `--opencode=2` selects the OpenCode generation, not the host list. Stored Pi auth still requires explicit consent; `--yes` is not consent to remove it.

## Both OpenCode generations

`--opencode=both` runs OpenCode 1 migration first, then reuses that pool for OpenCode 2. There is one OpenCode journal and, with `--login`, one login commit. Even with no legacy accounts, this is a completed legacy migration rather than empty initialization. The generation-2 pool-login instruction is not printed for `both`.

Shared registration writes the main and TUI sidebar configs for generation 1 or `both`; generation 2 alone writes only the main config. No selection opens an OpenCode database. Generation 1 and `both` may open the OpenCode 1 auth file for migration; that exception does not apply to generation 2 alone.

## Later OpenCode 1 use and routing

Empty initialization still allows a later OpenCode 1 import while the pool has no account data. Once populated, setup preserves native credentials rather than merging a separate OpenCode login. See [local migration](custody-state-machine.md#migration) for preservation and skip rules.

OpenCode 1 and 2 share the [local routing file](accounts-and-routing.md#local-storage): with empty initialization, use `OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE` when set, otherwise the pool-config-derived `anthropic-auth-pool-routing-state.json`.

Version-5 journals have no rollback path. Do not delete or rewrite a journal to make an older release accept it; see [upgrade and recovery](releases.md#upgrade-and-recovery).

## Quota sidebar

The TUI adds the CLAUDE quota panel to the session sidebar and polls the server's `sidebar` RPC method at the preference poll interval. See [sidebar](sidebar.md#quota-sidebar). Quota readings refresh in the background once the location has served a request; before that, persisted readings are shown with their age.

## Vault and transport boundaries

Generation-2 vault setup also leaves OpenCode 1 auth and all OpenCode databases untouched. In an enrolled host, choose **Claude vault accounts**, not the local-pool login. The vault and local-pool login methods both return only the non-secret marker; startup creates neither connection automatically. Enrollment, not account settings, selects custody. See [vault setup](vault.md#setup) and [custody gates](custody-state-machine.md#opencode-2).

OpenCode 2 supports direct and HTTP relay requests. WebSocket relay is refused before dispatch; select HTTP or direct in [transport settings](transports.md#relay).

## Dependency ownership

The setup CLI lives in `@cortexkit/opencode-anthropic-auth`. Shared detection, generation choice, stopped-host safety checks, registration and enrollment come from `@cortexkit/common-auth`, which remains a devDependency of `@cortexkit/anthropic-auth-core` (Core) bundled into Core's dist. The CLI imports the shared runner through Core's bundle and gains no new runtime common-auth dependency. Anthropic callbacks own identity verification, native migration, Pi consent and vault activation.

The plugin never uses tokens from a separate OpenCode 1 login. The [OpenCode 1 admission table](custody-state-machine.md#opencode-1) describes when that login can coexist with native serving.
