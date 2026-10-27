import { expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { expectLinkOnOwnRows, SIGN_IN_URL } from './fixtures/sign-in-link'

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

// Each test starts Bun with OpenTUI; a loaded machine takes past the 5 s default.
const SUBPROCESS_TIMEOUT_MS = 20_000

interface Run {
  /** The sign-in dialog's first frame that shows the link. */
  frame: string
  shown: number
  sizes: unknown[]
  alerts: unknown[]
  toasts: unknown[]
}

// Loads the package's `./tui` entry the way OpenCode 2 does (`setup(context)`),
// so the bundled v2 TUI and the precompiled sign-in dialog both run. The
// /claude command walks the menu to Start OAuth sign-in, whose result names
// its link; the dialog that opens is drawn in a real test renderer at
// `width` columns, closed, and then a server notification is delivered.
async function runSignIn(width: number): Promise<Run> {
  const fixture = await mkdtemp(join(tmpdir(), 'anthropic-oc2-sign-in-'))
  lifetimes.deferCleanup(() => rm(fixture, { recursive: true, force: true }))
  await writeFile(
    join(fixture, 'preferences.jsonc'),
    JSON.stringify({ 'anthropic-auth': { rememberCollapsed: false } }),
  )
  const probe = `
let __probeRenderer;
process.once('SIGTERM', () => {
  // CliRenderer traps SIGTERM to destroy without exiting, leaving a probe
  // blocked awaiting its next frame alive until the hook times out. Exit
  // promptly so the harness never waits out its hook.
  try { __probeRenderer?.destroy(); } catch {}
  process.exit(143);
});
import { createTestRenderer } from '@opentui/core/testing';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
ensureRuntimePluginSupport();
const { setup } = await import(${JSON.stringify(new URL('../tui/entry.mjs', import.meta.url).href)});
const url = ${JSON.stringify(SIGN_IN_URL)};
const menu = {
  command: 'claude',
  title: 'Claude',
  sections: [{
    id: 'Accounts', slot: 'accounts', title: 'Accounts', lines: [], items: [],
    actions: [{ id: 'add-oauth-start', label: 'Start OAuth sign-in', knobs: [] }],
  }],
};
const handlers = {};
const commands = [];
const alerts = [];
const toasts = [];
const sizes = [];
let shown = 0;
let active;
let selects = 0;
let dialog;
let opened;
const dialogOpened = new Promise((resolve) => { opened = resolve; });
const cleanup = await setup({
  location: { directory: process.cwd() },
  theme: {
    text: {
      base: '#ffffff', muted: '#888888',
      action: { primary: { base: '#3366ff' } },
      feedback: { success: { base: '#00ff00' }, warning: { base: '#ffff00' }, error: { base: '#ff0000' } },
    },
    background: { base: '#000000' },
    border: { base: '#ffffff' },
  },
  client: { rpc: () => ({
    events: { on: (name, handler) => { handlers[name] = handler; return () => {}; } },
    open: async () => ({ command: 'claude', menu }),
    apply: async () => ({
      command: 'claude', ok: true,
      text: 'Open ' + url + ' and paste the returned code using Finish OAuth sign-in.',
      authorizationUrl: url,
      menu,
    }),
    sidebar: async () => { throw new Error('unused'); },
  }) },
  keymap: { layer(factory) { commands.push(...factory().commands); } },
  ui: {
    router: { current: () => ({ type: 'session', sessionID: 'ses_oc2' }) },
    slot() { return () => {}; },
    toast: { show(options) { toasts.push(options); } },
    dialog: {
      // Section, then action; the third pick (after the sign-in dialog
      // closes) is a dismissal that ends the menu. Each size set is recorded
      // with the dialog that was active then.
      async select(options) { active = 'select'; selects++; return selects <= 2 ? options.options[0].value : undefined; },
      async alert(options) { active = 'alert'; alerts.push(options); },
      show(renderDialog, onClose) { active = 'show'; shown++; dialog = { renderDialog, onClose }; opened(); },
      set(options) { sizes.push({ dialog: active, ...options }); },
      clear() {},
    },
  },
});
const running = commands.find((command) => command.id === 'cortexkit.claude').run();
// A menu that never opens the sign-in dialog ends on its own; report that
// instead of waiting forever.
await Promise.race([dialogOpened, running]);
if (!dialog) {
  console.log(JSON.stringify({ frame: '', shown, sizes, alerts, toasts }));
  process.exit(0);
}
let destroyed;
const teardown = new Promise((resolve) => { destroyed = resolve; });
const setupRenderer = await createTestRenderer({ width: ${width}, height: 40, exitSignals: [], onDestroy() { destroyed(); } });
__probeRenderer = setupRenderer.renderer;
let frame = '';
try {
  await render(() => dialog.renderDialog(), setupRenderer.renderer);
  for (;;) {
    await setupRenderer.renderOnce();
    frame = setupRenderer.captureCharFrame();
    if (frame.includes('https://')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
} finally {
  setupRenderer.renderer.destroy();
  await teardown;
}
// The person closes the dialog; the menu loop continues and then ends. A
// dialog whose close never reached the loop would leave this await hanging.
dialog.onClose();
await running;
handlers.notification({ data: { sessionId: 'ses_oc2', message: 'Native quota readings refreshed.', kind: 'info' } });
cleanup();
console.log(JSON.stringify({ frame, shown, sizes, alerts, toasts }));
process.exit(0);
`
  const child = Bun.spawn(
    [process.execPath, '--preload', '@opentui/solid/preload', '-e', probe],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        OPENCODE_TUI_PREFERENCES_FILE: join(fixture, 'preferences.jsonc'),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  // Own the probe through the test lifetime: the gate kills it as soon as
  // teardown starts, before the lifetime waits for this body, so a body
  // awaiting a frame it never receives can still finish. SIGKILL after a
  // short grace is the backstop because a signal handler alone cannot be
  // relied on once the renderer has trapped SIGTERM.
  const cancel = lifetimes.gate()
  const cancellation = cancel.wait.then(async () => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await Bun.sleep(500)
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  lifetimes.trackDetached(cancellation)
  const joined = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  lifetimes.trackDetached(
    joined.then(
      () => {},
      (error) => {
        throw error
      },
    ),
  )
  const [stdout, stderr, exitCode] = await joined
  cancel.open()
  await cancellation
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
}

test(
  'OpenCode 2 shows a sign-in link in a lasting dialog, whole at a narrow width, while notifications still toast',
  async () => {
    const run = await runSignIn(44)
    // The link opened the sign-in dialog, not the result alert.
    expect(run.shown).toBe(1)
    expect(run.alerts).toEqual([])
    // The sign-in dialog is the widest size, as are the menu's selects
    // before and after it.
    expect(run.sizes).toEqual(
      ['select', 'select', 'show', 'select'].map((dialog) => ({
        dialog,
        size: 'xlarge',
      })),
    )
    expect(run.frame).toContain('Claude sign-in')
    expect(run.frame).toContain('Press Esc to close.')
    // 44 columns cannot fit the link on one row; it must still read whole.
    expect(expectLinkOnOwnRows(run.frame, SIGN_IN_URL)).toBeGreaterThan(1)
    // An ordinary server notification is still a toast.
    expect(run.toasts).toEqual([
      {
        title: 'Claude',
        sessionID: 'ses_oc2',
        message: 'Native quota readings refreshed.',
        variant: 'info',
      },
    ])
  },
  SUBPROCESS_TIMEOUT_MS,
)
