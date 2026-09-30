import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testDir = mkdtempSync(join(tmpdir(), 'anthropic-auth-opencode-test-'))

// Swept at exit, not in afterEach: background refresh/persist writes land
// after per-test cleanup and recreate the directory via mkdir(recursive).
process.once('exit', () => {
  rmSync(testDir, { recursive: true, force: true })
})

process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_VERSION_CHECK = '1'
process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = testDir
process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(testDir, 'anthropic-auth.json')
// Isolate the shared account store + model catalog so credential reconciliation
// never reads or writes a developer's real ~/.anthropic-accounts state in tests.
process.env.ANTHROPIC_ACCOUNTS_FILE = join(testDir, 'accounts.json')
process.env.ANTHROPIC_MODEL_CATALOG_FILE = join(testDir, 'model-catalog.json')
process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
  testDir,
  'sidebar-state.json',
)
process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
  testDir,
  'cachekeep-registry',
)
// Isolate refusal logging so tests don't pollute the real training log
process.env.REFUSAL_LOG_DIR = join(testDir, 'refusal-logs')
// The Rust account store talks to the OAuth token endpoint itself (JS fetch
// mocks cannot intercept it). Default it to a dead loopback port so a test
// that forgets `startMockTokenServer()` fails closed instead of reaching the
// real endpoint; the fixture restores this value when its mock stops.
process.env.ANTHROPIC_OAUTH_TOKEN_URL = 'http://127.0.0.1:9/v1/oauth/token'
// Profile hydration calls the real profile endpoint; tests that exercise it
// turn it back on explicitly.
process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
