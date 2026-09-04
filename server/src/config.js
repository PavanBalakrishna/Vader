/**
 * Bridge configuration and credential resolution.
 *
 * The bridge runs on the user's own machine. It is the half of this project
 * that can hold a refresh token and run the Claude Agent SDK, neither of which
 * a static GitHub Pages deployment can do.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export const PORT = Number(process.env.V4D3R_PORT ?? 8787);
export const HOST = process.env.V4D3R_HOST ?? '127.0.0.1';

export const MODEL = process.env.V4D3R_MODEL ?? 'claude-opus-5';
export const EFFORT = process.env.V4D3R_EFFORT ?? 'low';
export const MAX_TURNS = Number(process.env.V4D3R_MAX_TURNS ?? 12);

/**
 * Read-only by default. The bridge is a chat harness, not a coding agent —
 * it should not be able to write to the user's disk without them opting in.
 * Set V4D3R_TOOLS to a comma-separated list to change it, or `none` to
 * disable tools entirely.
 */
export const ALLOWED_TOOLS = (() => {
  const raw = process.env.V4D3R_TOOLS;
  if (raw === 'none') return [];
  if (raw) return raw.split(',').map((t) => t.trim()).filter(Boolean);
  return ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
})();

/** Origins allowed to talk to the bridge. Pages deployments must be listed. */
export const ALLOWED_ORIGINS = (
  process.env.V4D3R_ORIGINS ??
  'http://localhost:8787,http://127.0.0.1:8787'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/** Where OAuth tokens are persisted (mode 0600). */
export const CRED_PATH =
  process.env.V4D3R_CRED_PATH ?? join(homedir(), '.v4d3r', 'credentials.json');

/**
 * OAuth client. Blank by default — see the note in web/js/config.js. When these
 * are set, `npm run login` performs a real Authorization Code + PKCE flow with
 * a loopback redirect.
 */
export const OAUTH = {
  authorizeUrl: process.env.V4D3R_OAUTH_AUTHORIZE_URL ?? '',
  tokenUrl: process.env.V4D3R_OAUTH_TOKEN_URL ?? '',
  clientId: process.env.V4D3R_OAUTH_CLIENT_ID ?? '',
  scopes: process.env.V4D3R_OAUTH_SCOPES ?? 'user:inference',
  get redirectUri() {
    return `http://${HOST}:${PORT}/auth/callback`;
  },
  get configured() {
    return Boolean(this.authorizeUrl && this.tokenUrl && this.clientId);
  },
};
