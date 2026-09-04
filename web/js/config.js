/**
 * Deployment configuration for the static client.
 *
 * Everything here is PUBLIC — this file ships to GitHub Pages. Never put a
 * client secret in it. The OAuth flow below is PKCE precisely so that no
 * secret is required.
 */

export const MODEL = 'claude-opus-5';

/** Messages API request shape. Kept in one place so both transports agree. */
export const MODEL_PARAMS = {
  model: MODEL,
  max_tokens: 16000,
  // Opus 5 runs adaptive thinking by default; `summarized` lets us render the
  // reasoning in the MEDITATION panel instead of showing a dead pause.
  thinking: { type: 'adaptive', display: 'summarized' },
  // Chat is not a reasoning-heavy workload — low effort keeps replies snappy
  // and cheap. Raise to 'high' if you point this at hard technical work.
  output_config: { effort: 'low' },
  // Server-side refusal fallback: if a safety classifier declines, the API
  // reroutes to a suitable model instead of handing back a dead turn.
  fallbacks: 'default',
};

export const BETAS = ['server-side-fallback-2026-07-01'];

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * OAuth 2.1 + PKCE.
 *
 * Anthropic does not currently publish a self-serve OAuth client registration
 * for third-party browser apps, so these are intentionally blank. If you have
 * been issued a client (or you point this at your own gateway that fronts the
 * Anthropic API), fill them in and the LOGIN button lights up automatically.
 *
 * With them blank the client falls back to two working modes:
 *   1. the user pastes their own key / bearer token (stays in their browser)
 *   2. IMPERIAL BRIDGE — a local Node process doing real OAuth (see server/)
 */
export const OAUTH = {
  authorizeUrl: '',
  tokenUrl: '',
  clientId: '',
  scopes: 'user:inference',
  // Loopback/Pages redirect. Defaults to this very page.
  get redirectUri() {
    return window.location.origin + window.location.pathname;
  },
  get configured() {
    return Boolean(this.authorizeUrl && this.tokenUrl && this.clientId);
  },
};

/**
 * Where to look for an Agent SDK bridge, in order.
 *
 * A pinned `v4d3r.bridgeUrl` wins outright and nothing else is probed — if you
 * named a bridge, silently answering from a different one would be wrong.
 * Otherwise we try this page's own origin first, which is how the container
 * image serves things (one process, console and bridge, no CORS), and fall
 * back to a bridge on the visitor's own machine, which is how a GitHub Pages
 * deployment reaches one.
 */
export const BRIDGE_CANDIDATES = (() => {
  const pinned = localStorage.getItem('v4d3r.bridgeUrl');
  if (pinned) return [pinned.replace(/\/+$/, '')];

  const candidates = ['http://127.0.0.1:8787'];
  // file:// has origin "null", and a page served over https must not be sent
  // looking for an http bridge on its own host.
  if (/^https?:$/.test(window.location.protocol)) {
    candidates.unshift(window.location.origin);
  }
  return [...new Set(candidates)];
})();

/** First candidate — what the UI names before anything has been probed. */
export const BRIDGE_URL = BRIDGE_CANDIDATES[0];

/**
 * Optional shared secret for a bridge that requires one (any bridge exposed
 * beyond loopback should). Stored per-browser, sent as a bearer token, never
 * committed anywhere: this file ships publicly.
 */
export const BRIDGE_TOKEN = localStorage.getItem('v4d3r.bridgeToken') || '';
