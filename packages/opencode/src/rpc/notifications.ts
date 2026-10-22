import type { CommandDialogPayload } from '@cortexkit/anthropic-auth-core'
import type { OpenDialogPayload, RpcNotification } from './protocol'

const QUEUE_CAP = 100
const TUI_CONNECTED_WINDOW_MS = 3_000

// One queue serves every RPC server in the process, and a process can hold one
// server per project directory. Session ids are globally unique, so both
// producers and drains require one: an unscoped drain could otherwise expose
// another project's pending command dialog.
let queue: RpcNotification[] = []
let nextId = 1
const lastDrainAtBySession = new Map<string, number>()
// Callbacks waiting for a TUI to drain a specific notification, keyed by
// notification id. See pushNotificationAwaitingPickup.
const pickupWaiters = new Map<
  number,
  { readonly picked: () => void; readonly cancel: () => void }
>()

export interface PickupWaitOptions {
  /** How long the server waits for a TUI to drain the notification. */
  readonly timeoutMs: number
  /** Injected so tests can drive the deadline without real time passing. */
  readonly setTimeout: typeof globalThis.setTimeout
  readonly clearTimeout: typeof globalThis.clearTimeout
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('sessionId is required')
  }
}

/** Queue a dialog for the session's TUI and return the notification id. */
export function pushNotification(
  payload: OpenDialogPayload | CommandDialogPayload,
  sessionId: string,
): number {
  assertSessionId(sessionId)
  const id = nextId++
  if ('menu' in payload) {
    if (payload.command !== 'claude' || payload.menu.command !== 'claude')
      throw new TypeError('Only the claude menu is supported')
    queue.push({ id, type: 'open-menu', payload, sessionId })
  } else {
    queue.push({ id, type: 'open-dialog', payload, sessionId })
  }
  if (queue.length > QUEUE_CAP) queue = queue.slice(queue.length - QUEUE_CAP)
  return id
}

/**
 * Queue a dialog and wait for a TUI to drain it. Resolves true as soon as a
 * drain for the session hands the notification out, which only a running TUI
 * does. Resolves false when the deadline passes first; the notification is
 * then removed, so a TUI that starts later does not open a stale dialog after
 * the caller has already answered some other way.
 */
export function pushNotificationAwaitingPickup(
  payload: OpenDialogPayload | CommandDialogPayload,
  sessionId: string,
  options: PickupWaitOptions,
): Promise<boolean> {
  // The push and the waiter registration happen in the same synchronous
  // step, so no drain can hand the notification out before it is watched.
  const id = pushNotification(payload, sessionId)
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    pickupWaiters.set(id, {
      picked() {
        if (timer !== undefined) options.clearTimeout(timer)
        resolve(true)
      },
      cancel() {
        if (timer !== undefined) options.clearTimeout(timer)
        resolve(false)
      },
    })
    // Started after the waiter is registered, so a timer that fires at once
    // still finds and removes it.
    timer = options.setTimeout(() => {
      if (!pickupWaiters.delete(id)) return
      queue = queue.filter((notification) => notification.id !== id)
      resolve(false)
    }, options.timeoutMs)
  })
}

export function drainNotifications(
  lastReceivedId: number,
  sessionId: string,
): RpcNotification[] {
  assertSessionId(sessionId)
  lastDrainAtBySession.set(sessionId, Date.now())
  if (lastReceivedId > 0) {
    queue = queue.filter(
      (notification) =>
        notification.id > lastReceivedId ||
        notification.sessionId !== sessionId,
    )
  }
  const pending = queue.filter(
    (notification) =>
      notification.id > lastReceivedId && notification.sessionId === sessionId,
  )
  for (const notification of pending) {
    const waiter = pickupWaiters.get(notification.id)
    if (!waiter) continue
    pickupWaiters.delete(notification.id)
    waiter.picked()
  }
  return pending
}

export function isTuiConnected(sessionId: string): boolean {
  const now = Date.now()
  const at = lastDrainAtBySession.get(sessionId) ?? 0
  return at > 0 && now - at < TUI_CONNECTED_WINDOW_MS
}

export function resetNotificationsForTest(): void {
  queue = []
  nextId = 1
  lastDrainAtBySession.clear()
  // Cancel outstanding deadlines too: ids restart at 1, so a late deadline
  // would otherwise withdraw a newer notification that reuses its id.
  for (const waiter of pickupWaiters.values()) waiter.cancel()
  pickupWaiters.clear()
}
