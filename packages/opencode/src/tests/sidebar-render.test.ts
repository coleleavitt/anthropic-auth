import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expectOneLineQuotaRows,
  fiveAccountSidebarState,
} from './fixtures/sidebar-five-accounts'

let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
let fixture: string | undefined
afterEach(async () => {
  child?.kill()
  await child?.exited
  child = undefined
  if (fixture) await rm(fixture, { recursive: true, force: true })
  fixture = undefined
})

/**
 * After the first frame, the probe writes `state` to the sidebar state file,
 * waits until the sidebar's file poll draws every `wanted` part, and reports
 * the renderable ids of each one-line account row (a row whose label is one of
 * `names`) before and after that update.
 */
type Rewrite = { state: unknown; wanted: string[]; names: string[] }

async function renderSidebar(
  state: unknown,
  wanted: string[],
  collapsed = false,
  options: { rewrite?: Rewrite; width?: number; height?: number } = {},
) {
  const { rewrite, width = 42, height = 32 } = options
  fixture = await mkdtemp(join(tmpdir(), 'anthropic-quota-render-'))
  const stateFile = join(fixture, 'sidebar.json')
  await writeFile(stateFile, JSON.stringify(state))
  await writeFile(
    join(fixture, 'preferences.jsonc'),
    JSON.stringify({
      'anthropic-auth': {
        startCollapsed: collapsed,
        rememberCollapsed: false,
        // The fastest poll the preferences allow keeps a rewrite test short.
        ...(rewrite ? { pollMs: 500 } : {}),
      },
    }),
  )
  // Render the compiled sidebar with installed OpenTUI libraries, without a package install.
  const probe = `
import { createTestRenderer } from '@opentui/core/testing';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
import { TextAttributes } from '@opentui/core';
ensureRuntimePluginSupport();
const { default: plugin } = await import(${JSON.stringify(new URL('../tui-compiled/tui.tsx', import.meta.url).href)});
const registered = [];
await plugin.tui({
  event: { on() { return () => {}; } },
  theme: { current: {
    accent: '#3366ff', background: '#000000', borderActive: '#ffffff',
    error: '#ff0000', success: '#00ff00', text: '#ffffff',
    textMuted: '#888888', warning: '#ffff00',
  } },
  slots: { register(value) { registered.push(value); } },
  state: { path: { directory: process.cwd() } },
  route: { current: () => ({ type: 'home' }) },
});
const sidebar = registered.find((value) => value.slots?.sidebar_content)?.slots.sidebar_content;
if (!sidebar) throw new Error('sidebar slot was not registered');
let destroyed;
const teardown = new Promise((resolve) => { destroyed = resolve; });
const setup = await createTestRenderer({ width: ${width}, height: ${height}, onDestroy() { destroyed(); } });
let pending;
const observe = () => {
  if (!pending) return;
  const text = setup.captureCharFrame();
  if (!pending.wanted.every((part) => text.includes(part))) return;
  const done = pending;
  pending = undefined;
  done.resolve(text);
};
const nextFrame = (wanted) => new Promise((resolve) => {
  pending = { wanted, resolve };
  setup.renderer.requestRender();
});
const rewrite = ${JSON.stringify(rewrite ?? null)};
const rowIds = () => {
  const ids = [];
  const walk = (node) => {
    const children = node.getChildren?.() ?? [];
    if (node.height === 1 && children.some((child) =>
      typeof child.plainText === 'string' && rewrite.names.includes(child.plainText.trim())))
      ids.push(node.id);
    for (const child of children) walk(child);
  };
  walk(setup.renderer.root);
  return ids;
};
setup.renderer.on('frame', observe);
try {
  const first = nextFrame(${JSON.stringify(wanted)});
  await render(() => sidebar({}, { session_id: 'quota-render-test' }), setup.renderer);
  setup.renderer.requestRender();
  let text = await first;
  if (rewrite) {
    const before = rowIds();
    await Bun.write(process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE, JSON.stringify(rewrite.state));
    text = await nextFrame(rewrite.wanted);
    console.log('ROWS:' + JSON.stringify({ before, after: rowIds() }));
  }
  console.log(text);
  if (${collapsed}) {
    console.log('STYLES:' + JSON.stringify(setup.captureSpans().lines.map((line) => {
      const spans = line.spans.filter((span) => span.text.trim());
      return { text: line.spans.map((span) => span.text).join(''),
        dim: spans.length > 0 && spans.every((span) => (span.attributes & TextAttributes.DIM) !== 0),
        bold: spans.length > 0 && spans.every((span) => (span.attributes & TextAttributes.BOLD) !== 0) };
    })));
  }
} finally {
  setup.renderer.off('frame', observe);
  setup.renderer.destroy();
  await teardown;
}
process.exit(0);
`
  child = Bun.spawn(
    [process.execPath, '--preload', '@opentui/solid/preload', '-e', probe],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: stateFile,
        OPENCODE_TUI_PREFERENCES_FILE: join(fixture, 'preferences.jsonc'),
        OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(fixture, 'rpc'),
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
  return stdout
}

test('compiled sidebar renders the shared quota figure reset and stale reading age offline', async () => {
  const now = Date.now()
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: {
            usedPercent: 60,
            remainingPercent: 40,
            checkedAt: now - 2 * 86400000,
            resetsAt: new Date(now + 4 * 86400000).toISOString(),
          },
          scoped: [],
        },
      },
      fallbacks: [],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    ['40% left', 'checked 2d ago'],
  )
  expect(stdout).toContain('40% left')
  expect(stdout).toContain('3d23h')
  expect(stdout).toContain('checked 2d ago')
  expect(stdout).not.toContain('Fable')
})

test('collapsed sidebar keeps every account on one line with intact narrow quotas and dim stale rows', async () => {
  const now = Date.now()
  const window = (used: number, checkedAt = now) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt,
  })
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: window(62),
          seven_day: window(41),
          scoped: [
            {
              id: 'fable',
              title: 'Fable only',
              modelName: 'Fable',
              ...window(78),
            },
          ],
          extraUsage: {
            used: { amountMinor: 1250, currency: 'USD', exponent: 2 },
            limit: { amountMinor: 5000, currency: 'USD', exponent: 2 },
            exhausted: false,
          },
        },
      },
      fallbacks: [
        {
          id: 'work',
          label: 'work',
          enabled: true,
          needsReauth: false,
          quota: {
            five_hour: window(8, now - 30 * 3600000),
            seven_day: window(93, now - 30 * 3600000),
          },
        },
      ],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    ['5h 38% · 7d 59% · Fa 22% left', 'work', '5h 92% · 7d 7% left'],
    true,
  )
  const [frame, styleText] = stdout.split('STYLES:')
  expect(frame).toContain('main')
  expect(frame).toContain('5h 38% · 7d 59% · Fa 22% left')
  expect(frame).not.toContain('cr 75%')
  expect(frame).toContain('work')
  expect(frame).toContain('5h 92% · 7d 7% left')
  expect(frame).not.toContain('checked')
  const rows = frame!.split('\n').filter((line) => line.includes('5h'))
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain('38%')
  expect(rows[1]).toContain('92%')
  const styles = JSON.parse(styleText!) as {
    text: string
    dim: boolean
    bold: boolean
  }[]
  expect(styles.find((line) => line.text.includes('5h 38%'))).toMatchObject({
    dim: false,
    bold: true,
  })
  expect(styles.find((line) => line.text.includes('5h 92%'))).toMatchObject({
    dim: true,
    bold: false,
  })
})

test('collapsed sidebar dims a stale active row and a fresh inactive row without reordering accounts', async () => {
  const now = Date.now()
  const window = (used: number, checkedAt: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt,
  })
  const stdout = await renderSidebar(
    {
      main: {
        quota: { five_hour: window(10, now), seven_day: window(20, now) },
      },
      fallbacks: [
        {
          id: 'work',
          label: 'work',
          enabled: true,
          needsReauth: false,
          quota: {
            five_hour: window(8, now - 30 * 3600000),
            seven_day: window(93, now - 30 * 3600000),
          },
        },
      ],
      activeId: 'work',
      route: 'work',
      lastUpdated: now,
    },
    ['main', '5h 90% · 7d 80% left', 'work', '5h 92% · 7d 7% left'],
    true,
  )
  const [frame, styleText] = stdout.split('STYLES:')
  expect(frame!.indexOf('main')).toBeLessThan(frame!.indexOf('work'))
  const styles = JSON.parse(styleText!) as {
    text: string
    dim: boolean
    bold: boolean
  }[]
  expect(styles.find((line) => line.text.includes('5h 90%'))).toMatchObject({
    dim: true,
    bold: false,
  })
  expect(styles.find((line) => line.text.includes('5h 92%'))).toMatchObject({
    dim: true,
    bold: false,
  })
})

test('collapsed sidebar leaves out a window without a reading and keeps the muted dash for an account with none', async () => {
  const now = Date.now()
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: { usedPercent: 13, remainingPercent: 87, checkedAt: now },
        },
      },
      fallbacks: [
        {
          id: 'work',
          label: 'work',
          enabled: true,
          needsReauth: false,
          quota: null,
        },
      ],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    ['main', '5h 87% left', 'work'],
    true,
  )
  const [frame, styleText] = stdout.split('STYLES:')
  expect(frame).not.toContain('7d')
  const styles = JSON.parse(styleText!) as {
    text: string
    dim: boolean
    bold: boolean
  }[]
  const main = styles.find((line) => line.text.includes('main'))
  expect(main?.text.trimEnd().endsWith('5h 87% left')).toBe(true)
  expect(main).toMatchObject({ dim: false, bold: true })
  const work = styles.find((line) => line.text.includes('work'))
  expect(work?.text.trimEnd().endsWith('—')).toBe(true)
  expect(work).toMatchObject({ dim: true, bold: false })
})

test('collapsed account rows keep their renderables across same-value state updates', async () => {
  const now = Date.now()
  const window = (used: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt: now,
  })
  const state = (workUsed: number, lastUpdated: number) => ({
    main: { quota: { five_hour: window(10), seven_day: window(20) } },
    fallbacks: [
      {
        id: 'work',
        label: 'work',
        enabled: true,
        needsReauth: false,
        quota: { five_hour: window(workUsed), seven_day: window(30) },
      },
    ],
    activeId: 'main',
    route: 'main',
    lastUpdated,
  })
  // The server rewrites the state file with a new lastUpdated on every
  // request. main's values stay the same; work's change shows that the poll
  // was applied and that a kept row still updates its text.
  const stdout = await renderSidebar(
    state(8, now),
    ['main', '5h 90% · 7d 80% left', 'work', '5h 92% · 7d 70% left'],
    true,
    {
      rewrite: {
        state: state(12, now + 1),
        wanted: ['5h 90% · 7d 80% left', '5h 88% · 7d 70% left'],
        names: ['main', 'work'],
      },
    },
  )
  const rows = JSON.parse(stdout.split('ROWS:')[1]!.split('\n')[0]!) as {
    before: string[]
    after: string[]
  }
  expect(rows.before).toHaveLength(2)
  expect(rows.after).toEqual(rows.before)
  expect(stdout).toContain('5h 88% · 7d 70% left')
})

test('42-column sidebar renders short scoped names credits and stale fallback rows in aligned columns', async () => {
  const now = Date.now()
  const window = (used: number, checkedAt = now, resetMinutes?: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt,
    ...(resetMinutes === undefined
      ? {}
      : {
          resetsAt: new Date(now + resetMinutes * 60_000).toISOString(),
        }),
  })
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: window(62, now, 149),
          seven_day: window(41, now, 3 * 1440 + 23 * 60),
          scoped: [
            {
              id: 'fable',
              title: 'Fable only',
              modelName: 'Fable',
              ...window(78),
            },
          ],
          extraUsage: {
            used: { amountMinor: 1250, currency: 'USD', exponent: 2 },
            limit: { amountMinor: 5000, currency: 'USD', exponent: 2 },
            exhausted: false,
          },
        },
      },
      fallbacks: [
        {
          id: 'work',
          label: 'work',
          enabled: true,
          needsReauth: false,
          quota: {
            five_hour: window(8, now - 30 * 3_600_000),
            seven_day: window(93, now - 30 * 3_600_000),
          },
        },
      ],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    [
      'Fa ████████░░ 22% left',
      'credits 75% left · $12.50/$50.00',
      'work',
      'checked 1d6h ago',
    ],
  )
  expect(stdout).toContain('38% left')
  expect(stdout).toContain('59% left')
  expect(stdout).toContain('Fa ████████░░ 22% left')
  expect(stdout).not.toContain('Fable')
  expect(stdout).toContain('credits 75% left · $12.50/$50.00')
  expect(stdout).toContain('92% left')
  expect(stdout).toContain('7% left')
  expect(stdout).toContain('checked 1d6h ago')
  const rows = stdout
    .split('\n')
    .filter((line) => /38% left|59% left|22% left|92% left|7% left/.test(line))
  expect(rows).toHaveLength(5)
  expect(new Set(rows.map((line) => line.search(/[█░▓▒]/)))).toEqual(
    new Set([4]),
  )
})

function largeCreditState() {
  const now = Date.now()
  return {
    main: {
      quota: {
        five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
        extraUsage: {
          used: { amountMinor: 12_500_000, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 50_000_000, currency: 'USD', exponent: 2 },
          exhausted: false,
        },
      },
    },
    fallbacks: [],
    activeId: 'main',
    route: 'main',
    lastUpdated: now,
  }
}

test('42-column sidebar drops the cents from credit amounts that would not fit on one line', async () => {
  const stdout = await renderSidebar(largeCreditState(), [
    'credits 75% left · $125,000/$500,000',
  ])
  const line = stdout.split('\n').find((row) => row.includes('credits'))
  expect(line?.trim()).toBe('credits 75% left · $125,000/$500,000')
  expect(stdout).not.toContain('.00')
})

test('a wider sidebar keeps the cents on credit amounts that fit', async () => {
  const stdout = await renderSidebar(
    largeCreditState(),
    ['credits 75% left · $125,000.00/$500,000.00'],
    false,
    { width: 60 },
  )
  const line = stdout.split('\n').find((row) => row.includes('credits'))
  expect(line?.trim()).toBe('credits 75% left · $125,000.00/$500,000.00')
})

const FIVE_ACCOUNTS = ['main', 'work', 'personal', 'team', 'backup']

// OpenCode 1.18's session sidebar is 42 cells with 2 cells of padding each
// side, and its scrollbox puts a 1-cell scrollbar beside a slot box padded 1
// on the right, so a plugin gets 36 cells once the sidebar overflows.
for (const width of [36, 42]) {
  test(`${width}-column sidebar keeps every quota row and pacing subline of five accounts on one line`, async () => {
    const stdout = await renderSidebar(
      fiveAccountSidebarState(),
      ['backup', 'checked 1d6h ago', 'Routing'],
      false,
      { width, height: 70 },
    )
    const rows = expectOneLineQuotaRows(stdout, FIVE_ACCOUNTS)
    expect(rows).toHaveLength(15)
    expect(rows.map((row) => row.trim().split(' ')[0])).toEqual(
      FIVE_ACCOUNTS.flatMap(() => ['5h', '7d', 'Fa']),
    )
    expect(stdout).not.toContain('Fable')
    // One label column: every bar starts in the same cell.
    expect(new Set(rows.map((row) => row.search(/[█░▓▒]/)))).toEqual(
      new Set([4]),
    )
    // Every row here fits whole, so each keeps its reset after a space.
    for (const row of rows) expect(row).toMatch(/left( •)? +\d+[a-z]/)
    expect(stdout).toMatch(/deficit \d+% · out in \d+[a-z]/)
    expect(stdout).toMatch(/reserve \d+% · lasts to reset/)
    expect(stdout).toContain('credits 75% left · $12.50/$50.00')
  })
}

test('a 30-column sidebar drops resets that do not fit instead of wrapping rows or running text together', async () => {
  const stdout = await renderSidebar(
    fiveAccountSidebarState(),
    // The cents drop once the block has a measured width, so this waits for it.
    ['backup', 'checked 1d6h ago', 'Routing', '$12/$50'],
    false,
    { width: 30, height: 70 },
  )
  const rows = expectOneLineQuotaRows(stdout, FIVE_ACCOUNTS)
  expect(rows).toHaveLength(15)
  for (const row of rows) expect(row).toMatch(/^ \S+ +[█░▓▒]{10} \d+% left/)
  // `100% left •` leaves no room for ` 4h39m`, so that row has no reset; a
  // row that fits exactly keeps its one-cell gap.
  expect(rows).toContain(' 5h ▒░░░░░░░░░ 100% left •')
  expect(rows.some((row) => / 97% left \d+h\d+m$/.test(row))).toBe(true)
  expect(stdout).toMatch(/reserve \d+% · lasts to re…/)
})

test('scoped rows whose models share a short name extend it as the collapsed line does', async () => {
  const now = Date.now()
  const window = (used: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt: now,
    resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
  })
  const state = {
    main: {
      quota: {
        five_hour: window(10),
        seven_day: window(20),
        scoped: [
          {
            id: 'fable',
            title: 'Fable only',
            modelName: 'Fable',
            ...window(30),
          },
          {
            id: 'fabric',
            title: 'Fabric only',
            modelName: 'Fabric',
            ...window(90),
          },
        ],
      },
    },
    fallbacks: [
      {
        id: 'work',
        label: 'work',
        enabled: true,
        needsReauth: false,
        quota: { five_hour: window(5), seven_day: window(6) },
      },
    ],
    activeId: 'main',
    route: 'main',
    lastUpdated: now,
  }
  const expanded = await renderSidebar(
    state,
    ['Fabl', 'Fabr', 'work', 'Routing'],
    false,
    { width: 36, height: 40 },
  )
  const rows = expectOneLineQuotaRows(expanded, ['main', 'work'])
  expect(rows.map((row) => row.trim().split(' ')[0])).toEqual([
    '5h',
    '7d',
    'Fabl',
    'Fabr',
    '5h',
    '7d',
  ])
  // The column fits the longest label in the sidebar, across accounts.
  expect(new Set(rows.map((row) => row.search(/[█░▓▒]/)))).toEqual(new Set([6]))
  const collapsed = await renderSidebar(state, ['Fabr 10% left'], true, {
    width: 36,
  })
  expect(collapsed).toContain('5h 90% · 7d 80% · Fabr 10% left')
})
