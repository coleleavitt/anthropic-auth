import { expect } from 'bun:test'

/**
 * A sign-in link as long as the real one: the authorize endpoint, the fixed
 * client, callback and scopes, a 43-character PKCE challenge and a 32-digit
 * state. It is far wider than a narrow dialog, so it must wrap.
 */
export const SIGN_IN_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE&code_challenge_method=S256&state=0123456789abcdef0123456789abcdef'

/**
 * Expects `frame` to show `url` whole on rows of its own: the rows from the
 * one starting with `https://` hold only link characters (around the dialog's
 * blank padding), and read in order they spell the link exactly. Returns the
 * number of rows the link wrapped onto.
 */
export function expectLinkOnOwnRows(frame: string, url: string): number {
  const rows = frame.split('\n').map((row) => row.trim())
  const first = rows.findIndex((row) => row.startsWith('https://'))
  expect(first).toBeGreaterThanOrEqual(0)
  let joined = ''
  let count = 0
  for (const row of rows.slice(first)) {
    if (joined.length >= url.length || row === '') break
    // Nothing but the next part of the link may share a row with it.
    expect(url.slice(joined.length).startsWith(row)).toBe(true)
    joined += row
    count++
  }
  expect(joined).toBe(url)
  return count
}
