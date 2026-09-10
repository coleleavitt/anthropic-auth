import { describe, expect, test } from 'bun:test'
import {
  CLAUDE_OPUS_5_ADAPTIVE_THINKING,
  CLAUDE_OPUS_5_MODEL_ID,
  canonicalClaudeModelId,
  clampEffortForModel,
  isClaudeOpus5Model,
  isClaudeSonnet5Model,
  modelAllowsForcedManualThinking,
  modelSupportsAdaptiveThinking,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  resolveClaudeFableMythos5Pricing,
  resolveThinkingShape,
} from '../models'

describe('isClaudeSonnet5Model', () => {
  test('matches the bare claude-sonnet-5 id', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5')).toBe(true)
  })

  test('matches a dated claude-sonnet-5 snapshot', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5-20260630')).toBe(true)
  })

  test('does not match claude-sonnet-4-6', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-4-6')).toBe(false)
  })

  test('does not match the Fable/Mythos ids', () => {
    expect(isClaudeSonnet5Model('claude-fable-5')).toBe(false)
    expect(isClaudeSonnet5Model('claude-mythos-5')).toBe(false)
  })

  test('does not match a non-dash prefix collision', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5x')).toBe(false)
  })

  test('does not match non-string input', () => {
    expect(isClaudeSonnet5Model(undefined)).toBe(false)
    expect(isClaudeSonnet5Model(42)).toBe(false)
  })
})

describe('isClaudeOpus5Model', () => {
  test('exposes the bare id constant', () => {
    expect(CLAUDE_OPUS_5_MODEL_ID).toBe('claude-opus-5')
  })

  test('matches the bare claude-opus-5 id', () => {
    expect(isClaudeOpus5Model('claude-opus-5')).toBe(true)
  })

  test('matches the catalog claude-opus-5-fast variant', () => {
    expect(isClaudeOpus5Model('claude-opus-5-fast')).toBe(true)
  })

  test('matches a dated claude-opus-5 snapshot', () => {
    expect(isClaudeOpus5Model('claude-opus-5-20260701')).toBe(true)
  })

  test('matches the dated fast snapshot', () => {
    expect(isClaudeOpus5Model('claude-opus-5-fast-20260701')).toBe(true)
  })

  test('does not match claude-opus-4-8', () => {
    expect(isClaudeOpus5Model('claude-opus-4-8')).toBe(false)
  })

  test('does not match a non-dash prefix collision', () => {
    expect(isClaudeOpus5Model('claude-opus-5x')).toBe(false)
  })

  test('does not match the Fable/Mythos ids', () => {
    expect(isClaudeOpus5Model('claude-fable-5')).toBe(false)
    expect(isClaudeOpus5Model('claude-mythos-5')).toBe(false)
  })

  test('does not match Sonnet 5', () => {
    expect(isClaudeOpus5Model('claude-sonnet-5')).toBe(false)
  })

  test('does not match non-string input', () => {
    expect(isClaudeOpus5Model(undefined)).toBe(false)
    expect(isClaudeOpus5Model(42)).toBe(false)
    expect(isClaudeOpus5Model(null)).toBe(false)
    expect(isClaudeOpus5Model({})).toBe(false)
  })
})

describe('CLAUDE_OPUS_5_ADAPTIVE_THINKING', () => {
  test('matches the shared adaptive+summarized shape (alias of Fable/Mythos)', () => {
    expect(CLAUDE_OPUS_5_ADAPTIVE_THINKING).toEqual({
      type: 'adaptive',
      display: 'summarized',
    })
  })
})

describe('modelSupportsAdaptiveThinking', () => {
  test.each([
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-4-8-20260101',
    'claude-opus-5',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-mythos-5',
    'claude-haiku-5',
  ])('treats %s as adaptive', (id) => {
    expect(modelSupportsAdaptiveThinking(id)).toBe(true)
  })

  test.each([
    'claude-opus-4-0',
    'claude-opus-4-1',
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-0',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-3-5-sonnet',
    'claude-3-opus',
  ])('treats %s as non-adaptive (manual budget)', (id) => {
    expect(modelSupportsAdaptiveThinking(id)).toBe(false)
  })

  test('rejects non-string and non-Claude input', () => {
    expect(modelSupportsAdaptiveThinking(undefined)).toBe(false)
    expect(modelSupportsAdaptiveThinking(42)).toBe(false)
    expect(modelSupportsAdaptiveThinking('gpt-5')).toBe(false)
  })
})

describe('canonicalClaudeModelId', () => {
  test('strips a dated snapshot suffix', () => {
    expect(canonicalClaudeModelId('claude-opus-4-8-20260101')).toBe(
      'claude-opus-4-8',
    )
    expect(canonicalClaudeModelId('claude-opus-4-8@20260101')).toBe(
      'claude-opus-4-8',
    )
  })

  test('strips the 1m context marker', () => {
    expect(canonicalClaudeModelId('claude-opus-4-8[1m]')).toBe(
      'claude-opus-4-8',
    )
  })
})

describe('modelSupportsXhighEffort', () => {
  test('excludes Opus 4.6 and Sonnet 4.6 even though they are adaptive', () => {
    // Ground truth: Claude Code's E5$ is strictly narrower than FH8/N5$.
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(modelSupportsAdaptiveThinking(id)).toBe(true)
      expect(modelSupportsMaxEffort(id)).toBe(true)
      expect(modelSupportsXhighEffort(id)).toBe(false)
    }
  })

  test.each([
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
  ])('allows xhigh on %s', (id) => {
    expect(modelSupportsXhighEffort(id)).toBe(true)
  })

  test('excludes the legacy manual-budget families', () => {
    expect(modelSupportsXhighEffort('claude-opus-4-5')).toBe(false)
    expect(modelSupportsXhighEffort('claude-haiku-4-5')).toBe(false)
    expect(modelSupportsXhighEffort('claude-3-opus')).toBe(false)
  })
})

describe('clampEffortForModel', () => {
  test('downgrades xhigh to high on Opus 4.6 / Sonnet 4.6', () => {
    expect(clampEffortForModel('xhigh', 'claude-opus-4-6')).toBe('high')
    expect(clampEffortForModel('xhigh', 'claude-sonnet-4-6')).toBe('high')
  })

  test('keeps max on Opus 4.6 (max_effort is supported)', () => {
    expect(clampEffortForModel('max', 'claude-opus-4-6')).toBe('max')
  })

  test('keeps xhigh and max on Opus 4.7+', () => {
    expect(clampEffortForModel('xhigh', 'claude-opus-4-7')).toBe('xhigh')
    expect(clampEffortForModel('max', 'claude-opus-5')).toBe('max')
  })

  test('downgrades both on legacy models', () => {
    expect(clampEffortForModel('xhigh', 'claude-opus-4-5')).toBe('high')
    expect(clampEffortForModel('max', 'claude-opus-4-5')).toBe('high')
  })

  test('leaves ordinary levels untouched', () => {
    expect(clampEffortForModel('low', 'claude-opus-4-6')).toBe('low')
    expect(clampEffortForModel('high', 'claude-opus-4-5')).toBe('high')
  })
})

describe('resolveThinkingShape', () => {
  test('is adaptive by default for adaptive models', () => {
    expect(resolveThinkingShape('claude-opus-4-6', {})).toBe('adaptive')
    expect(resolveThinkingShape('claude-opus-4-8', {})).toBe('adaptive')
  })

  test('is budget for legacy models regardless of the flag', () => {
    expect(resolveThinkingShape('claude-opus-4-5', {})).toBe('budget')
    expect(
      resolveThinkingShape('claude-opus-4-5', {
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
      }),
    ).toBe('budget')
  })

  test('the escape hatch forces a manual budget only on 4.6 models', () => {
    const env = { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1' }
    expect(resolveThinkingShape('claude-opus-4-6', env)).toBe('budget')
    expect(resolveThinkingShape('claude-sonnet-4-6', env)).toBe('budget')
    // Opus 4.7+ hard-rejects budget_tokens, so the hatch must be ignored.
    expect(resolveThinkingShape('claude-opus-4-7', env)).toBe('adaptive')
    expect(resolveThinkingShape('claude-opus-4-8', env)).toBe('adaptive')
    expect(resolveThinkingShape('claude-opus-5', env)).toBe('adaptive')
  })

  test('accepts the documented truthy spellings', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(
        resolveThinkingShape('claude-opus-4-6', {
          CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: value,
        }),
      ).toBe('budget')
    }
    for (const value of ['0', 'false', '', 'off']) {
      expect(
        resolveThinkingShape('claude-opus-4-6', {
          CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: value,
        }),
      ).toBe('adaptive')
    }
  })
})

describe('modelAllowsForcedManualThinking', () => {
  test('is limited to the two deprecated-but-accepted models', () => {
    expect(modelAllowsForcedManualThinking('claude-opus-4-6')).toBe(true)
    expect(modelAllowsForcedManualThinking('claude-sonnet-4-6')).toBe(true)
    expect(modelAllowsForcedManualThinking('claude-opus-4-7')).toBe(false)
    expect(modelAllowsForcedManualThinking('claude-opus-5')).toBe(false)
  })
})

describe('claude-mythos-5 capability regression', () => {
  // Mythos 5's baked-catalog entry ships `capabilities: []`, which reads like a
  // denial. Claude Code hardcodes it as adaptive/effort-capable anyway, and its
  // catalog lookup returns "unknown" (not false) for an absent capability. These
  // assertions exist so nobody "corrects" mythos-5 to non-adaptive later.
  test('is adaptive despite an empty catalog capability list', () => {
    expect(modelSupportsAdaptiveThinking('claude-mythos-5')).toBe(true)
    expect(modelSupportsMaxEffort('claude-mythos-5')).toBe(true)
    expect(modelSupportsXhighEffort('claude-mythos-5')).toBe(true)
    expect(resolveThinkingShape('claude-mythos-5', {})).toBe('adaptive')
  })

  test('is never forced back to a manual budget', () => {
    // Only Opus 4.6 / Sonnet 4.6 accept the deprecated budget shape.
    expect(modelAllowsForcedManualThinking('claude-mythos-5')).toBe(false)
    expect(
      resolveThinkingShape('claude-mythos-5', {
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
      }),
    ).toBe('adaptive')
  })

  test('mythos 5.1 matches mythos 5', () => {
    expect(modelSupportsAdaptiveThinking('claude-mythos-5-1')).toBe(true)
    expect(modelSupportsXhighEffort('claude-mythos-5-1')).toBe(true)
  })
})

describe('Fable/Mythos 5.1 cache-read pricing', () => {
  // Ground truth: Claude Code 2.1.260 catalog maps 5.0 to tier_10_50
  // (cache read $1.00) and 5.1 to tier_10_50_cache_read_0_25 ($0.25).
  test('5.0 keeps the $1.00 cache-read rate', () => {
    for (const id of ['claude-fable-5', 'claude-mythos-5']) {
      expect(resolveClaudeFableMythos5Pricing(id).cacheRead).toBe(1)
    }
  })

  test('5.1 uses the cheaper $0.25 cache-read rate', () => {
    for (const id of ['claude-fable-5-1', 'claude-mythos-5-1']) {
      expect(resolveClaudeFableMythos5Pricing(id).cacheRead).toBe(0.25)
    }
  })

  test('only cache-read differs between the tiers', () => {
    const five = resolveClaudeFableMythos5Pricing('claude-fable-5')
    const fiveOne = resolveClaudeFableMythos5Pricing('claude-fable-5-1')
    expect(fiveOne.input).toBe(five.input)
    expect(fiveOne.output).toBe(five.output)
    expect(fiveOne.cacheWrite5m).toBe(five.cacheWrite5m)
    expect(fiveOne.cacheWrite1h).toBe(five.cacheWrite1h)
  })

  test('a dated 5.1 snapshot still resolves to the 5.1 tier', () => {
    expect(
      resolveClaudeFableMythos5Pricing('claude-fable-5-1-20260601').cacheRead,
    ).toBe(0.25)
  })

  test('does not mistake a dated 5.0 snapshot for 5.1', () => {
    expect(
      resolveClaudeFableMythos5Pricing('claude-fable-5-20260609').cacheRead,
    ).toBe(1)
  })
})
