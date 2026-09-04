/**
 * Bridge configuration and credential resolution.
 *
 * The bridge runs on the user's own machine. It is the half of this project
 * that can hold a refresh token and run the Claude Agent SDK, neither of which
 * a static GitHub Pages deployment can do.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Platform-assigned port wins: Render, Fly, Heroku and friends all inject
 * `PORT` and route to nothing else. V4D3R_PORT stays as the local knob.
 */
export const PORT = Number(process.env.PORT ?? process.env.V4D3R_PORT ?? 8787);

/**
 * Loopback by default so a `npm run bridge` on a laptop is not reachable from
 * the coffee-shop wifi. The container image overrides this to 0.0.0.0, which
 * is safe there only because MODE/ACCESS_TOKEN below gate what gets exposed.
 */
export const HOST = process.env.V4D3R_HOST ?? '127.0.0.1';

/** True when we are listening on something other than loopback. */
export const IS_PUBLIC_BIND = !['127.0.0.1', '::1', 'localhost'].includes(HOST);

/**
 * What this process serves.
 *
 *   static — the console only, exactly what GitHub Pages serves. Visitors
 *            bring their own credential; this process holds none.
 *   bridge — the console plus /api/chat backed by the Claude Agent SDK,
 *            answering with whatever credential this process can resolve.
 *
 * Hosting `bridge` publicly means strangers spend your Anthropic balance, so
 * a public bind additionally requires V4D3R_ACCESS_TOKEN (see index.js).
 */
export const MODE = (() => {
  const raw = process.env.V4D3R_MODE;
  if (raw === 'bridge' || raw === 'static') return raw;
  // Unset: a loopback bind is somebody running `npm run bridge` on their own
  // machine, so keep the full experience. A public bind is a deployment, and
  // defaults to the half that holds no credential.
  return IS_PUBLIC_BIND ? 'static' : 'bridge';
})();

/**
 * Shared secret required by /api/chat when set. Callers present it as
 * `Authorization: Bearer <token>`; the console reads it from the
 * `v4d3r.bridgeToken` key in localStorage.
 */
export const ACCESS_TOKEN = process.env.V4D3R_ACCESS_TOKEN ?? '';

/**
 * The externally reachable URL of this deployment, used for the OAuth
 * redirect and to allowlist the console's own origin. Render injects
 * RENDER_EXTERNAL_URL automatically, so a Blueprint deploy needs no config.
 */
export const PUBLIC_URL = (
  process.env.V4D3R_PUBLIC_URL ??
  process.env.RENDER_EXTERNAL_URL ??
  ''
).replace(/\/+$/, '');

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
export const ALLOWED_ORIGINS = (() => {
  const listed = (
    process.env.V4D3R_ORIGINS ??
    'http://localhost:8787,http://127.0.0.1:8787'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // A hosted bridge serves the console from its own origin, and browsers do
  // send Origin on same-origin POSTs — so without this the deployment would
  // reject its own page. Adding it grants nothing new: that origin is us.
  if (PUBLIC_URL) {
    try {
      const self = new URL(PUBLIC_URL).origin;
      if (!listed.includes(self)) listed.push(self);
    } catch {
      console.warn(`[config] ignoring unparseable public URL: ${PUBLIC_URL}`);
    }
  }
  return listed;
})();

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
    // Behind a proxy the bind address is not the address the browser came
    // from, so a known public URL always wins over host:port.
    return PUBLIC_URL
      ? `${PUBLIC_URL}/auth/callback`
      : `http://${HOST}:${PORT}/auth/callback`;
  },
  get configured() {
    return Boolean(this.authorizeUrl && this.tokenUrl && this.clientId);
  },
};
