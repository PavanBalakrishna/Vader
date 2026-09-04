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

/** Where the optional local Agent SDK bridge listens. */
export const BRIDGE_URL =
  localStorage.getItem('v4d3r.bridgeUrl') || 'http://127.0.0.1:8787';
