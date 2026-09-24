import { describe, expect, it } from 'bun:test'
import {
  featurize,
  getSurrogateThreshold,
  scoreBodyText,
} from '../refusal-surrogate'
import parity from './refusal-surrogate-parity.json'

interface ParityCase {
  name: string
  text: string
  windows: number
  score: number
}

describe('refusal surrogate — Python/TS parity', () => {
  for (const c of parity as ParityCase[]) {
    it(`matches Python body score for "${c.name}" (${c.score})`, () => {
      const s = scoreBodyText(c.text)
      // Featurizer + logistic math are deterministic; allow tiny float drift.
      expect(s).toBeCloseTo(c.score, 4)
    })
  }

  it('separates a hot body from a clean body', () => {
    const cases = parity as ParityCase[]
    const hot = cases.find((c) => c.name === 'hot_cyber')!
    const clean = cases.find((c) => c.name === 'clean_session')!
    expect(scoreBodyText(hot.text)).toBeGreaterThan(scoreBodyText(clean.text))
  })

  it('flags the hot body as danger, clears the clean one', () => {
    const cases = parity as ParityCase[]
    const hot = cases.find((c) => c.name === 'hot_cyber')!
    const clean = cases.find((c) => c.name === 'clean_session')!
    const thr = getSurrogateThreshold()
    expect(scoreBodyText(hot.text)).toBeGreaterThanOrEqual(thr)
    expect(scoreBodyText(clean.text)).toBeLessThan(thr)
  })

  it('featurize is L2-normalized and deterministic', () => {
    const a = featurize('the quick brown fox oauth endpoint xochitl')
    const b = featurize('the quick brown fox oauth endpoint xochitl')
    let dot = 0,
      norm = 0
    for (let i = 0; i < a.length; i++) {
      dot += (a[i] as number) * (b[i] as number)
      norm += (a[i] as number) * (a[i] as number)
    }
    expect(dot).toBeCloseTo(1, 6) // identical inputs -> identical vectors
    expect(norm).toBeCloseTo(1, 6) // unit norm
  })

  it('empty / tiny bodies score 0 (no windows)', () => {
    expect(scoreBodyText('')).toBe(0)
    expect(scoreBodyText('short text')).toBe(0)
  })
})
