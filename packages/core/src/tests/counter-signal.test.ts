import { describe, expect, it } from 'vitest'
import {
  autoInjectCounterSignal,
  type CounterSignalConfig,
  detectTopic,
  generateCounterSignal,
  getTopicConfidence,
  injectCounterSignal,
  LEGITIMACY_PREFIXES,
} from '../counter-signal.ts'

describe('detectTopic', () => {
  it('detects self-hosting topic', () => {
    expect(
      detectTopic('Setting up my homelab server with docker containers'),
    ).toBe('self-hosting')
  })

  it('detects security-research topic', () => {
    expect(detectTopic('Running a pentest vulnerability assessment')).toBe(
      'security-research',
    )
  })

  it('detects reverse-engineering topic', () => {
    expect(
      detectTopic('disassemble the binary to understand the protocol'),
    ).toBe('reverse-engineering')
  })

  it('detects network-analysis topic', () => {
    expect(detectTopic('Using wireshark to capture packet traffic')).toBe(
      'network-analysis',
    )
  })

  it('returns default for unrecognized text', () => {
    expect(detectTopic('Hello world')).toBe('default')
  })
})

describe('getTopicConfidence', () => {
  it('returns 0 for default topic', () => {
    expect(getTopicConfidence('hello', 'default')).toBe(0)
  })

  it('returns positive confidence for matching keywords', () => {
    const confidence = getTopicConfidence(
      'homelab server docker',
      'self-hosting',
    )
    expect(confidence).toBeGreaterThan(0)
  })

  it('caps confidence at 1.0', () => {
    const text =
      'self-host selfhost reMarkable device server homelab nas raspberry docker container deploy'
    const confidence = getTopicConfidence(text, 'self-hosting')
    expect(confidence).toBeLessThanOrEqual(1.0)
  })
})

describe('generateCounterSignal', () => {
  it('returns null when disabled', () => {
    const config: CounterSignalConfig = { enabled: false, mode: 'auto' }
    expect(generateCounterSignal('self-hosting', config)).toBeNull()
  })

  it('returns custom prefix when provided', () => {
    const config: CounterSignalConfig = {
      enabled: true,
      mode: 'auto',
      customPrefix: 'My custom prefix',
    }
    expect(generateCounterSignal('self-hosting', config)).toBe(
      'My custom prefix',
    )
  })

  it('returns appropriate prefix for topic', () => {
    const config: CounterSignalConfig = { enabled: true, mode: 'auto' }
    expect(generateCounterSignal('self-hosting', config)).toBe(
      LEGITIMACY_PREFIXES['self-hosting'],
    )
  })

  it('returns null for default topic in adaptive mode', () => {
    const config: CounterSignalConfig = { enabled: true, mode: 'adaptive' }
    expect(generateCounterSignal('default', config)).toBeNull()
  })

  it('returns prefix for specific topic in adaptive mode', () => {
    const config: CounterSignalConfig = { enabled: true, mode: 'adaptive' }
    expect(generateCounterSignal('security-research', config)).toBe(
      LEGITIMACY_PREFIXES['security-research'],
    )
  })
})

describe('injectCounterSignal', () => {
  it('prepends counter-signal as first block', () => {
    const config: CounterSignalConfig = { enabled: true, mode: 'auto' }
    const original = [{ type: 'text', text: 'Original prompt' }]
    const result = injectCounterSignal(original, 'self-hosting', config)

    expect(result.length).toBe(2)
    expect(result[0].text).toBe(LEGITIMACY_PREFIXES['self-hosting'])
    expect(result[1].text).toBe('Original prompt')
  })

  it('does not duplicate injection', () => {
    const config: CounterSignalConfig = { enabled: true, mode: 'auto' }
    const original = [
      { type: 'text', text: LEGITIMACY_PREFIXES['self-hosting'] },
    ]
    const result = injectCounterSignal(original, 'self-hosting', config)

    expect(result.length).toBe(1)
  })

  it('returns original when disabled', () => {
    const config: CounterSignalConfig = { enabled: false, mode: 'auto' }
    const original = [{ type: 'text', text: 'Original' }]
    const result = injectCounterSignal(original, 'self-hosting', config)

    expect(result).toBe(original)
  })
})

describe('autoInjectCounterSignal', () => {
  it('auto-detects topic and injects', () => {
    const config: CounterSignalConfig = { enabled: true, mode: 'auto' }
    const original = [
      { type: 'text', text: 'Setting up my homelab server with docker' },
    ]
    const result = autoInjectCounterSignal(original, config)

    expect(result.length).toBe(2)
    expect(result[0].text).toBe(LEGITIMACY_PREFIXES['self-hosting'])
  })

  it('respects adaptive mode threshold', () => {
    const config: CounterSignalConfig = { enabled: true, mode: 'adaptive' }
    const original = [{ type: 'text', text: 'Hello world' }]
    const result = autoInjectCounterSignal(original, config)

    // Should not inject for low-confidence default topic
    expect(result.length).toBe(1)
  })
})
