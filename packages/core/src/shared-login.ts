import {
  type OAuthLoopbackSession,
  startOAuthLoopbackSession,
} from './oauth-loopback.ts'
import {
  type SharedLogin,
  type SharedLoginMode,
  startSharedLogin,
} from './shared-account-store.ts'

export type SharedLoginWithLoopback = {
  login: SharedLogin
  /** Null when no loopback listener could be bound (manual paste only). */
  loopback: OAuthLoopbackSession | null
}

/**
 * Begin a store login, with a loopback listener when one can be bound.
 *
 * The Rust binding owns the PKCE verifier and exchanges the code itself, so
 * no token reaches JavaScript. The loopback starts first (its redirect URI
 * depends on the bound port) and the binding login is created for that
 * redirect URI and the state the listener already expects. Callers race
 * `loopback.waitForCallback()` against a manual paste and pass the result to
 * `login.complete`.
 */
export async function startSharedLoginWithLoopback(
  options: {
    mode?: SharedLoginMode
    loginHint?: string
    loopback?: boolean
  } = {},
): Promise<SharedLoginWithLoopback> {
  let loopback: OAuthLoopbackSession | null = null
  if (options.loopback !== false) {
    loopback = await startOAuthLoopbackSession().catch(() => null)
  }
  try {
    const login = startSharedLogin({
      mode: options.mode,
      loginHint: options.loginHint,
      ...(loopback
        ? { redirectUri: loopback.redirectUri, state: loopback.state }
        : {}),
    })
    return { login, loopback }
  } catch (error) {
    await loopback?.close().catch(() => {})
    throw error
  }
}
