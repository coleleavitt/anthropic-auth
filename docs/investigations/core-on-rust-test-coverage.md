# core-on-rust: coverage map for removed tests

Branch `core-on-rust` (base `33f12b2`) moved the account store, refresh, claims, dead-token
handling, keep-alive and the login token exchange into the Rust crate `anthropic`
(`/home/cole/RustProjects/active/anthropic`, binding `anthropic-napi`, commit `cac8357`). The
binding gaps listed in the first version of this map were then closed on the crate's
`binding-gaps` branch (commits `bd627a1`..`d43ee6c`): Claude Code credential publish and
import, revoke, API-key rows, legacy adoption, per-login redirect/state, a non-persisting code
exchange, identity backfill and the `invalid_token` / `store_corrupt` error codes. Crate file
names below are relative to `src/`; binding tests are `anthropic-napi/test/*.test.ts` (**N**).
This file maps every test case removed from `*.test.ts` (`git diff 33f12b2 --numstat -- '*.test.ts'`)
to one of:

- **R** `file::test_name`: a Rust test (at `cac8357`, or on `binding-gaps`) covering the same behaviour;
- **N** `file > test name`: a binding test (`anthropic-napi/test/`), run with `bun test test/`;
- **T** `file > test name`: a TS test on this branch covering it through the binding;
- **X**: the behaviour no longer exists, with the reason.

No test was skipped, `.todo`-ed or disabled. No surviving assertion was loosened (see the end).

Abbreviations for Rust files are relative to `src/`. TS files are relative to `packages/`.

## core/src/tests/refresh-contention.test.ts (deleted, 19 cases)

| removed case | coverage |
|---|---|
| concurrent claimants: exactly one wins | R `refresh_claim.rs::first_caller_claims_and_second_is_told_to_wait`; T `core/src/tests/store-refresh.test.ts > concurrent callers in one process share one refresh` and `> a separate process racing for the same expired account does not spend it twice` (one POST across two processes) |
| the loser learns which process holds the claim | R `refresh_claim.rs::first_caller_claims_and_second_is_told_to_wait` (holder reported); TS no longer sees claims (X for the TS surface) |
| the claim is visible to a separate reader of the same store | R `refresh_claim.rs::claim_survives_a_write_so_another_process_sees_it` |
| the lease records a fingerprint, never the token | R `refresh_claim.rs` (`// The lease records a fingerprint, never the token.` assertion at l.510-513); R `refresh.rs::shared_receipts_carry_only_fingerprints` |
| claims on different accounts do not block each other | T `core/src/tests/shared-account-store.test.ts > refreshes of different accounts do not block each other` (added for this map) |
| a caller holding a spent token is handed the winner, never a retry | R `refresh_claim.rs::spent_token_is_handed_the_winner_and_expired_claim_can_be_taken_over`; R `refresh.rs::a_stale_caller_token_is_never_spent_the_stores_token_is`, `refresh.rs::unknown_token_adopts_a_live_rotated_shared_credential` |
| a crashed holder does not wedge the account forever | R `refresh_claim.rs::spent_token_is_handed_the_winner_and_expired_claim_can_be_taken_over`; R `store.rs::stale_cross_language_lease_is_recovered` |
| releasing hands the claim to the next caller immediately | R `refresh.rs::refresh_persists_rotation_to_the_shared_store_and_releases_the_lease` |
| a stale lease id cannot release the live holder | R `refresh_claim.rs::release_requires_the_live_lease_id` |
| a serialised burst yields one spend per rotation, never two | T `store-refresh.test.ts > concurrent callers in one process share one refresh`; R `keepalive.rs::two_concurrent_passes_do_the_work_once` |
| a marked token short-circuits before the network | R `refresh_claim.rs::dead_token_short_circuits_and_is_scoped_to_the_token`; T `shared-account-store.test.ts > a dead refresh token is reported once and never re-presented` |
| the verdict survives a reload, so a restart does not retry it | R `refresh.rs::invalid_grant_is_remembered_and_never_re_presented`; T `store-refresh.test.ts > a dead token is excluded from routing and never re-presented` (re-reads the store from disk: `refreshDead` persisted) |
| a later rotation does not inherit its predecessor's verdict | R `account.rs::an_error_is_bound_to_the_token_it_was_recorded_against`, `account.rs::a_stale_unbound_invalid_grant_flag_clears_itself`, `store.rs::replace_after_refresh_clears_everything_bound_to_the_old_token` |
| marking only applies to the token the account still holds | R `refresh.rs::invalid_grant_on_a_token_the_store_no_longer_holds_marks_nothing`, `refresh_claim.rs::the_dead_verdict_error_is_bound_to_the_dead_token` |
| marking clears any claim the dead attempt was holding | R `refresh_claim.rs::marking_dead_clears_the_claim_it_was_holding` |
| a reading lands only on the account it was taken from | R `refresh_claim.rs::quota_lands_only_on_the_account_it_was_taken_from`, `refresh_claim.rs::a_normalized_header_snapshot_lands_on_its_bearer_account` |
| an exhausted account does not make its neighbours unselectable | T `shared-account-store.test.ts > an exhausted account neither strands its neighbours nor keeps the pin` (added) |
| syncing prevents the next pass re-presenting the old token | X: the TS sync (`syncRefreshedFallbackAccountInSharedStore`) is deleted; the store commits its own rotation. R `refresh.rs::refresh_persists_rotation_to_the_shared_store_and_releases_the_lease`; T `shared-account-store.test.ts > an expired token is refreshed once, in Rust, and the rotation is stored` |
| a sync from a stale holder does not clobber a newer rotation | R `store.rs::refresh_compare_and_swap_never_overwrites_a_newer_rotation`, `refresh_claim.rs::commit_is_fenced_on_the_lease_and_the_presented_token`, `refresh_claim.rs::a_result_obtained_under_a_lapsed_claim_is_never_committed` |

## core/src/tests/native-claude-publish.test.ts (9 cases; deleted with the helpers)

The publish now happens **in Rust, inside the refresh commit path**
(`OAuthClient::refresh_shared`, step 7): after a rotation the process committed, Claude Code's
`.credentials.json` is rewritten only when it still holds exactly the spent refresh token, under
Claude Code's own `proper-lockfile` credential-write lock (`<config dir>/.storage-write.lock`,
stale 15 s; Claude Code 2.1.285). TypeScript never holds a refresh token, so the TS helpers
`publishNativeClaudeOAuth` / `readNativeClaudeOAuth` had no caller and were deleted with their
test file. `readNativeClaudeOAuth`'s role (for `import-native`) is the binding's non-secret
`readNativeClaudeOAuth` (TS `readNativeClaudeStatus`).

| removed case | coverage |
|---|---|
| publishes a rotation so Claude Code stops holding a dead token | R `credentials/publish.rs::publishes_a_rotation_so_claude_code_stops_holding_a_dead_token`, `refresh.rs::a_rotation_is_published_to_claude_code_when_it_held_the_spent_token`; N `gaps.test.ts > a store refresh of the token Claude Code holds is published to its file`; T `core/src/tests/shared-account-store.test.ts > a store refresh of the token Claude Code holds is published to its file` |
| preserves fields a refresh never returns | R `credentials/publish.rs::preserves_fields_a_refresh_never_returns` (also keeps a recorded `refreshTokenExpiresAt` a refresh omits, as Claude Code does) |
| preserves unknown top-level keys | R `credentials/publish.rs::preserves_unknown_top_level_keys_the_file_is_claude_codes`; N `gaps.test.ts > a store refresh … published to its file` (`mcpOAuth` kept) |
| keeps the file owner-only | R `credentials/publish.rs::keeps_the_file_owner_only_and_leaves_no_temp_or_lock_behind` (and the directory mode is not touched) |
| reports absent when there is no native install | R `credentials/publish.rs::reports_absent_and_never_creates_the_file` |
| refuses to clobber a file it cannot parse | R `credentials/publish.rs::refuses_to_clobber_a_file_it_cannot_parse` (outcome `Unparseable`, file byte-identical) |
| is a no-op when the native copy already holds this token | R `credentials/publish.rs::is_a_no_op_when_the_native_copy_already_holds_the_rotation` (content and mtime unchanged) |
| readNativeClaudeOAuth reads the credential Claude Code holds | R `credentials/publish.rs::reads_the_credential_claude_code_holds_without_its_tokens`; N `gaps.test.ts > import-native moves the tokens in Rust; later refreshes keep Claude Code alive` (`storeAccountId`) |
| readNativeClaudeOAuth returns null when absent or unreadable | R `credentials/publish.rs::summary_is_none_when_absent_and_an_error_when_unreadable`; N `gaps.test.ts > native read/import: absent, sandboxed in test mode, unusable files typed` (absent → `null`; unreadable → `store_corrupt`, a change: an unusable file is reported instead of looking absent) |

New rules the TS helper did not have, each tested in Rust: the file is written only when it
holds the **spent** token (`a_file_holding_another_token_is_left_alone`,
`refresh.rs::a_native_file_holding_another_token_is_never_rewritten`), a symlink is refused
(`refuses_a_symlinked_credential_file`), Claude Code's write lock is waited for and a stale one
taken over (`waits_for_claude_codes_write_lock_and_takes_over_a_stale_one`,
`a_lock_held_throughout_is_lock_busy_and_writes_nothing`), a failed refresh publishes nothing
(`refresh.rs::a_failed_refresh_publishes_nothing`), and the policy is off by `nativePublish:
'off'` / `ANTHROPIC_NATIVE_PUBLISH=0` and never resolves the real file in OAuth test mode
(`refresh.rs::the_publish_is_off_by_policy_and_auto_is_suppressed_in_test_mode`, N `gaps.test.ts
> a file holding another token, nativePublish off, or test mode without a path: untouched`,
`> outside test mode the default follows CLAUDE_CONFIG_DIR; ANTHROPIC_NATIVE_PUBLISH=0 turns it
off`).

## core/src/tests/shared-account-store.test.ts (41 removed, 15+5 new)

| removed case(s) | coverage |
|---|---|
| resolves explicit, file-env, then directory-env paths | kept (same test in the new file) |
| isolates OpenCode tests beside their temporary sidecar | T same name (restored in the new file) |
| round-trips the Rust-compatible OAuth and API-key schema | R `store.rs::save_then_load_roundtrips_normal`, `account.rs::oauth_account_roundtrips_through_json_normal`, `account.rs::unknown_row_and_credential_fields_survive_a_round_trip` |
| rejects malformed account entries; rejects non-finite expiries and non-RFC3339 timestamps | R `token.rs::oauth_tokens_roundtrip_epoch_millis`, `file_security.rs::json_errors_never_echo_document_text`; T `shared-account-store.test.ts > reports a malformed host credential as invalid instead of storing it` |
| upserts and disables accounts without exposing a second storage shape | R `store.rs::upsert_replaces_and_remove_clears_current_normal`; T `> pickSharedAccount prefers an available current row, else the first available` (enable/disable through the binding) |
| explicit account removal can persist a valid empty store | R `store.rs::explicit_final_account_removal_can_persist_an_empty_store`; T `> reorder and remove go through the store` |
| refuses unintentional empty writes and symlinked stores | R `store.rs::save_refuses_to_wipe_all_accounts_robust`, `store.rs::load_refuses_symlinked_store_robust`, `file_security.rs::atomic_private_write_is_user_only_and_refuses_symlinks`; T `> imports a host credential once and never returns a token` asserts mode 0600 |
| legacy flat schema: adopts / merges / keeps disabled with reason / drops rows without refresh / no duplicate / records adoption (no resurrection) / tolerates one unreadable row / same login from two legacy stores / email vs uuid / two organizations / row without organization / in-directory legacy filename | R `store.rs::load_or_migrate_adopts_the_flat_legacy_schema`, `…merges_legacy_beside_an_existing_canonical_account`, `…does_not_resurrect_a_removed_account`, `…deduplicates_a_login_seen_through_both_schemas`, `…does_not_admit_the_same_login_from_two_legacy_stores`, `identities_of_two_organizations_are_disjoint`, `legacy_store_paths_includes_the_in_directory_filename`, `a_scanned_legacy_file_is_recorded_even_when_every_row_was_skipped`; `legacy.rs::adopts_a_flat_legacy_row`, `keeps_a_disabled_row_disabled_with_its_reason`, `drops_a_row_without_a_refresh_token`, `never_imports_a_row_disabled_with_invalid_grant`, `redacts_a_token_bearing_legacy_error`. Adoption is back in the binding: for the default store it discovers the crate's legacy list from the host's `HOME`/`GROK_HOME` and persists what it adopts (`AccountStore::adopt_legacy`, append-only, `migrated_from`-guarded); R `store.rs::adopt_legacy_persists_new_rows_once_and_never_resurrects`, `adopt_legacy_creates_the_canonical_store_only_with_rows`, `legacy_paths_resolve_from_a_lookup`; N `gaps.test.ts > legacyPaths are adopted once, dead rows skipped, and served`, `> the default store discovers ~/.grok style files the way the crate does; others do not`; T `shared-account-store.test.ts > legacyPaths adopts a flat ~/.grok-style store once` |
| quota-aware rotation: skips weekly-exhausted / five-hour-exhausted, keeps headroom, ignores stale reading, ignores reading without timestamp, undefined when all exhausted | T `> an exhausted quota reading makes the row unavailable`, `> an exhausted five-hour window also makes the row unavailable`, `> an exhausted account neither strands its neighbours nor keeps the pin` (all-exhausted → undefined), `> a stale exhausted reading does not strand the account` (all added); R `access.rs::candidates_honour_allowlist_reserve_and_the_pin`, `store.rs::pick_skips_disabled_and_rate_limited_robust`. "no timestamp": the binding always stamps `checkedAt` (defaults to now), so a timestamp-less reading cannot be recorded (X) |
| a stored quota observation survives a write | R `store.rs::row_updates_preserve_every_field_they_do_not_own` |
| recordSharedAccountQuota clears a pin it just invalidated | T `> an exhausted account neither strands its neighbours nor keeps the pin` (the exhausted pin is not picked) |
| refresh claim (7 cases) | R `refresh_claim.rs::first_caller_claims_and_second_is_told_to_wait`, `spent_token_is_handed_the_winner_and_expired_claim_can_be_taken_over`, `release_requires_the_live_lease_id`, `claim_survives_a_write_so_another_process_sees_it`; "unknown account is reported": R `refresh.rs::held_claim_refuses_without_spending_and_unreadable_store_refuses`, T `test-network-guard.test.ts` / binding `auth_required` for unknown ids |
| explicit path never adopts home legacy stores / honours legacyPaths | N `gaps.test.ts > the default store discovers ~/.grok style files the way the crate does; others do not` (a non-default store adopts nothing unless `legacyPaths` lists files), `> legacyPaths are adopted once …`; R `store.rs::load_or_migrate_prefers_canonical_then_legacy_then_empty_normal` |
| upsert identity: re-login replaces uuid-keyed row / pin follows / different account added | R `store.rs::merge_login_updates_the_same_login_in_place`, `refresh_claim.rs::login_id_is_qualified_only_on_a_cross_organization_collision`; T `shared-account-store.test.ts > the store copy wins over a host copy of the same login`, `opencode/src/tests/cli.test.ts > re-login with the same label keeps the entry and drops legacy host tokens` |

## core/src/tests/shared-account-adapter.test.ts (11 removed, 6 new)

| removed case | coverage |
|---|---|
| migrates OAuth while retaining custom API routes in the sidecar | T `shared-account-adapter.test.ts > keeps the configured order and appends rows the host has never seen` (custom route kept); OAuth migration: T `legacy-token-migration.test.ts > imports a state-file token, follows the store id and scrubs both files` |
| preserves canonical OAuth metadata while syncing a fallback rotation; refresh sync rejects missing/disabled accounts | X: the TS row-rebuild sync is deleted (doc 23 root cause). R `store.rs::row_updates_preserve_every_field_they_do_not_own`, `store.rs::refresh_compare_and_swap_updates_top_level_email_from_token_metadata` |
| never attaches a canonical API key to colliding custom route metadata; refuses to flatten custom API routes into first-party credentials; defaults shared API-key accounts to x-api-key | T `shared-account-adapter.test.ts > never attaches a store key to a host route sharing its id; drops orphaned store-managed entries`, `> store api_key rows become first-party x-api-key routes managed by the store`, `> a store api_key row without a key handed out is not materialized`, `> recognises first-party API-key routes`. Store keys come from the binding's `getApiKey`, are `storeManaged` and are never written to the host files (T `opencode shared-auth.test.ts > store API keys are first-party fallbacks and never reach the host files`) |
| refuses to migrate legacy OAuth accounts without an expiry | X/changed: a host token without an expiry is imported as already expired (`expiresAt: 0`) so the store refreshes it on first use (R `legacy.rs::a_missing_expiry_reads_as_already_elapsed`) |
| backfillSharedAccountIdentities (4 cases) | The backfill is in Rust (`profile::backfill_store_identities`, binding `backfillIdentities`, TS `backfillSharedIdentities`): R `profile.rs::store_backfill::fills_unidentified_live_rows_and_never_refreshes` (filled / expired → skipped, never refreshed / already identified / not OAuth), `test_mode_never_contacts_a_production_profile_host`, `backfill_identifies_imported_rows_and_skips_the_rest`; N `gaps.test.ts > backfillIdentities fills live unidentified rows only; test mode guards production`, `> an anonymous grant is named from the profile endpoint`; T `shared-account-store.test.ts > backfill names an imported row from the profile endpoint without refreshing`. Imports and logins also fill the identity at once when the profile answers |

## core/src/tests/native-claude-credentials.test.ts (1 replaced)

"explicitly imports OAuth only into the shared schema" → T `> explicitly imports OAuth into the shared store through the binding` (same secrets-not-persisted assertions, plus no token in the listing) and `> refuses a native credential the store cannot parse`.

## opencode/src/tests/auth.test.ts (16 removed; file emptied)

| removed case | coverage |
|---|---|
| uses Anthropic platform JSON refresh path and preserves omitted refresh rotations | R `oauth.rs::token_request_serializes_grant_type_inline`, `oauth.rs::into_tokens_keeps_prior_refresh_when_absent`, `oauth.rs::into_tokens_takes_rotated_refresh_when_present` |
| preserves current refresh response metadata and refresh-token expiry; preserves a known refresh-token expiry when omitted | R `oauth.rs::into_tokens_persists_reported_refresh_expiry`, `store.rs::refresh_compare_and_swap_updates_top_level_email_from_token_metadata` |
| fails expired refresh tokens locally without contacting the endpoint | R `oauth.rs::refresh_expiry_fails_locally_and_is_permanent` |
| retries transient refresh failures; does not retry rate limits or invalid grants | R `refresh.rs::failure_classification`, `refresh.rs::only_a_400_invalid_grant_marks_the_token_dead`; T `core store-refresh.test.ts > a transient failure backs off instead of hammering the endpoint` |
| aborts the entire refresh within its deadline | R `oauth.rs::the_default_client_gives_up_before_the_refresh_claim_lapses`, `refresh.rs::a_stalled_token_call_is_cut_off_inside_the_claim_and_never_committed`, `refresh.rs::the_refresh_deadline_always_ends_inside_the_claim` |
| honors caller cancellation before the token endpoint settles | T `pi/src/tests/index.test.ts > honors the host abort signal before touching the store`; in-flight cancellation of a Rust refresh is not exposed (X; the deadline above bounds it) |
| prefers retry-after-ms for refresh and revoke failures; Retry-After seconds / HTTP date / missing / unparseable (4) | R `oauth.rs::retry_after_prefers_ms_then_seconds`, `oauth.rs::retry_after_is_clamped_to_a_day`; T `core/src/tests/retry-after.test.ts` (4 cases, ported onto `parseRetryAfterHeader/Seconds`, which the quota path still uses) |
| posts the exact native revocation request; treats invalid_grant as already inactive | R `oauth.rs::revoke_sends_exact_native_request`, `oauth.rs::revoke_treats_an_inactive_token_as_success`, `revoke.rs::revokes_the_stored_token_then_removes_the_row`, `an_already_inactive_token_counts_and_disable_records_it_dead`, `a_failed_revoke_changes_nothing_and_releases_the_claim`, `a_held_claim_refuses_without_sending_and_unknown_or_api_rows_are_refused`, `test_mode_refuses_a_production_revoke_before_sending`; N `gaps.test.ts > revokes at the (mock) revoke URL, then removes or disables the row`, `> a failed revoke changes nothing; unknown and API-key rows are refused`. The plugin's remote revoke is back on the binding (`revokeAccount`) |
| redacts a token echoed by an error response | R `token.rs::redact_secrets_hides_tokens_but_keeps_context`, `oauth.rs::oauth_wire_types_redact_all_secrets_from_debug`, `legacy.rs::redacts_a_token_bearing_legacy_error` |

## opencode/src/tests/accounts.test.ts (46 removed, 12 new)

| removed case(s) | coverage |
|---|---|
| runtime merge clears a fallback profile on rotation; prefers newer legacy config credentials; keeps newer runtime credentials; rotation never rebinds previous token quota; runtime token updates drop source-less quota | X: host files no longer hold tokens, so token-driven merges are gone. T `core legacy-token-migration.test.ts` (all 7) and `accounts.test.ts > a lastRefreshError never reaches the host files` |
| lease written via saveAccountState is visible to loadAccounts | X: the TS main lease is deleted |
| refreshes expired fallback tokens and persists rotation | T `accounts.test.ts > an expired fallback is refreshed by the store and no token reaches the host files`; `core store-refresh.test.ts > an expired fallback is refreshed on demand, once` |
| refreshes within the four-hour minimum window | X: the store refreshes an expired token; idle survival is the keep-alive (R `keepalive.rs::only_idle_accounts_near_expiry_or_without_access_are_due`) |
| retry count resets after rotation; backs off failed refreshes | T `accounts.test.ts > backs off a transient store failure instead of retrying every pass`; R `account.rs::an_error_is_bound_to_the_token_it_was_recorded_against` |
| preserves existing refresh token when response omits rotation | R `oauth.rs::into_tokens_keeps_prior_refresh_when_absent` |
| re-reads latest stored token before refreshing | R `refresh.rs::a_stale_caller_token_is_never_spent_the_stores_token_is` |
| serializes concurrent refreshes across manager instances | T `accounts.test.ts > concurrent managers spend an expired refresh token once (store claim)` |
| preserves a permanent classification across a concurrent join | T `accounts.test.ts > a dead refresh token is a permanent verdict and is never presented again` |
| starts an immediate background refresh pass for unused expired fallbacks | X (the deleted behaviour, doc 23 §4); replaced by T `> the keep-alive tick runs the store keep-alive and never refreshes an idle expired fallback`, `> startKeepAlive calls the store keep-alive on start and on its interval` |
| does not overwrite a concurrently refreshed token after quota fetch; persists rotation from background quota refresh | X: the host never persists tokens |
| refreshes fallback token and retries quota after stale 401 | T `accounts.test.ts > a quota 401 makes the store re-authorize the bearer and the quota check is retried`; core `store-refresh.test.ts > a quota 401 …` |
| returns refresh errors from explicit quota refresh | T `accounts.test.ts > explicit quota refresh does not spend a refresh token on an idle account` (changed: idle accounts are not refreshed for quota) |
| buildRefreshOperationError / isTransientRefreshError / retryAfter propagation / permanent classification / round-trip survival / backoff arming (27 cases) | X: the TS builder, classifier and persisted verdict are deleted. Classification: R `refresh.rs::failure_classification`, `refresh.rs::only_a_400_invalid_grant_marks_the_token_dead`, `oauth.rs::error_code_parses_both_shapes`, `oauth.rs::retry_after_prefers_ms_then_seconds`. Verdict mapping: T `accounts.test.ts > the store's dead-token verdict → permanent`, `> a store error on a live token → NOT permanent`, `> no store error → no verdict`; core `shared-account-adapter.test.ts > the store's dead-token verdict becomes a permanent refresh error`. Round-trip: verdicts are no longer persisted (T `> a lastRefreshError never reaches the host files`) |

## opencode/src/tests/index.test.ts (22 removed, 10 new)

| removed case(s) | coverage |
|---|---|
| dead (400 invalid_grant) fallback → needsReauth; transient 429 → not | T `> dead (store invalid_grant) fallback → needsReauth true`, `> transient store error on a fallback → needsReauth false` |
| canonical API-key cost semantics; loader switches to canonical API-key headers | T `shared-auth.test.ts > uses a store API key instead of stale host OAuth` (main `{type: 'api', source: 'shared'}`; `getSharedAnthropicAuthType` answers `api` for it, so costs are not zeroed), `> uses an OpenCode API key when the store holds no OAuth account` |
| late fallback profile hydration cannot restore rotated credentials | X: host files hold no credentials to restore |
| background refresh jitter / proactive rotation / four-hour window (3) | X: the main background refresh is deleted; T `> plugin start runs the store keep-alive instead of refreshing idle accounts` |
| backs off after rate limits; refreshes expired token; retries transient; bounded retries; no retry for non-transient (5) | T `> an expired main is re-read from the store; no refresh happens in TypeScript`; R `refresh.rs::failure_classification`, `access.rs::an_expired_token_is_refreshed_and_persisted`; core T `store-refresh.test.ts > a transient failure backs off …` |
| concurrent refresh dedupe / rotation cascade / persist once / latest refresh token (4) | T core `store-refresh.test.ts > concurrent callers in one process share one refresh`, `> a separate process racing …`; R `refresh.rs::a_stale_caller_token_is_never_spent_the_stores_token_is` |
| main host credential replacement primes a new lineage; main refresh keeps lineage; lease adopter advances binding; fallback rotation keeps one prime claim (4) | T `> a different store account as main primes a new lineage in the same reset window`, `> a store refresh of main keeps the lineage and prime claim`, `> fallback token rotation in the store keeps one prime claim per reset window`; core `prime-lineage-identity.test.ts` (4). Lease adopter: X (lease deleted) |
| R3: a fallback refreshAccount failure logs `prime token refresh failed` | T `> R3: a fallback token failure in the store logs …` |
| (new) 401 on the store main | T `> a 401 on the store main re-authorizes that bearer in the store and re-sends once` |
| (new) host credential migration | T `> OpenCode's own credential is imported into the store once and replaced by the placeholder` |

## opencode/src/tests/cli.test.ts (5 removed, 5 new)

| removed case | coverage |
|---|---|
| names the account from the profile endpoint / from the grant email | T `> names the account after the signed-in email with no label given`, `> saves the login in the store and only a tokenless entry in the host files` |
| re-login with same label clears stale errors and quota; replaces split runtime state and clears stale reauth | T `> re-login with the same label keeps the entry and drops legacy host tokens`; stale errors: R `account.rs::a_stale_unbound_invalid_grant_flag_clears_itself`, `store.rs::merge_login_updates_the_same_login_in_place` |
| requires confirmation, revokes remotely, removes sidecar, disables canonical auth | T `cli.test.ts > requires confirmation and changes nothing when cancelled`, `> revokes the stored token in Rust and disables the account` (the mock revoke endpoint receives the stored refresh token, which never passes through JS); `/claude-account revoke <id> --confirm` uses the same binding call |

## opencode/src/tests/shared-auth.test.ts (9 removed, 9 new; file rewritten)

| removed case | coverage |
|---|---|
| adopts OpenCode OAuth as current when the store is empty | T `> moves OpenCode OAuth into the store once and leaves a placeholder in auth.json` |
| honors ordered-first semantics for an unpinned store | T core `shared-account-store.test.ts > pickSharedAccount prefers an available current row, else the first available` |
| uses canonical API-key credentials instead of stale host OAuth | T `> uses a store API key instead of stale host OAuth` |
| synchronizes a newer OpenCode token rotation for an adopted main | X: the host→store main sync is the doc 23 lost-update bug; the store refreshes itself. T `> the store's copy wins over a host credential for the same login` |
| inherited env credentials without persisting; WIF only after canonical/host/env | T `> supports environment credentials and WIF only after the store and host` |
| a disabled canonical match blocks stale host credential resurrection | T `> a placeholder host credential is not imported and a disabled store row is not resurrected` |
| preserves canonical metadata when reconnecting; persists explicit connections and rotated tokens | R `store.rs::merge_login_updates_the_same_login_in_place`, `store.rs::row_updates_preserve_every_field_they_do_not_own`; rotated-token persistence from TS: X |

## opencode add-account-flows, account-command, quota-manager, quotas, prime (core)

- `add-account-flows.test.ts > add-oauth-finish without --label leaves label undefined (UUID-name fallback)` → T same test renamed "(store names the row)".
- `account-command.test.ts`, `quota-manager.test.ts`, `quotas.test.ts`, `core prime.test.ts`: no test removed; only the `refresh:` field was dropped from OAuth fixtures (the field no longer exists on `OAuthAccount`).

## pi/src/tests/index.test.ts (9 removed, 8 new)

| removed case | coverage |
|---|---|
| adopts the rotated shared credential instead of spending a superseded refresh token | R `refresh.rs::a_stale_caller_token_is_never_spent_the_stores_token_is`, `refresh.rs::unknown_token_adopts_a_live_rotated_shared_credential`; T `> a placeholder credential gets the live store token without a refresh` |
| refreshes normally when the rotated shared credential is also expired | T `> an expired store token is refreshed once, by the store` |
| uses the canonical winner when another process supersedes refresh CAS | R `store.rs::refresh_compare_and_swap_never_overwrites_a_newer_rotation`, `refresh_claim.rs::commit_is_fenced_on_the_lease_and_the_presented_token` |
| stops re-presenting a token Anthropic rejected with invalid_grant | T `> a revoked store token is presented once, then refused locally`; R `refresh.rs::invalid_grant_is_remembered_and_never_re_presented` |
| adopts a live account when the first enabled one has expired | T `> a placeholder credential gets the live store token without a refresh`; R `access.rs::a_dead_login_rotates_to_the_next_and_all_dead_is_invalid_grant` |
| honors the host abort signal before spending a refresh token | T `> honors the host abort signal before touching the store` |
| never spends a refresh token after claim contention times out | R `refresh.rs::held_claim_refuses_without_spending_and_unreadable_store_refuses` |
| rejects a refresh timeout that can outlive the shared lease | R `refresh.rs::the_refresh_deadline_always_ends_inside_the_claim`, `oauth.rs::the_default_client_gives_up_before_the_refresh_claim_lapses` |
| adopts native rotation into the shared store and releases its lease | Native publish: see the native-claude-publish section (now in Rust, in the refresh commit path). Lease release: R `refresh.rs::refresh_persists_rotation_to_the_shared_store_and_releases_the_lease` |

## pi/src/tests/trace-bridge.test.ts (4 removed, 3 new)

| removed case | coverage |
|---|---|
| records one ok span for a successful refresh | T `> records one ok span for a refresh the store performed` |
| records one revoked span with the HTTP status for invalid_grant | T `> records one revoked span for invalid_grant` (the binding error carries no HTTP status; the span keeps the class) |
| marks a refresh the plugin declined to spend as refused | T `> marks a credential the store refuses to import as refused` |
| labels a credential the store has never seen by fingerprint only | X: an unseen credential is now imported into the store (T `pi index.test.ts > a real refresh token held by Pi moves into the store once`) |

## pi stream, adopt-host-credential, commands

No case removed. `adopt-host-credential.test.ts` (11) now seeds the store and asserts the placeholder
refresh and that no real refresh token is written; `commands.test.ts` gained
`> moves tokens an older version left in Pi state files into the store`.

## Removed or replaced by the binding-gaps change

### opencode/src/tests/auth.test.ts (13 removed; file deleted)

The TypeScript `authorize` / `exchange` (and its private `exchangeCode`) only served the Console
"Create an API Key" flow. That flow now uses the binding: `startSharedLogin({ mode: 'console' })`
and `SharedLogin.exchange`, a non-persisting exchange whose refresh token is dropped in Rust.
With no caller left, the TS copies were deleted.

| removed case | coverage |
|---|---|
| returns the hosted callback URL for max mode; does not use localhost by default | R `endpoints.rs::from_lookup_ignores_blank_values_and_defaults_to_prod` (manual redirect `platform.claude.com/oauth/code/callback`), `lib.rs::start_login_binds_url_verifier_and_state_normal` |
| returns the hosted callback URL for console mode | R `endpoints.rs::console_variant_only_changes_authorize_url`; T `opencode index.test.ts > Create an API Key: exchanged in Rust, nothing stored, key minted with the access token` |
| sets required OAuth query params | R `oauth.rs::authorize_url_carries_pkce_and_scopes`, `lib.rs::start_login_binds_url_verifier_and_state_normal`; N `smoke.test.ts > PKCE login exchanges the code in Rust and stores the account` |
| honors the Claude Code OAuth client id override | R `endpoints.rs::from_lookup_overrides_every_oauth_url` (`CLAUDE_CODE_OAUTH_CLIENT_ID`) |
| binds a caller-provided loopback redirect into the authorization URL | N `gaps.test.ts > startLogin takes a loopback redirectUri and state; the exchange uses both`; R `lib.rs::start_login_with_state_carries_the_callers_state_and_refuses_unsafe_ones`; T `core shared-account-store.test.ts > a loopback login advertises its own redirect URI in the authorize URL` |
| supports organization and login-hint routing params | `login_hint`: N `smoke.test.ts > PKCE login …`. `orgUUID` / `login_method`: X, no caller ever passed them and the binding does not offer them |
| accepts code#state format; accepts a full callback URL | N `smoke.test.ts > PKCE login …` (`code#state`), `gaps.test.ts > startLogin takes a loopback redirectUri and state …` (full redirect URL), `> exchangeCode returns an access token and stores nothing`; R `oauth.rs::redirect_parse_splits_and_verifies_state` |
| returns account, organization, and granted-scope metadata | N `gaps.test.ts > exchangeCode returns an access token and stores nothing` (`accountUuid`, `email`, `scopes`); T `core shared-account-store.test.ts > exchange returns an access token and no account is written` |
| returns failed on invalid callback input | N `gaps.test.ts > exchangeCode …` (`'not a callback'` → `auth_required`, no exchange) |
| returns failed on state mismatch | N `gaps.test.ts > exchangeCode …` (tampered state, no exchange); T `opencode index.test.ts > Create an API Key: a forged state fails before any exchange or mint`, `core shared-account-store.test.ts > exchange returns an access token and no account is written` |
| rejects malformed token responses during initial exchange | R `oauth.rs::a_first_exchange_without_a_usable_refresh_token_is_refused`, `into_tokens_rejects_non_positive_lifetime`, `into_tokens_rejects_scopes_without_inference` |

### Other replaced cases

| removed case | coverage |
|---|---|
| `core oauth-loopback.test.ts > adopts the state the Rust login generated` | X: `OAuthLoopbackSession.expectState` is gone; the binding login takes the listener's own `state` and `redirectUri` (`startLogin({ redirectUri, state })`), so the listener is never re-keyed and no per-login handle is needed. T `> the store login takes the listener's own state; the listener is never re-keyed`, `> startSharedLoginWithLoopback advertises the loopback redirect and state` |
| `opencode cli.test.ts > refuses remote revocation (no refresh token in TS) and changes nothing` | X: revocation works again. T `> requires confirmation and changes nothing when cancelled`, `> revokes the stored token in Rust and disables the account` |
| `core shared-account-adapter.test.ts > store api_key rows are not materialized (the binding hands out no keys)` | kept as `> a store api_key row without a key handed out is not materialized` (Pi materializes without keys), plus the two API-key cases above |

TypeScript token-shape pre-validation (`isWellFormedOAuthToken`) is deleted: the binding
answers a malformed token with `invalid_token`, which `importHostOAuthCredential` maps to
`{ status: 'invalid' }` (T `shared-account-store.test.ts > reports a malformed host credential as
invalid instead of storing it`, `> an unreadable store is store_corrupt and is left as it is`;
N `smoke.test.ts > import moves a host credential …` now expects `invalid_token` where it
expected `config`: the code was split, not loosened).

## Loosened assertions

None of the surviving tests had an assertion weakened. Changes to surviving tests were fixture
changes (`refresh:` removed from OAuth fixtures, store seeding via `store-fixture.ts`, mock token
server instead of JS fetch mocks). Two OpenCode test files install a canned 599 response for
Anthropic/Claude hosts (`index.test.ts`, `add-account-flows.test.ts`) so background quota/profile
calls a test leaves running stay offline; before this, the baseline suite made real
`api.anthropic.com` calls. One OpenCode test got a longer timeout (15 s,
`/claude-quota preserves fresher routing`) because live fallbacks are now force-polled through
the quota API's 1 s gate.
