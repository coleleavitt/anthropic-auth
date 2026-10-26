import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClaudeQuotaSummary } from '@cortexkit/anthropic-auth-core'
import { fiveAccountSidebarState } from './fixtures/sidebar-five-accounts'

let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
let fixture: string | undefined
afterEach(async () => {
  child?.kill()
  await child?.exited
  child = undefined
  if (fixture) await rm(fixture, { recursive: true, force: true })
  fixture = undefined
})

// Each test starts Bun with OpenTUI, whose startup on a busy machine can take
// longer than the default 5 s test timeout.
const SUBPROCESS_TIMEOUT_MS = 20_000

const DIALOG_WIDTHS = [60, 88, 116] as const

const DARK_THEME = {
  text: {
    base: '#ffffff',
    muted: '#888888',
    action: { primary: { base: '#3366ff' } },
    feedback: {
      success: { base: '#00ff00' },
      warning: { base: '#ffff00' },
      error: { base: '#ff0000' },
    },
  },
  background: { base: '#000000' },
  border: { base: '#ffffff' },
}

const LIGHT_THEME = {
  text: {
    base: '#1a1a1a',
    muted: '#6a6a6a',
    action: { primary: { base: '#0055cc' } },
    feedback: {
      success: { base: '#1a7f37' },
      warning: { base: '#9a6700' },
      error: { base: '#cf222e' },
    },
  },
  background: { base: '#ffffff' },
  border: { base: '#d0d0d0' },
}

// The test renderer prints colors as `RGBA.toString()`.
const rgba = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(
    (at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255,
  )
  return `rgba(${r?.toFixed(2)}, ${g?.toFixed(2)}, ${b?.toFixed(2)}, 1.00)`
}

// The quota summary Core writes for the five sidebar accounts, Markdown and all.
function quotaSummary(): string {
  const state = fiveAccountSidebarState()
  return buildClaudeQuotaSummary({
    accounts: [
      {
        name: 'main',
        role: 'main',
        tierLabel: 'Max 20x',
        quota: state.main.quota as never,
      },
      ...state.fallbacks.map((account) => ({
        name: account.label,
        role: 'fallback' as const,
        quota: account.quota as never,
      })),
    ],
  })
}

const ROUTING_STATUS = [
  'Routing: main-first',
  '',
  '## Session',
  '- Account: work (sticky)',
  '- Reason: this session stays on work while its cache is warm and main is close to its 5h limit',
  '- Relay: off',
]

interface Run {
  /** Each select the menu opened: its title and options, in order. */
  selects: {
    title: string
    options: { title: string; description?: string }[]
  }[]
  /** The status dialog's first frame that shows `wanted`. */
  frame: string
  /** Each trimmed span's foreground color in that frame. */
  colors: Record<string, string>
  shown: number
  /** Each size the menu set, with the dialog that was active then. */
  sizes: { dialog: string; size: string }[]
  alerts: unknown[]
  sidebarCalls: number
}

// Loads the package's `./tui` entry the way OpenCode 2 does (`setup(context)`),
// so the bundled v2 TUI and the precompiled status view both run. The /claude
// command opens the menu, picks `section`, then View status; the dialog that
// opens is drawn in a real test renderer at `width` columns until it shows
// every `wanted` text, and is then closed, which ends the menu.
async function runStatus(options: {
  section: string
  width: number
  wanted: string[]
  sidebar?: unknown
  theme?: typeof DARK_THEME
}): Promise<Run> {
  fixture = await mkdtemp(join(tmpdir(), 'anthropic-oc2-menu-status-'))
  await writeFile(
    join(fixture, 'preferences.jsonc'),
    JSON.stringify({ 'anthropic-auth': { rememberCollapsed: false } }),
  )
  const menu = {
    command: 'claude',
    title: 'Claude',
    sections: [
      {
        id: 'Accounts',
        slot: 'accounts',
        title: 'Accounts',
        lines: ['Main account: signed in', 'Fallbacks: 4 enabled'],
        items: [],
        actions: [
          {
            id: 'add-oauth-start',
            label: 'Start OAuth sign-in',
            description: 'Add a Claude account through the browser',
            knobs: [],
          },
        ],
      },
      {
        id: 'Quota',
        slot: 'quota',
        title: 'Quota',
        lines: [quotaSummary()],
        items: [],
        actions: [{ id: 'refresh', label: 'Refresh quota', knobs: [] }],
      },
      {
        id: 'Routing',
        slot: 'routing',
        title: 'Routing',
        lines: ROUTING_STATUS,
        items: [],
        actions: [],
      },
    ],
  }
  const probe = `
import { createTestRenderer } from '@opentui/core/testing';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
ensureRuntimePluginSupport();
const { setup } = await import(${JSON.stringify(new URL('../tui/entry.mjs', import.meta.url).href)});
const menu = ${JSON.stringify(menu)};
const sidebar = ${JSON.stringify(options.sidebar ?? null)};
const wanted = ${JSON.stringify(options.wanted)};
const commands = [];
const selects = [];
const alerts = [];
const sizes = [];
let activeDialog;
let sidebarCalls = 0;
let shown = 0;
let dialog;
let opened;
const dialogOpened = new Promise((resolve) => { opened = resolve; });
const cleanup = await setup({
  location: { directory: process.cwd() },
  theme: ${JSON.stringify(options.theme ?? DARK_THEME)},
  client: { rpc: () => ({
    events: { on: () => () => {} },
    open: async () => ({ command: 'claude', menu }),
    apply: async () => { throw new Error('unused'); },
    sidebar: async () => {
      sidebarCalls++;
      if (sidebar === null) throw Object.assign(new Error('missing'), { code: 'rpc.method_not_found' });
      return sidebar;
    },
  }) },
  keymap: { layer(factory) { commands.push(...factory().commands); } },
  ui: {
    router: { current: () => ({ type: 'session', sessionID: 'ses_oc2' }) },
    slot() { return () => {}; },
    toast: { show() {} },
    dialog: {
      // The section, then View status; the third pick (after the status
      // dialog closes) is a dismissal that ends the menu.
      async select(options) {
        // Opening a dialog makes it the active one, which \`set\` sizes.
        activeDialog = 'select:' + options.title;
        selects.push({
          title: options.title,
          options: options.options.map((option) => ({ title: option.title, ...(option.description === undefined ? {} : { description: option.description }) })),
        });
        if (selects.length === 1) return options.options.find((option) => option.title === ${JSON.stringify(options.section)})?.value;
        if (selects.length === 2) return options.options.find((option) => option.title === 'View status')?.value;
        return undefined;
      },
      async alert(options) { activeDialog = 'alert'; alerts.push(options); },
      show(renderDialog, onClose) { activeDialog = 'show'; shown++; dialog = { renderDialog, onClose }; opened(); },
      set(options) { sizes.push({ dialog: activeDialog, ...options }); },
      clear() {},
    },
  },
});
const running = commands.find((command) => command.id === 'cortexkit.claude').run();
// A menu that never opens the status dialog ends on its own; report that
// instead of waiting forever.
await Promise.race([dialogOpened, running]);
if (!dialog) {
  await running;
  console.log(JSON.stringify({ selects, frame: '', colors: {}, shown, sizes, alerts, sidebarCalls }));
  process.exit(0);
}
let destroyed;
const teardown = new Promise((resolve) => { destroyed = resolve; });
const setupRenderer = await createTestRenderer({ width: ${options.width}, height: 60, onDestroy() { destroyed(); } });
let frame = '';
const colors = {};
try {
  await render(() => dialog.renderDialog(), setupRenderer.renderer);
  for (;;) {
    await setupRenderer.renderOnce();
    frame = setupRenderer.captureCharFrame();
    if (wanted.every((part) => frame.includes(part))) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const line of setupRenderer.captureSpans().lines)
    for (const span of line.spans)
      if (span.text.trim()) colors[span.text.trim()] ??= String(span.fg);
} finally {
  setupRenderer.renderer.destroy();
  await teardown;
}
// The person closes the dialog; the menu loop goes back to the section list,
// which is dismissed. A close that never reached the loop would hang here.
dialog.onClose();
await running;
cleanup();
console.log(JSON.stringify({ selects, frame, colors, shown, sizes, alerts, sidebarCalls }));
process.exit(0);
`
  child = Bun.spawn(
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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
}

const headingColor = (run: Run, text: string) =>
  Object.entries(run.colors).find(([span]) => span === text)?.[1]

test(
  'OpenCode 2 /claude lists section names only and shows a status as styled text in a wide dialog',
  async () => {
    const run = await runStatus({
      section: 'Routing',
      width: DIALOG_WIDTHS[0],
      wanted: ['Routing status', 'Relay: off'],
    })
    // The root list carries no status text at all.
    expect(run.selects[0]).toEqual({
      title: 'Claude',
      options: [
        { title: 'Accounts' },
        { title: 'Quota' },
        { title: 'Routing' },
      ],
    })
    expect(run.selects[1]?.options).toEqual([{ title: 'View status' }])
    // The status opened the wide view, not an alert.
    expect(run.shown).toBe(1)
    expect(run.alerts).toEqual([])
    // Every menu dialog, the status view included, is the widest size.
    expect(run.sizes).toEqual(
      ['select:Claude', 'select:Routing', 'show', 'select:Claude'].map(
        (dialog) => ({ dialog, size: 'xlarge' }),
      ),
    )
    expect(run.frame).toContain('Routing: main-first')
    expect(run.frame).toContain('• Account: work (sticky)')
    // A bullet too long for the dialog wraps under its own text, not under
    // the bullet mark or the left edge.
    const rows = run.frame.split('\n')
    const reason = rows.findIndex((row) => row.startsWith('  • Reason:'))
    expect(reason).toBeGreaterThan(0)
    expect(rows[reason + 1]).toMatch(/^ {4}\S/)
    expect(rows[reason + 2]).toStartWith('  • Relay: off')
    expect(run.frame).toContain('Press Esc to close.')
    expect(run.frame).not.toContain('## Session')
    expect(run.frame).not.toContain('- Account')
    expect(headingColor(run, 'Session')).toBe(
      rgba(DARK_THEME.text.action.primary.base),
    )
    // Closing the dialog returned to the section list, where the third select
    // dismissed the menu.
    expect(run.selects).toHaveLength(3)
  },
  SUBPROCESS_TIMEOUT_MS,
)

test(
  'OpenCode 2 /claude keeps the section list free of status in the Accounts section too',
  async () => {
    const run = await runStatus({
      section: 'Accounts',
      width: DIALOG_WIDTHS.at(-1) ?? 80,
      wanted: ['Accounts status', 'Fallbacks: 4 enabled'],
    })
    expect(run.selects[1]).toEqual({
      title: 'Accounts',
      options: [
        { title: 'View status' },
        {
          title: 'Start OAuth sign-in',
          description: 'Add a Claude account through the browser',
        },
      ],
    })
    expect(run.sidebarCalls).toBe(0)
  },
  SUBPROCESS_TIMEOUT_MS,
)

for (const width of DIALOG_WIDTHS) {
  test(
    `OpenCode 2 Quota status at ${width} columns draws the sidebar's account blocks, not the Markdown summary`,
    async () => {
      const run = await runStatus({
        section: 'Quota',
        width,
        wanted: ['Quota status', 'backup', 'Press Esc to close.'],
        sidebar: fiveAccountSidebarState(),
      })
      expect(run.sidebarCalls).toBe(1)
      expect(run.sizes).toContainEqual({ dialog: 'show', size: 'xlarge' })
      for (const name of ['main', 'work', 'personal', 'team', 'backup'])
        expect(run.frame).toContain(name)
      expect(run.frame).toMatch(/\d+% left/)
      expect(run.frame).not.toContain('Claude Quotas')
      expect(run.frame).not.toContain('#')
      // The blocks keep OpenCode 1's quota-view width inside the padding.
      for (const row of run.frame.split('\n'))
        expect(row.trimEnd().length).toBeLessThanOrEqual(2 + 58)
    },
    SUBPROCESS_TIMEOUT_MS,
  )

  test(
    `OpenCode 2 Quota status at ${width} columns falls back to styled summary text when the server has no sidebar`,
    async () => {
      const run = await runStatus({
        section: 'Quota',
        width,
        wanted: ['Claude Quotas', 'backup (fallback)', 'Press Esc to close.'],
        sidebar: null,
      })
      expect(run.sidebarCalls).toBe(1)
      expect(run.alerts).toEqual([])
      expect(run.frame).toContain('main (main)')
      expect(run.frame).toContain('• Tier: Max 20x')
      expect(run.frame).not.toContain('#')
      expect(run.frame).not.toContain(' - ')
      // Each quota window of the five accounts is a bullet row.
      const bullets = run.frame
        .split('\n')
        .filter((row) => row.includes('•') && /\d+% left/.test(row))
      expect(bullets.length).toBeGreaterThanOrEqual(10)
      expect(headingColor(run, 'Claude Quotas')).toBe(
        rgba(DARK_THEME.text.action.primary.base),
      )
      expect(headingColor(run, 'main (main)')).toBe(rgba(DARK_THEME.text.base))
    },
    SUBPROCESS_TIMEOUT_MS,
  )
}

test(
  'OpenCode 2 status view takes its colors from a light host theme',
  async () => {
    const run = await runStatus({
      section: 'Quota',
      width: DIALOG_WIDTHS[0] ?? 60,
      wanted: ['Claude Quotas', 'backup (fallback)'],
      sidebar: null,
      theme: LIGHT_THEME,
    })
    expect(headingColor(run, 'Claude Quotas')).toBe(
      rgba(LIGHT_THEME.text.action.primary.base),
    )
    expect(headingColor(run, 'main (main)')).toBe(rgba(LIGHT_THEME.text.base))
    expect(headingColor(run, 'Press Esc to close.')).toBe(
      rgba(LIGHT_THEME.text.muted),
    )
  },
  SUBPROCESS_TIMEOUT_MS,
)
