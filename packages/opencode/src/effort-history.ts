import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type AdaptiveEffort,
  isClaudeFable51Model,
  normalizeAdaptiveEffort,
} from '@cortexkit/anthropic-auth-core'

const MAX_EFFORT_MARKERS = 512
const EFFORT_MARKER_SIGNATURE_BYTES = 16
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const effortMarkerSecret = randomBytes(32)

const EFFORT_CODES: Record<AdaptiveEffort, string> = {
  low: 'l',
  medium: 'm',
  high: 'h',
  xhigh: 'x',
  max: 'z',
}
const EFFORTS_BY_CODE = Object.fromEntries(
  Object.entries(EFFORT_CODES).map(([effort, code]) => [code, effort]),
) as Record<string, AdaptiveEffort>

export const EFFORT_MARKER_PREFIX = '<cortexkit-internal-effort '
export const EFFORT_PLAN_MARKER_PREFIX = '<cortexkit-internal-effort-plan '

export type OpenCodeEffortMarkerPlan = {
  nonce: string
  baseline: AdaptiveEffort
  markerCount: number
}

export class EffortMarkerCorrelationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EffortMarkerCorrelationError'
  }
}

type OpenCodeMessageInfo = {
  id?: unknown
  role?: unknown
  model?: {
    providerID?: unknown
    modelID?: unknown
    variant?: unknown
  }
}

type MutableOpenCodePart = Record<string, unknown> & {
  type?: unknown
  text?: unknown
  ignored?: unknown
  mime?: unknown
}

type MutableOpenCodeMessage = {
  info?: OpenCodeMessageInfo
  parts?: MutableOpenCodePart[]
}

type ParsedTransitionMarker = {
  nonce: string
  effort: AdaptiveEffort
}

type ParsedUserMessage = {
  value: unknown
  transitions: ParsedTransitionMarker[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFableUser(item: MutableOpenCodeMessage | undefined): boolean {
  return (
    item?.info?.role === 'user' &&
    item.info.model?.providerID === 'anthropic' &&
    isClaudeFable51Model(item.info.model.modelID)
  )
}

function hasLowerableUserPart(item: MutableOpenCodeMessage): boolean {
  return (
    item.parts?.some((part) => {
      if (part.type === 'text') {
        return part.ignored !== true && part.text !== ''
      }
      if (part.type === 'file') {
        return (
          part.mime !== 'text/plain' && part.mime !== 'application/x-directory'
        )
      }
      return part.type === 'compaction' || part.type === 'subtask'
    }) ?? false
  )
}

function markerSignature(payload: string): string {
  return createHmac('sha256', effortMarkerSecret)
    .update(payload)
    .digest('hex')
    .slice(0, EFFORT_MARKER_SIGNATURE_BYTES * 2)
}

function validMarkerSignature(payload: string, signature: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(signature)) return false
  const expected = Buffer.from(markerSignature(payload), 'hex')
  const actual = Buffer.from(signature, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function parseTransitionMarker(text: string): ParsedTransitionMarker | null {
  const match = text.match(
    new RegExp(
      `^${EFFORT_MARKER_PREFIX}nonce="(${UUID_PATTERN})" effort="([lmhxz])" sig="([0-9a-f]{32})"/>$`,
    ),
  )
  if (!match) return null
  const [, nonce, effortCode, signature] = match
  const effort = EFFORTS_BY_CODE[effortCode ?? '']
  if (
    !nonce ||
    !effortCode ||
    !signature ||
    !effort ||
    !validMarkerSignature(`transition:${nonce}:${effortCode}`, signature)
  ) {
    return null
  }
  return { nonce, effort }
}

function parsePlanMarker(text: string): OpenCodeEffortMarkerPlan | null {
  const match = text.match(
    new RegExp(
      `^${EFFORT_PLAN_MARKER_PREFIX}nonce="(${UUID_PATTERN})" baseline="([lmhxz])" count="([0-9a-z]+)" sig="([0-9a-f]{32})"/>$`,
    ),
  )
  if (!match) return null
  const [, nonce, baselineCode, countCode, signature] = match
  const baseline = EFFORTS_BY_CODE[baselineCode ?? '']
  const markerCount = Number.parseInt(countCode ?? '', 36)
  if (
    !nonce ||
    !baselineCode ||
    !countCode ||
    !signature ||
    !baseline ||
    !Number.isSafeInteger(markerCount) ||
    markerCount < 0 ||
    markerCount > MAX_EFFORT_MARKERS ||
    !validMarkerSignature(
      `plan:${nonce}:${baselineCode}:${countCode}`,
      signature,
    )
  ) {
    return null
  }
  return { nonce, baseline, markerCount }
}

function removeAuthenticatedMarkers(messages: MutableOpenCodeMessage[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue
    message.parts = message.parts.filter((part) => {
      if (
        part.type !== 'text' ||
        typeof part.text !== 'string' ||
        !part.text.includes('<cortexkit-internal-effort')
      ) {
        return true
      }
      return !parseTransitionMarker(part.text) && !parsePlanMarker(part.text)
    })
  }
}

function transitionMarker(nonce: string, effort: AdaptiveEffort): string {
  const effortCode = EFFORT_CODES[effort]
  const signature = markerSignature(`transition:${nonce}:${effortCode}`)
  return `${EFFORT_MARKER_PREFIX}nonce="${nonce}" effort="${effortCode}" sig="${signature}"/>`
}

function planMarker(plan: OpenCodeEffortMarkerPlan): string {
  const baselineCode = EFFORT_CODES[plan.baseline]
  const markerCount = plan.markerCount.toString(36)
  const signature = markerSignature(
    `plan:${plan.nonce}:${baselineCode}:${markerCount}`,
  )
  return `${EFFORT_PLAN_MARKER_PREFIX}nonce="${plan.nonce}" baseline="${baselineCode}" count="${markerCount}" sig="${signature}"/>`
}

/**
 * Annotate effort-changing user turns before OpenCode lowers its internal
 * message records into Anthropic messages. A signed plan marker on the current
 * user turn makes the lowered request self-contained and concurrency-safe.
 */
export function markOpenCodeEffortTransitions(
  messages: MutableOpenCodeMessage[],
  nonce: string,
): OpenCodeEffortMarkerPlan | null {
  const currentUser = messages.findLast((item) => item.info?.role === 'user')
  if (!currentUser || !isFableUser(currentUser)) return null

  removeAuthenticatedMarkers(messages)
  if (!Array.isArray(currentUser.parts) || !hasLowerableUserPart(currentUser)) {
    return null
  }

  const compaction = messages.findLast(
    (item) =>
      item.info?.role === 'user' &&
      item.parts?.some((part) => part.type === 'compaction'),
  )
  const compactionId =
    typeof compaction?.info?.id === 'string' ? compaction.info.id : undefined
  let baseline: AdaptiveEffort | undefined
  let activeEffort: AdaptiveEffort | undefined
  if (compaction && isFableUser(compaction)) {
    baseline =
      normalizeAdaptiveEffort(compaction.info?.model?.variant) ?? 'high'
    activeEffort = baseline
  }

  let markerCount = 0
  for (const item of messages) {
    const info = item.info
    if (info?.role !== 'user') continue
    if (
      compactionId &&
      typeof info.id === 'string' &&
      info.id <= compactionId
    ) {
      continue
    }
    if (!isFableUser(item) || !hasLowerableUserPart(item)) continue

    const effort = normalizeAdaptiveEffort(info.model?.variant) ?? 'high'
    if (!baseline) {
      baseline = effort
      activeEffort = effort
      continue
    }
    if (effort === activeEffort) continue
    if (markerCount >= MAX_EFFORT_MARKERS) {
      throw new EffortMarkerCorrelationError(
        'Too many Fable 5.1 effort changes in the active context',
      )
    }
    if (!Array.isArray(item.parts)) {
      throw new EffortMarkerCorrelationError(
        'Cannot mark a Fable 5.1 effort change without message parts',
      )
    }
    item.parts.push({ type: 'text', text: transitionMarker(nonce, effort) })
    markerCount++
    activeEffort = effort
  }

  if (!baseline) return null
  const plan = { nonce, baseline, markerCount }
  currentUser.parts.push({ type: 'text', text: planMarker(plan) })
  return plan
}

function consumeInternalMarkers(body: Record<string, unknown>): {
  messages: ParsedUserMessage[]
  plans: OpenCodeEffortMarkerPlan[]
} {
  const values = Array.isArray(body.messages) ? body.messages : []
  const plans: OpenCodeEffortMarkerPlan[] = []
  const messages: ParsedUserMessage[] = []
  const planPattern = new RegExp(
    `${EFFORT_PLAN_MARKER_PREFIX}nonce="(${UUID_PATTERN})" baseline="([lmhxz])" count="([0-9a-z]+)" sig="([0-9a-f]{32})"/>`,
    'g',
  )
  const transitionPattern = new RegExp(
    `${EFFORT_MARKER_PREFIX}nonce="(${UUID_PATTERN})" effort="([lmhxz])" sig="([0-9a-f]{32})"/>`,
    'g',
  )

  for (const value of values) {
    const transitions: ParsedTransitionMarker[] = []
    if (!isRecord(value) || value.role !== 'user') {
      messages.push({ value, transitions })
      continue
    }

    const stripText = (text: string): string => {
      const withoutPlans = text.replace(planPattern, (marker) => {
        const plan = parsePlanMarker(marker)
        if (!plan) return marker
        plans.push(plan)
        return ''
      })
      return withoutPlans.replace(transitionPattern, (marker) => {
        const transition = parseTransitionMarker(marker)
        if (!transition) return marker
        transitions.push(transition)
        return ''
      })
    }

    if (typeof value.content === 'string') {
      value.content = stripText(value.content)
    } else if (Array.isArray(value.content)) {
      value.content = value.content.flatMap((block) => {
        if (
          !isRecord(block) ||
          block.type !== 'text' ||
          typeof block.text !== 'string'
        ) {
          return [block]
        }
        const stripped = stripText(block.text)
        if (stripped === '' && block.text !== '') return []
        return [{ ...block, text: stripped }]
      })
    }
    messages.push({ value, transitions })
  }

  return { messages, plans }
}

/** Consume authenticated markers and insert Anthropic effort system messages. */
export function applyOpenCodeEffortMarkers(
  body: Record<string, unknown>,
  enabled: boolean,
): { found: number; inserted: number } {
  if (!Array.isArray(body.messages)) return { found: 0, inserted: 0 }
  const hasCandidate = body.messages.some((value) => {
    if (!isRecord(value) || value.role !== 'user') return false
    if (
      typeof value.content === 'string' &&
      value.content.includes('<cortexkit-internal-effort')
    ) {
      return true
    }
    return (
      Array.isArray(value.content) &&
      value.content.some(
        (block) =>
          isRecord(block) &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('<cortexkit-internal-effort'),
      )
    )
  })
  if (!hasCandidate) return { found: 0, inserted: 0 }

  const consumed = consumeInternalMarkers(body)
  const found = consumed.messages.reduce(
    (count, message) => count + message.transitions.length,
    0,
  )
  if (consumed.plans.length === 0) {
    if (found > 0) {
      throw new EffortMarkerCorrelationError(
        'Missing internal Fable 5.1 effort marker plan',
      )
    }
    return { found: 0, inserted: 0 }
  }
  if (consumed.plans.length !== 1) {
    throw new EffortMarkerCorrelationError(
      'Multiple internal Fable 5.1 effort marker plans',
    )
  }

  const plan = consumed.plans[0] as OpenCodeEffortMarkerPlan
  for (const message of consumed.messages) {
    if (message.transitions.length > 1) {
      throw new EffortMarkerCorrelationError(
        'Multiple Fable 5.1 effort markers resolved to one user boundary',
      )
    }
    const transition = message.transitions[0]
    if (transition && transition.nonce !== plan.nonce) {
      throw new EffortMarkerCorrelationError(
        'Fable 5.1 effort marker nonce mismatch',
      )
    }
  }
  if (found !== plan.markerCount) {
    throw new EffortMarkerCorrelationError(
      `Fable 5.1 effort marker correlation failed: expected ${plan.markerCount}, found ${found}`,
    )
  }

  const applyConfig = enabled && isClaudeFable51Model(body.model)
  let inserted = 0
  const rewritten: unknown[] = []
  for (const message of consumed.messages) {
    const transition = message.transitions[0]
    if (transition && applyConfig) {
      rewritten.push({
        role: 'system',
        content: [],
        output_config: { effort: transition.effort },
      })
      inserted++
    }
    rewritten.push(message.value)
  }
  body.messages = rewritten
  if (applyConfig) {
    const outputConfig = isRecord(body.output_config) ? body.output_config : {}
    body.output_config = { ...outputConfig, effort: plan.baseline }
  }
  return { found, inserted }
}
