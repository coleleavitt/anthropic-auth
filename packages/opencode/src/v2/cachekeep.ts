import {
  CacheKeepManager,
  type CacheKeepPrewarmAttempt,
  CacheKeepSessionRegistry,
  type CacheKeepTarget,
  getDefaultCacheKeepRegistryDirectory,
  isCacheKeepActiveNow,
  isCacheKeepHybridActive,
  isCacheKeepSubagentsEnabled,
  logger,
  type NativeAccountRuntime,
  type NativeAccountView,
} from '@cortexkit/anthropic-auth-core'
import type { Attempt, RequestScope } from '@cortexkit/common-auth/opencode2'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAttemptData,
} from './adapter'
import type { NativeSource, NativeSourceProvenance } from './source'

export interface NativeCacheKeepOptions {
  readonly now?: () => number
  readonly setIntervalImpl?: typeof globalThis.setInterval
  readonly clearIntervalImpl?: typeof globalThis.clearInterval
  readonly registryDirectory?: string
}

// Token refreshes preserve this identity; replacing a local row or a vault
// credential does not. Never warm a previous login's prefix on its replacement.
function accountKey(account: NativeAccountView) {
  return JSON.stringify([
    account.source,
    account.accountIdentity,
    account.credentialId,
    account.binding?.storageId,
    account.binding?.rowId,
    account.binding?.credentialEpoch,
  ])
}

type CacheKeepPolicyStorage = Awaited<
  ReturnType<NativeAccountRuntime['read']>
>['policyStorage']

/**
 * One plugin instance's lease on a shared CacheKeep. Prewarms run through the
 * newest live lease, so each send reads policy and authorization from a plugin
 * instance that OpenCode has not disposed.
 */
interface CacheKeepLease {
  readonly generation: number
  stopped: boolean
  readonly loadStorage: () => Promise<CacheKeepPolicyStorage>
  readonly send: (
    target: CacheKeepTarget,
    warm: Request,
    deadline?: AbortSignal,
  ) => Promise<Response>
  /** Sends this lease started; its disposal waits for them to settle. */
  readonly inflight: Set<Promise<unknown>>
}

/**
 * Tracked sessions for one account storage, shared by every plugin instance in
 * the host process that uses that storage. OpenCode 2 creates one plugin
 * instance per directory and disposes it when it evicts the directory or a
 * plugin file changes, so the tracked sessions must outlive any one instance.
 */
interface SharedCacheKeep {
  readonly manager: CacheKeepManager
  readonly registry: CacheKeepSessionRegistry
  readonly prepared: Map<
    number,
    {
      target: CacheKeepTarget
      attempt: CacheKeepPrewarmAttempt
      lease: CacheKeepLease
    }
  >
  /** Live leases by generation, in the order they were taken. */
  readonly leases: Map<number, CacheKeepLease>
  nextGeneration: number
  /** The scheduler pass in progress, so the last release can wait for it. */
  ticking?: Promise<void>
  /** Called after the last lease is released. */
  readonly retain: () => void
  /** Called when a lease is taken; resumes warming any retained sessions. */
  readonly adopt: () => void
}

// Kept on globalThis rather than in a module variable, so a plugin reload that
// imports this module again still finds the sessions the previous copy
// tracked. The version suffix keeps a future, differently shaped entry apart.
const SHARED_CACHE_KEEPS = Symbol.for(
  'cortexkit.anthropic-auth.opencode2.cachekeep.v1',
)

function sharedCacheKeeps(): Map<string, SharedCacheKeep> {
  const scope = globalThis as typeof globalThis & {
    [SHARED_CACHE_KEEPS]?: Map<string, SharedCacheKeep>
  }
  scope[SHARED_CACHE_KEEPS] ??= new Map()
  return scope[SHARED_CACHE_KEEPS]
}

function createSharedCacheKeep(
  storageId: string,
  options: NativeCacheKeepOptions,
): SharedCacheKeep {
  const prepared: SharedCacheKeep['prepared'] = new Map()
  const leases: SharedCacheKeep['leases'] = new Map()
  const registry = new CacheKeepSessionRegistry({
    directory:
      options.registryDirectory ||
      process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR ||
      getDefaultCacheKeepRegistryDirectory('opencode'),
    now: options.now,
  })
  const newestLease = () => {
    let newest: CacheKeepLease | undefined
    for (const lease of leases.values()) newest = lease
    return newest
  }
  const schedule = options.setIntervalImpl ?? globalThis.setInterval
  const manager: CacheKeepManager = new CacheKeepManager({
    loadStorage: async () => {
      const lease = newestLease()
      return lease ? lease.loadStorage() : null
    },
    now: options.now,
    // Return the tick's promise from the timer callback, so an injected timer
    // can await the scheduled pass; the last release also waits for it.
    setIntervalImpl: ((_callback: unknown, ms: number | undefined) =>
      schedule(() => {
        const pass = manager.tick()
        shared.ticking = pass.catch(() => {
          logger.warn('cachekeep', 'tick failed')
        })
        return shared.ticking
      }, ms)) as typeof globalThis.setInterval,
    clearIntervalImpl: options.clearIntervalImpl,
    // While no instance is live the sessions are only retained, not warmed,
    // so the shared session list for the status menu shows none of them.
    onTrackedSessionsChanged: (sessions) =>
      registry.publish(leases.size === 0 ? [] : sessions),
    prepareHeaders(_headers, target, attempt) {
      // Bind each prewarm to the newest live instance when it is prepared, so
      // it never authorizes through an instance OpenCode already disposed.
      const lease = newestLease()
      if (!lease) return undefined
      prepared.set(attempt.id, { target, attempt, lease })
      return new Headers({ 'x-native-cachekeep-attempt': String(attempt.id) })
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input as Request, init)
      const id = Number(request.headers.get('x-native-cachekeep-attempt'))
      const entry = prepared.get(id)
      prepared.delete(id)
      if (!entry || entry.lease.stopped)
        throw new Error('CacheKeep attempt is unavailable')
      const sending = entry.lease.send(
        entry.target,
        request as Request,
        entry.attempt.signal,
      )
      const settled = sending.then(
        () => {},
        () => {},
      )
      entry.lease.inflight.add(settled)
      void settled.then(() => entry.lease.inflight.delete(settled))
      return sending
    }) as typeof fetch,
    onComplete: ({ attempt }) => {
      prepared.delete(attempt.id)
    },
  })
  // OpenCode 2 disposes an evicted directory's instance before anything boots
  // that directory again, so the last release must not drop the sessions: a
  // new instance for this storage may adopt them while their cache is alive.
  // Only the request bodies stay, in memory; there is no timer sending
  // prewarms, no runtime and no credential until an instance adopts them.
  // A single timer deletes each body when its cache expires.
  let expiry: ReturnType<typeof setTimeout> | undefined
  const stopExpiry = () => {
    if (expiry !== undefined) clearTimeout(expiry)
    expiry = undefined
  }
  const dropExpired = () => {
    stopExpiry()
    if (leases.size > 0) return
    const earliest = manager.dropExpiredTargets()
    if (earliest === undefined) {
      const shareds = sharedCacheKeeps()
      if (shareds.get(storageId) === shared) shareds.delete(storageId)
      return
    }
    const now = options.now?.() ?? Date.now()
    expiry = setTimeout(dropExpired, Math.max(0, earliest - now))
    if (typeof expiry === 'object' && 'unref' in expiry) expiry.unref()
  }
  const shared: SharedCacheKeep = {
    manager,
    registry,
    prepared,
    leases,
    nextGeneration: 0,
    retain() {
      manager.stop()
      prepared.clear()
      dropExpired()
    },
    adopt() {
      stopExpiry()
      // A session whose cache expired while no instance was live has nothing
      // left to keep warm; drop it rather than prewarm it.
      if (manager.dropExpiredTargets() === undefined) return
      manager.start()
      registry.publish(manager.trackedSessions()).catch(() => {
        logger.warn('cachekeep', 'failed to publish tracked sessions')
      })
    },
  }
  return shared
}

/**
 * Keep admitted hybrid-cache prefixes warm using fresh native authorization for
 * each send. Instances for the same account storage share one set of tracked
 * sessions: a later instance takes over sending for sessions an earlier one
 * tracked, and the timer stops only when the last instance is disposed. The
 * sessions themselves outlive the last instance until their cache expires, so
 * an instance that boots for the same storage in that time adopts them.
 */
export function createNativeCacheKeep(
  options: NativeCacheKeepOptions & {
    runtime: NativeAccountRuntime
    source: NativeSource
    /** Identity of the account storage; instances that share it share sessions. */
    storageId: string
    fetch?: typeof fetch
    isSubagent?: (sessionID: string) => Promise<boolean>
  },
) {
  const { runtime, source } = options
  const abort = new AbortController()
  const shareds = sharedCacheKeeps()
  const owner =
    shareds.get(options.storageId) ??
    createSharedCacheKeep(options.storageId, options)
  shareds.set(options.storageId, owner)
  const { manager, registry } = owner
  const send = async (
    target: CacheKeepTarget,
    warm: Request,
    deadline?: AbortSignal,
  ) => {
    const signal = deadline
      ? AbortSignal.any([abort.signal, deadline])
      : abort.signal
    signal.throwIfAborted()
    const body = JSON.parse(await warm.text()) as { model: string }
    const scope: RequestScope = {
      providerID: 'anthropic',
      modelID: body.model,
      sessionID: `oc2-cachekeep:${target.id}`,
      agent: 'cachekeep',
      kind: 'generate',
    }
    const native = createNativeAnthropicAdapter({
      source: {
        ...source,
        // Background sends must not extend a user turn's billing or diagnostics
        // chain, nor register themselves as fresh live-session activity.
        onRequestPrepared: undefined,
        responseOptions: undefined,
        async requestOptions(input) {
          const policy = await source.requestOptions?.(input)
          return {
            ...policy,
            laneStart: false,
            billingLineage: undefined,
            cacheDiagnosticsPreviousMessageId: undefined,
          }
        },
        async authorizeAccount(input, accountId) {
          const snapshot = await runtime.read()
          signal.throwIfAborted()
          const account = snapshot.accounts.find((row) => row.id === accountId)
          if (
            account?.type !== 'oauth' ||
            accountKey(account) !== target.oauthAccountIdentity ||
            (target.isSubagent &&
              !isCacheKeepSubagentsEnabled(snapshot.policyStorage)) ||
            !isCacheKeepHybridActive(snapshot.policyStorage) ||
            !isCacheKeepActiveNow(
              snapshot.policyStorage,
              new Date(options.now?.() ?? Date.now()),
            )
          )
            return undefined
          const authorized = await source.authorizeAccount(input, accountId)
          if (
            authorized?.provenance.kind === 'local' &&
            accountKey({
              ...account,
              binding: authorized.provenance.subject.binding,
              accountIdentity: authorized.provenance.subject.binding.identity,
            }) !== target.oauthAccountIdentity
          )
            return undefined
          if (
            authorized?.provenance.kind === 'vault' &&
            authorized.provenance.credentialId !== account.credentialId
          )
            return undefined
          return authorized
        },
        async admitRequest(input) {
          await source.admitRequest?.(input)
          const snapshot = await runtime.read()
          const account = snapshot.accounts.find(
            (row) => row.id === input.accountId,
          )
          signal.throwIfAborted()
          if (
            !account ||
            accountKey(account) !== target.oauthAccountIdentity ||
            (target.isSubagent &&
              !isCacheKeepSubagentsEnabled(snapshot.policyStorage)) ||
            !isCacheKeepHybridActive(snapshot.policyStorage) ||
            !isCacheKeepActiveNow(
              snapshot.policyStorage,
              new Date(options.now?.() ?? Date.now()),
            )
          )
            throw new Error('CacheKeep policy changed before dispatch')
        },
      },
    })
    let attempt:
      | Attempt<NativeAnthropicAttemptData<NativeSourceProvenance>>
      | undefined
    let status: number | undefined
    let complete = false
    const cancel = () => native.forgetSession(scope.sessionID)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const accountId = (await runtime.read()).accounts.find(
        (account) => accountKey(account) === target.oauthAccountIdentity,
      )?.id
      if (!accountId) throw new Error('CacheKeep account is unavailable')
      const authorized = await native.adapter.accountHeaders({
        ...scope,
        accountId,
      })
      if (
        !('headers' in authorized) ||
        typeof authorized.headers !== 'object' ||
        authorized.headers === null ||
        typeof authorized.attempt !== 'object' ||
        authorized.attempt === null ||
        authorized.attempt.route !== 'oauth'
      )
        throw new Error('CacheKeep authorization refused')
      attempt = {
        ...scope,
        accountId,
        attemptId: crypto.randomUUID(),
        transport: 'http',
        data: authorized.attempt,
      }
      const request = await native.adapter.rewriteRequest?.({
        ...scope,
        accountId,
        attempt,
        request: new Request(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }),
      })
      if (!request) throw new Error('CacheKeep rewrite refused')
      signal.throwIfAborted()
      const physical = await (options.fetch ?? fetch)(request)
      const response = await native.adapter.rewriteResponse?.({
        ...scope,
        accountId,
        attempt,
        request,
        response: physical,
      })
      if (!response) throw new Error('CacheKeep response rewrite refused')
      status = response.status
      native.adapter.quotaFromHeaders?.(
        response.headers,
        response.status,
        attempt,
      )
      if (!response.ok)
        await native.adapter.limitFromResponse?.({
          status,
          headers: response.headers,
          body: () => response.clone().text(),
          attempt,
        })
      const bytes = await response.arrayBuffer()
      complete = true
      return new Response(bytes, { status, headers: response.headers })
    } catch {
      // The manager's transport headers contain only a correlation ID, so its
      // generic error scrubber cannot know the native send's credentials.
      throw new Error('Native CacheKeep was not completed')
    } finally {
      signal.removeEventListener('abort', cancel)
      try {
        if (attempt)
          await native.adapter.onAttemptEnd?.(attempt, {
            status,
            outputStarted: false,
            ...(complete ? {} : { error: { reason: 'cancelled' as const } }),
          })
      } finally {
        native.dispose()
        source.forgetSession?.(scope.sessionID)
      }
    }
  }
  const lease: CacheKeepLease = {
    generation: owner.nextGeneration++,
    stopped: false,
    loadStorage: async () => (await runtime.read()).policyStorage,
    send,
    inflight: new Set(),
  }
  const adopting = owner.leases.size === 0
  owner.leases.set(lease.generation, lease)
  if (adopting) owner.adopt()
  let cleanup: Promise<void> | undefined
  return {
    async track(
      input: Parameters<NonNullable<NativeSource['onRequestPrepared']>>[0],
    ) {
      if (
        lease.stopped ||
        input.route !== 'oauth' ||
        input.agent === 'cachekeep' ||
        input.agent === 'prime' ||
        input.kind !== 'primary'
      )
        return
      const snapshot = await runtime.read()
      if (lease.stopped || !isCacheKeepHybridActive(snapshot.policyStorage))
        return
      let isSubagent = false
      try {
        isSubagent = (await options.isSubagent?.(input.sessionID)) ?? false
      } catch {
        // A missing host session record cannot justify background spending.
        return
      }
      if (
        lease.stopped ||
        (isSubagent && !isCacheKeepSubagentsEnabled(snapshot.policyStorage))
      )
        return
      const account = snapshot.accounts.find(
        (row) => row.id === input.accountId,
      )
      if (!account?.accountIdentity) return
      if (
        input.provenance.kind === 'local' &&
        JSON.stringify(account.binding) !==
          JSON.stringify(input.provenance.subject.binding)
      )
        return
      if (
        input.provenance.kind === 'vault' &&
        account.credentialId !== input.provenance.credentialId
      )
        return
      manager.track({
        sessionId: input.sessionID,
        url: input.url,
        headers: new Headers(),
        bodyText: input.bodyText,
        storage: snapshot.policyStorage,
        cacheMode: 'hybrid',
        oauthAccountId: input.accountId,
        oauthAccountIdentity: accountKey(account),
        isSubagent,
      })
      await registry.publish(manager.trackedSessions())
    },
    registry,
    dispose() {
      if (cleanup) return cleanup
      lease.stopped = true
      abort.abort()
      for (const [id, entry] of owner.prepared)
        if (entry.lease === lease) owner.prepared.delete(id)
      // Only this instance's own lease is released. A predecessor disposed
      // after its successor started leaves the successor's sessions and timer
      // alone; the timer stops only when no instance holds a lease.
      const last =
        owner.leases.delete(lease.generation) && owner.leases.size === 0
      if (last) owner.retain()
      cleanup = (async () => {
        try {
          // Join a scheduler pass already in progress. With no lease left it
          // cannot authorize or send anything more.
          if (last) await owner.ticking
          // Sends this instance started use its runtime, which the caller
          // closes after disposal; wait for them to observe the abort.
          await Promise.all(lease.inflight)
        } finally {
          // Retained sessions are not being warmed, so withdraw them from the
          // shared session list unless another instance adopted them already.
          if (last && owner.leases.size === 0) await registry.dispose()
        }
      })()
      return cleanup
    },
  }
}
