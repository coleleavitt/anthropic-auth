/** @jsxImportSource @opentui/solid */

// The OAuth sign-in link dialog, shared by the OpenCode 1 and OpenCode 2 TUIs.
// The link is drawn as its own text block with nothing beside it, so however
// narrow the dialog is, the rows it wraps onto hold only link characters and
// selecting those rows copies the whole link. The dialog stays open until the
// person closes it.

import type { RGBA } from '@opentui/core'
import type { JSX } from 'solid-js'

export type SignInLinkColor = RGBA | string

/** Optional text colors; without them the host's default text color is used. */
export interface SignInLinkColors {
  readonly text?: SignInLinkColor
  readonly muted?: SignInLinkColor
  readonly link?: SignInLinkColor
}

export const SIGN_IN_LINK_TITLE = 'Claude sign-in'
export const SIGN_IN_LINK_INSTRUCTIONS =
  'Open this link in your browser and sign in. Then choose Finish OAuth sign-in in the Accounts menu and paste the code Claude shows you.'

/** The sign-in instructions and the link, without any dialog chrome. */
export function SignInLink(props: {
  readonly url: string
  readonly colors?: SignInLinkColors
  /** A heading above the instructions; hosts whose dialog has one omit it. */
  readonly title?: string
  /** What to do with the link; defaults to the native menu's next step. */
  readonly instructions?: string
  /** A line under the link, such as how to close the dialog. */
  readonly footer?: string
}): JSX.Element {
  return (
    <box flexDirection='column' paddingLeft={2} paddingRight={2}>
      {props.title ? (
        <box paddingBottom={1}>
          <text fg={props.colors?.text}>{props.title}</text>
        </box>
      ) : null}
      <text fg={props.colors?.muted}>
        {props.instructions ?? SIGN_IN_LINK_INSTRUCTIONS}
      </text>
      <box paddingTop={1} paddingBottom={1}>
        {/* Character wrapping fills every row: a link has no spaces to
            break at, and a word break would leave a short row. */}
        <text fg={props.colors?.link} wrapMode='char'>
          {props.url}
        </text>
      </box>
      {props.footer ? (
        <text fg={props.colors?.muted}>{props.footer}</text>
      ) : null}
    </box>
  )
}

// --- OpenCode 2 -------------------------------------------------------------

/** The OpenCode 2 TUI context members the sign-in dialog uses. */
export interface SignInLinkHost {
  readonly theme: {
    readonly text: {
      readonly base: SignInLinkColor
      readonly muted: SignInLinkColor
      readonly action: { readonly primary: { readonly base: SignInLinkColor } }
    }
  }
  readonly ui: {
    readonly dialog: {
      show(render: () => JSX.Element, onClose?: () => void): void
      set(options: { readonly size?: 'medium' | 'large' | 'xlarge' }): void
    }
  }
}

/**
 * Shows the sign-in link in an OpenCode 2 dialog. The returned promise
 * settles when the person closes the dialog, or when `signal` aborts.
 */
export function showSignInLinkDialog(
  host: SignInLinkHost,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    signal?.addEventListener('abort', () => resolve(), { once: true })
    host.ui.dialog.show(
      () => (
        <SignInLink
          url={url}
          title={SIGN_IN_LINK_TITLE}
          colors={{
            text: host.theme.text.base,
            muted: host.theme.text.muted,
            link: host.theme.text.action.primary.base,
          }}
          footer='Press Esc to close.'
        />
      ),
      () => resolve(),
    )
    // The widest dialog wraps the link onto the fewest rows.
    host.ui.dialog.set({ size: 'xlarge' })
  })
}
