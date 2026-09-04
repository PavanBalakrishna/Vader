/**
 * Credential handling for the static client.
 *
 * Two things live here:
 *   1. CredentialStore — where the user's key/token is kept (their browser only)
 *   2. a standards-correct OAuth 2.1 Authorization Code + PKCE flow
 *
 * Nothing in this file ever transmits a credential anywhere except to the
 * configured Anthropic/OAuth endpoints. There is no backend to leak to.
 */

import { OAUTH } from './config.js';

const KEY = 'v4d3r.credential';
const PKCE_KEY = 'v4d3r.pkce';

/* ------------------------------------------------------------------ store -- */

export const CredentialStore = {
  /** @returns {{kind:'api_key'|'oauth', value?:string, access_token?:string, refresh_token?:string, expires_at?:number}|null} */
  load() {
    for (const store of [sessionStorage, localStorage]) {
      const raw = store.getItem(KEY);
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch {
          store.removeItem(KEY);
        }
      }
    }
    return null;
  },

  save(cred, { remember = false } = {}) {
    const target = remember ? localStorage : sessionStorage;
    const other = remember ? sessionStorage : localStorage;
    other.removeItem(KEY);
    target.setItem(KEY, JSON.stringify(cred));
  },

  clear() {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(PKCE_KEY);
  },

  /**
   * Headers for a direct Anthropic call. OAuth bearer tokens and API keys take
   * different headers — this is the one place that difference is expressed.
   */
  authHeaders(cred) {
    if (!cred) return null;
    if (cred.kind === 'oauth') {
      return {
        Authorization: `Bearer ${cred.access_token}`,
        // Required on /v1/messages for OAuth-issued tokens.
        'anthropic-beta': 'oauth-2025-04-20',
      };
    }
    return { 'x-api-key': cred.value };
  },
};

/* ------------------------------------------------------------------- pkce -- */

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64url(digest);
}

/** Kick off the redirect. Returns a promise that never resolves (page unloads). */
export async function beginLogin() {
  if (!OAUTH.configured) {
    throw new Error('OAuth is not configured in web/js/config.js');
  }
  const verifier = randomString();
  const state = randomString(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));

  const url = new URL(OAUTH.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OAUTH.clientId);
  url.searchParams.set('redirect_uri', OAUTH.redirectUri);
  url.searchParams.set('scope', OAUTH.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  window.location.assign(url.toString());
  return new Promise(() => {});
}

/**
 * Call once on page load. If we came back from the provider with ?code=,
 * exchange it and store the credential.
 * @returns {Promise<boolean>} true if a login was completed on this load
 */
export async function completeLoginIfReturning() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');

  if (error) {
    stripQuery();
    throw new Error(params.get('error_description') || error);
  }
  if (!code) return false;

  const stashed = sessionStorage.getItem(PKCE_KEY);
  if (!stashed) {
    stripQuery();
    throw new Error('No PKCE verifier in this browser — restart the login.');
  }
  const { verifier, state } = JSON.parse(stashed);
  if (params.get('state') !== state) {
    stripQuery();
    throw new Error('OAuth state mismatch — the redirect was not trusted.');
  }

  const res = await fetch(OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: OAUTH.clientId,
      redirect_uri: OAUTH.redirectUri,
      code_verifier: verifier,
    }),
  });

  sessionStorage.removeItem(PKCE_KEY);
  stripQuery();

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }
  const tok = await res.json();
  CredentialStore.save({
    kind: 'oauth',
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
  });
  return true;
}

/** Refresh an OAuth credential that is within 60s of expiry. No-op otherwise. */
export async function ensureFresh(cred) {
  if (!cred || cred.kind !== 'oauth' || !cred.refresh_token) return cred;
  if (Date.now() < (cred.expires_at ?? 0) - 60_000) return cred;

  const res = await fetch(OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cred.refresh_token,
      client_id: OAUTH.clientId,
    }),
  });
  if (!res.ok) throw new Error('Session expired. Authenticate again.');

  const tok = await res.json();
  const next = {
    kind: 'oauth',
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? cred.refresh_token,
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
  CredentialStore.save(next, {
    remember: Boolean(localStorage.getItem(KEY)),
  });
  return next;
}

function stripQuery() {
  window.history.replaceState({}, '', window.location.pathname);
}
