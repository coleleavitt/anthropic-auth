/** @jsxImportSource @opentui/solid */

// The status view of the OpenCode 2 `/claude` menu. Core writes a section's
// status as plain lines, some of them Markdown: the quota summary has `##`
// headings and indented `-` bullets. This view draws headings and bullets as
// styled text instead of showing their markers. For the Quota section it draws
// the account blocks of OpenCode 1's quota view, read from the same server
// state as the sidebar, and falls back to the text when that read fails.

import { TextAttributes } from '@opentui/core'
import { createSignal, For, type JSX, Show } from 'solid-js'
import type { SidebarState } from '../sidebar-state.js'
import {
  type AnthropicAuthTuiPrefs,
  readTuiPreferencesFile,
  resolveAnthropicAuthPrefs,
} from '../tui-preferences.js'
import {
  AccountBlock,
  type HostTheme,
  type SidebarTheme,
  sidebarThemeFromHost,
} from './claude-sidebar.js'

/** One status line, classified for drawing. */
export type StatusLine =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'bullet'; readonly indent: number; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'blank' }

// The widest indent kept for a bullet; deeper nesting is drawn at this indent.
const MAX_BULLET_INDENT = 8

// The width of OpenCode 1's quota view (`QuotaDialogContent` in `tui.tsx`).
const QUOTA_VIEW_WIDTH = 58

/**
 * Splits a section's status lines (each may hold several lines) and classifies
 * each one. Only line-leading Markdown is read: `#` headings and `-`, `*` or
 * `+` bullets. Everything else, including any `*` inside a line, stays as
 * written. Runs of blank lines collapse to one, and leading or trailing blank
 * lines are dropped.
 */
export function parseStatusLines(lines: readonly string[]): StatusLine[] {
  const parsed: StatusLine[] = []
  for (const raw of lines.join('\n').split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      if (parsed.length && parsed.at(-1)?.kind !== 'blank')
        parsed.push({ kind: 'blank' })
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line)
    if (heading?.[1] && heading[2]) {
      parsed.push({
        kind: 'heading',
        level: heading[1].length,
        text: heading[2],
      })
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(line)
    if (bullet?.[2]) {
      parsed.push({
        kind: 'bullet',
        indent: Math.min(bullet[1]?.length ?? 0, MAX_BULLET_INDENT),
        text: bullet[2],
      })
      continue
    }
    parsed.push({ kind: 'text', text: line })
  }
  if (parsed.at(-1)?.kind === 'blank') parsed.pop()
  return parsed
}

/** Draws one status line; headings and bullets lose their Markdown markers. */
function StatusRow(props: {
  readonly line: StatusLine
  readonly theme: SidebarTheme
}): JSX.Element {
  const line = props.line
  switch (line.kind) {
    case 'heading':
      return (
        <text
          // Top-level headings take the accent color; lower levels, such as
          // one account in the quota summary, stay in the text color.
          fg={line.level <= 2 ? props.theme.accent : props.theme.text}
          attributes={TextAttributes.BOLD}
        >
          {line.text}
        </text>
      )
    case 'bullet':
      return (
        // The text sits in its own column, so a long bullet wraps under its
        // first word instead of under the bullet mark.
        <box flexDirection='row' paddingLeft={line.indent}>
          <text fg={props.theme.textMuted} flexShrink={0}>
            {'• '}
          </text>
          <text fg={props.theme.text} flexGrow={1} flexShrink={1}>
            {line.text}
          </text>
        </box>
      )
    case 'text':
      return <text fg={props.theme.text}>{line.text}</text>
    default:
      return <box height={1} />
  }
}

/** Draws status lines with headings and bullets styled, not as Markdown. */
export function StatusText(props: {
  readonly lines: readonly string[]
  readonly theme: SidebarTheme
}): JSX.Element {
  return (
    <box flexDirection='column' width='100%'>
      <For each={parseStatusLines(props.lines)}>
        {(line) => <StatusRow line={line} theme={props.theme} />}
      </For>
    </box>
  )
}

/**
 * OpenCode 1's quota view: one account block for main and for each enabled or
 * vault-held fallback, as the sidebar draws them.
 */
export function QuotaStatus(props: {
  readonly state: SidebarState
  readonly theme: SidebarTheme
  readonly prefs: AnthropicAuthTuiPrefs
  readonly now: number
}): JSX.Element {
  const fallbacks = () =>
    (props.state.fallbacks ?? []).filter(
      (fallback) =>
        fallback.enabled ||
        (fallback.custodyState && fallback.custodyState !== 'off'),
    )
  return (
    // As wide as OpenCode 1's quota view: wider, the reset times drift far
    // from the bars they belong to.
    <box flexDirection='column' width='100%' maxWidth={QUOTA_VIEW_WIDTH}>
      <AccountBlock
        theme={props.theme}
        appearance={props.prefs.appearance}
        name='main'
        quota={props.state.main?.quota}
        active={props.state.activeId === 'main'}
        pacingEnabled={props.prefs.sections.pacing}
        tierLabel={props.state.main?.tierLabel}
        stateLine={props.state.main?.stateLine}
        quotaDated={props.state.main?.quotaDated}
        now={props.now}
      />
      <Show when={props.prefs.sections.fallbackAccounts}>
        <For each={fallbacks()}>
          {(fallback) => (
            <AccountBlock
              theme={props.theme}
              appearance={props.prefs.appearance}
              name={fallback.label ?? fallback.id}
              quota={fallback.quota}
              active={props.state.activeId === fallback.id}
              pacingEnabled={props.prefs.sections.pacing}
              tierLabel={fallback.tierLabel}
              needsReauth={fallback.needsReauth}
              vaultReauth={fallback.vaultReauth}
              stateLine={fallback.stateLine}
              quotaDated={fallback.quotaDated}
              marginTop={1}
              now={props.now}
            />
          )}
        </For>
      </Show>
    </box>
  )
}

// --- OpenCode 2 -------------------------------------------------------------

/** One section's status, as the `/claude` menu hands it over. */
export interface MenuStatusView {
  readonly title: string
  readonly lines: readonly string[]
  /**
   * Reads the sidebar's quota state; given for the Quota section only, whose
   * view then draws account blocks instead of the text.
   */
  readonly readQuota?: (signal: AbortSignal) => Promise<SidebarState>
}

/** The OpenCode 2 TUI context members the status dialog uses. */
export interface MenuStatusHost {
  readonly theme: HostTheme
  readonly ui: {
    readonly dialog: {
      show(render: () => JSX.Element, onClose?: () => void): void
      set(options: { readonly size?: 'medium' | 'large' | 'xlarge' }): void
    }
  }
}

type QuotaView =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready'
      readonly state: SidebarState
      readonly prefs: AnthropicAuthTuiPrefs
    }
  | { readonly kind: 'failed' }

type ReadyQuota = Extract<QuotaView, { readonly kind: 'ready' }>

/**
 * Shows a section's status in a wide OpenCode 2 dialog. The returned promise
 * settles when the person closes the dialog, or when `signal` aborts.
 */
export function showMenuStatusDialog(
  host: MenuStatusHost,
  view: MenuStatusView,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    // Stops the quota read once the dialog closes or the menu goes away.
    const reading = new AbortController()
    const close = () => {
      reading.abort()
      resolve()
    }
    signal?.addEventListener('abort', close, { once: true })
    const [quota, setQuota] = createSignal<QuotaView>({ kind: 'loading' })
    const readQuota = view.readQuota
    if (readQuota)
      void Promise.all([
        readQuota(reading.signal),
        readTuiPreferencesFile().then(resolveAnthropicAuthPrefs),
      ]).then(
        ([state, prefs]) => {
          if (!reading.signal.aborted) setQuota({ kind: 'ready', state, prefs })
        },
        () => {
          // An older server without the sidebar method, or a failed read:
          // the status text still says everything the blocks would.
          if (!reading.signal.aborted) setQuota({ kind: 'failed' })
        },
      )
    const ready = () => {
      const current = quota()
      return current.kind === 'ready' ? current : undefined
    }
    const theme = () => sidebarThemeFromHost(host.theme)
    host.ui.dialog.show(
      () => (
        <box flexDirection='column' paddingLeft={2} paddingRight={2}>
          <box paddingBottom={1}>
            <text fg={theme().text} attributes={TextAttributes.BOLD}>
              {view.title}
            </text>
          </box>
          <Show
            when={readQuota && quota().kind !== 'failed'}
            fallback={<StatusText lines={view.lines} theme={theme()} />}
          >
            <Show
              when={ready()}
              fallback={
                <text fg={theme().textMuted}>{'Reading quota\u2026'}</text>
              }
            >
              {(ready: () => ReadyQuota) => (
                <QuotaStatus
                  state={ready().state}
                  prefs={ready().prefs}
                  theme={theme()}
                  now={Date.now()}
                />
              )}
            </Show>
          </Show>
          <box paddingTop={1}>
            <text fg={theme().textMuted}>Press Esc to close.</text>
          </box>
        </box>
      ),
      close,
    )
    // The widest dialog gives the account blocks their full width and wraps
    // status text as little as it can.
    host.ui.dialog.set({ size: 'xlarge' })
  })
}
