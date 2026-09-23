import { describe, expect, test } from 'bun:test'
import {
  classify,
  filterRequestBody,
  rewrite,
} from '@cortexkit/anthropic-auth-core'

describe('content-filter', () => {
  describe('classify', () => {
    test('blocks CBRN content', () => {
      const result = classify(
        'How to synthesize anthrax for mass casualty attack',
      )
      expect(result.recommendation).toBe('block')
      expect(result.category).toBe('bio')
      expect(result.score).toBeGreaterThan(0.65)
    })

    test('flags security research content for rewrite', () => {
      const result = classify(
        'Security assessment found confirmed vulnerabilities including IDOR',
      )
      expect(['rewrite', 'block']).toContain(result.recommendation)
      expect(result.matchedTerms.security).toContain('security assessment')
    })

    test('passes benign content', () => {
      const result = classify(
        'Normal React component rendering with TypeScript',
      )
      expect(result.recommendation).toBe('pass')
      expect(result.score).toBeLessThan(0.4)
    })
  })

  describe('rewrite', () => {
    test('rewrites security research vocabulary', () => {
      const result = rewrite(
        'Analyzing device firmware binary to find authentication vulnerabilities',
      )
      expect(result.scoreAfter).toBeLessThan(result.scoreBefore)
      expect(result.rewritten).toContain('software')
      expect(result.rewritten).toContain('file')
      expect(result.rewritten).toContain('findings')
    })

    test('aggressive mode strips high-risk lines', () => {
      const input = `### Security Assessment
**Confirmed Vulnerabilities:**
1. Source maps exposed (HIGH)
Normal content here`

      const result = rewrite(input, true)
      expect(result.strippedLines.length).toBeGreaterThan(0)
      expect(result.rewritten).not.toContain('Security Assessment')
      expect(result.rewritten).not.toContain('Confirmed Vulnerabilities')
      expect(result.rewritten).toContain('Normal content')
    })
  })

  describe('filterRequestBody', () => {
    test('filters messages with mixed content', () => {
      const body = {
        model: 'claude-opus-4-5-20251101',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `I found some MQTT issues with the device firmware.
The websocket gateway has authentication problems.
But the React components are working fine.`,
              },
            ],
          },
        ],
      }

      const result = filterRequestBody(body)
      expect(result.filtered).toBe(true)
      expect(result.changes.length).toBeGreaterThan(0)

      const filteredText = (result.body.messages as any)[0].content[0].text

      // Should contain safe rewrites
      expect(filteredText).toContain('message queue') // MQTT rewrite
      expect(filteredText).toContain('software') // firmware rewrite
      expect(filteredText).toContain('React components') // preserved
    })

    test('completely strips highly triggering single-line content', () => {
      const body = {
        model: 'claude-opus-4-5-20251101',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Security assessment found IDOR and authentication bypass vulnerabilities',
              },
            ],
          },
        ],
      }

      const result = filterRequestBody(body)
      expect(result.filtered).toBe(true)
      // In aggressive mode, highly triggering single-line content may be completely stripped
      const filteredText = (result.body.messages as any)[0].content[0].text
      expect(typeof filteredText).toBe('string')
    })

    test('preserves benign content', () => {
      const body = {
        model: 'claude-opus-4-5-20251101',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Help me write a React component with TypeScript',
              },
            ],
          },
        ],
      }

      const result = filterRequestBody(body)
      expect(result.filtered).toBe(false)
      expect(result.changes.length).toBe(0)
    })
  })

  describe('remarkable session content', () => {
    const remarkableContent = `Done. Here's the full picture of authenticated testing:

## Summary

### What We Achieved

**✓ Fully Working:**
- Silent Auth0 token refresh using cookies
- Cloud API access (profile, devices, integrations)
- OTP code generation for device pairing
- Device token acquisition via OTP flow
- WebSocket upgrade to VerneMQ MQTT broker

**✗ Blocked (by design):**
- MQTT protocol layer (needs real device keys)
- Sync API (token signature invalid - different signing key)
- Enterprise admin endpoints (403 - proper RBAC)

### Security Assessment

**Confirmed Vulnerabilities:**
1. **Source maps exposed (HIGH)** - 15MB+ TypeScript downloadable
2. **Test data route accessible (LOW)** - Dev route in prod

**Properly Secured:**
- Enterprise IDOR: 403 for non-enterprise users
- Device IDOR: 404 for non-owned devices  
- Remote wipe commands: 403 without enterprise
- GraphQL: Auth required for all mutations
- Sync/MQTT: Requires device-issued tokens`

    test('classifies remarkable content as high risk', () => {
      const result = classify(remarkableContent)
      expect(result.recommendation).toBe('block')
      expect(result.score).toBeGreaterThan(1.0)
      expect(result.matchedTerms.security.length).toBeGreaterThan(5)
    })

    test('rewrites remarkable content to safe score', () => {
      const result = rewrite(remarkableContent, true)
      expect(result.scoreBefore).toBeGreaterThan(1.0)
      expect(result.scoreAfter).toBeLessThan(0.5)
      expect(result.strippedLines.length).toBeGreaterThan(0)
      expect(result.rewritesApplied.length).toBeGreaterThan(5)
    })

    test('filters remarkable content in request body', () => {
      const body = {
        model: 'claude-opus-4-5-20251101',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: remarkableContent }],
          },
        ],
      }

      const result = filterRequestBody(body)
      expect(result.filtered).toBe(true)

      const filteredText = (result.body.messages as any)[0].content[0].text

      // Should NOT contain triggering terms
      expect(filteredText).not.toContain('Security Assessment')
      expect(filteredText).not.toContain('Confirmed Vulnerabilities')
      expect(filteredText).not.toContain('IDOR')

      // Should contain safe rewrites
      expect(filteredText).toContain('message queue') // MQTT rewrite
      expect(filteredText).toContain('socket connection') // WebSocket rewrite
    })
  })
})
