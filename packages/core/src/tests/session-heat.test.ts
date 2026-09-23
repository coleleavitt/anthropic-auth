import { describe, expect, it } from 'bun:test'
import {
  computeHeat,
  createSessionHeatState,
  getHeatLevel,
  HAZARD_MODEL,
  updateSessionHeat,
} from '../session-heat.ts'

describe('session-heat', () => {
  describe('computeHeat', () => {
    it('returns 0 for turn 0 or negative', () => {
      expect(computeHeat(0, false)).toBe(0)
      expect(computeHeat(-1, false)).toBe(0)
    })

    it('computes correct hazard at turn 1', () => {
      // H(1) = 0.000009 * 1^2.5 / 2.5 = 0.0000036
      // P = 1 - exp(-0.0000036) ≈ 0.0000036
      const heat = computeHeat(1, false)
      expect(heat).toBeCloseTo(0.0000036, 6)
    })

    it('reaches warm threshold (~0.10) around turn 62', () => {
      // H(62) = 0.000009 * 62^2.5 / 2.5
      // 62^2.5 ≈ 30246.7
      // H(62) ≈ 0.000009 * 30246.7 / 2.5 ≈ 0.1089
      // P ≈ 1 - exp(-0.1089) ≈ 0.103
      const heat62 = computeHeat(62, false)
      expect(heat62).toBeGreaterThan(0.09)
      expect(heat62).toBeLessThan(0.12)
    })

    it('reaches hot threshold (~0.30) around turn 100', () => {
      // H(100) = 0.000009 * 100^2.5 / 2.5
      // 100^2.5 = 100000
      // H(100) = 0.000009 * 100000 / 2.5 = 0.36
      // P = 1 - exp(-0.36) ≈ 0.302
      const heat100 = computeHeat(100, false)
      expect(heat100).toBeGreaterThan(0.29)
      expect(heat100).toBeLessThan(0.32)
    })

    it('applies 10x hazard boost after refusal', () => {
      const heatNoRefusal = computeHeat(62, false)
      const heatWithRefusal = computeHeat(62, true)

      // With refusal, hazard is 10x, so heat should be significantly higher
      expect(heatWithRefusal).toBeGreaterThan(heatNoRefusal)

      // At turn 62 with refusal: H = 10 * 0.1089 ≈ 1.089
      // P ≈ 1 - exp(-1.089) ≈ 0.663
      expect(heatWithRefusal).toBeGreaterThan(0.6)
    })

    it('increases monotonically with turn count', () => {
      let prevHeat = 0
      for (let turn = 1; turn <= 150; turn++) {
        const heat = computeHeat(turn, false)
        expect(heat).toBeGreaterThan(prevHeat)
        prevHeat = heat
      }
    })
  })

  describe('getHeatLevel', () => {
    it('returns safe for heat < 0.10', () => {
      expect(getHeatLevel(0)).toBe('safe')
      expect(getHeatLevel(0.05)).toBe('safe')
      expect(getHeatLevel(0.099)).toBe('safe')
    })

    it('returns warm for heat 0.10-0.30', () => {
      expect(getHeatLevel(0.1)).toBe('warm')
      expect(getHeatLevel(0.2)).toBe('warm')
      expect(getHeatLevel(0.299)).toBe('warm')
    })

    it('returns hot for heat >= 0.30', () => {
      expect(getHeatLevel(0.3)).toBe('hot')
      expect(getHeatLevel(0.5)).toBe('hot')
      expect(getHeatLevel(1.0)).toBe('hot')
    })
  })

  describe('level transitions', () => {
    it('transitions safe→warm around turn 62', () => {
      const heat61 = computeHeat(61, false)
      const heat62 = computeHeat(62, false)

      // Turn 61 should be safe, turn 62+ warm
      expect(getHeatLevel(heat61)).toBe('safe')
      expect(getHeatLevel(heat62)).toBe('warm')
    })

    it('transitions warm→hot around turn 100-110', () => {
      const heat99 = computeHeat(99, false)
      const heat110 = computeHeat(110, false)

      // Turn 99 should be warm, turn 110 should be hot
      expect(getHeatLevel(heat99)).toBe('warm')
      expect(getHeatLevel(heat110)).toBe('hot')
    })
  })

  describe('updateSessionHeat', () => {
    it('creates initial state with zero heat', () => {
      const state = createSessionHeatState('test-session')
      expect(state.turn).toBe(0)
      expect(state.heat).toBe(0)
      expect(state.level).toBe('safe')
      expect(state.refusalCount).toBe(0)
      expect(state.firstRefusalTurn).toBeUndefined()
    })

    it('increments turn on each update', () => {
      let state = createSessionHeatState('test-session')
      state = updateSessionHeat(state, false)
      expect(state.turn).toBe(1)

      state = updateSessionHeat(state, false)
      expect(state.turn).toBe(2)
    })

    it('records first refusal turn', () => {
      let state = createSessionHeatState('test-session')

      // No refusal on turns 1-5
      for (let i = 0; i < 5; i++) {
        state = updateSessionHeat(state, false)
      }
      expect(state.firstRefusalTurn).toBeUndefined()

      // Refusal on turn 6
      state = updateSessionHeat(state, true)
      expect(state.firstRefusalTurn).toBe(6)
      expect(state.refusalCount).toBe(1)

      // Another refusal on turn 7 should not change firstRefusalTurn
      state = updateSessionHeat(state, true)
      expect(state.firstRefusalTurn).toBe(6)
      expect(state.refusalCount).toBe(2)
    })

    it('boosts heat 10x after first refusal', () => {
      let stateNoRefusal = createSessionHeatState('no-refusal')
      let stateWithRefusal = createSessionHeatState('with-refusal')

      // Run both to turn 50
      for (let i = 0; i < 49; i++) {
        stateNoRefusal = updateSessionHeat(stateNoRefusal, false)
        stateWithRefusal = updateSessionHeat(stateWithRefusal, false)
      }

      // Refusal on turn 50 for one session
      stateNoRefusal = updateSessionHeat(stateNoRefusal, false)
      stateWithRefusal = updateSessionHeat(stateWithRefusal, true)

      // Both at turn 50 now
      expect(stateNoRefusal.turn).toBe(50)
      expect(stateWithRefusal.turn).toBe(50)

      // Heat should be much higher with refusal
      expect(stateWithRefusal.heat).toBeGreaterThan(stateNoRefusal.heat)
    })

    it('transitions through levels correctly', () => {
      let state = createSessionHeatState('test-session')

      // Should be safe initially
      state = updateSessionHeat(state, false)
      expect(state.level).toBe('safe')

      // Run to turn 62 (warm threshold)
      while (state.turn < 62) {
        state = updateSessionHeat(state, false)
      }
      expect(state.level).toBe('warm')

      // Run to turn 110 (hot threshold)
      while (state.turn < 110) {
        state = updateSessionHeat(state, false)
      }
      expect(state.level).toBe('hot')
    })
  })

  describe('HAZARD_MODEL constants', () => {
    it('exposes model parameters', () => {
      expect(HAZARD_MODEL.lambda).toBe(0.000009)
      expect(HAZARD_MODEL.k).toBe(2.5)
      expect(HAZARD_MODEL.refusalBoost).toBe(10)
      expect(HAZARD_MODEL.warmThreshold).toBe(0.1)
      expect(HAZARD_MODEL.hotThreshold).toBe(0.3)
    })
  })
})
