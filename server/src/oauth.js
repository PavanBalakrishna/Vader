/**
 * OAuth 2.1 Authorization Code + PKCE for the local bridge, with a loopback
 * redirect (the flow desktop apps are supposed to use — no client secret).
 *
 * Tokens land in ~/.v4d3r/credentials.json with mode 0600.
 */

import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

import { OAUTH, CRED_PATH } from './config.js';

const b64url = (buf) => buf.toString('base64url');

/* ------------------------------------------------------------------ store -- */

export async function loadCredential() {
  try {
    return JSON.parse(await readFile(CRED_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveCredential(cred) {
  await mkdir(dirname(CRED_PATH), { recursive: true });
  await writeFile(CRED_PATH, JSON.stringify(cred, null, 2), { mode: 0o600 });
  // writeFile only applies mode on create; enforce it on rewrite too.
  await chmod(CRED_PATH, 0o600).catch(() => {});
}

/* ------------------------------------------------------------------- pkce -- */

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  return {
    verifier,
    state: b64url(randomBytes(16)),
    challenge: b64url(createHash('sha256').update(verifier).digest()),
  };
}

export function authorizeUrl({ challenge, state }) {
  const url = new URL(OAUTH.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OAUTH.clientId);
  url.searchParams.set('redirect_uri', OAUTH.redirectUri);
  url.searchParams.set('scope', OAUTH.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function tokenRequest(params) {
  const res = await fetch(OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(`Token endpoint returned ${res.status}: ${await res.text()}`);
  }
  const tok = await res.json();
  return {
    kind: 'oauth',
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
  };
}

export async function exchangeCode(code, verifier) {
  const cred = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    client_id: OAUTH.clientId,
    redirect_uri: OAUTH.redirectUri,
    code_verifier: verifier,
  });
  await saveCredential(cred);
  return cred;
}

export async function refresh(cred) {
  const next = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: cred.refresh_token,
    client_id: OAUTH.clientId,
  });
  next.refresh_token ??= cred.refresh_token;
  await saveCredential(next);
  return next;
}

/* ------------------------------------------------------------ resolution -- */

/**
 * Decide what credential the Agent SDK should run under and describe it.
 *
 * Precedence mirrors the Anthropic SDKs: explicit API key, then explicit
 * bearer token, then our stored OAuth profile. If none of those exist we fall
 * through and let the Agent SDK use whatever the machine already has (a
 * `claude` / `ant` login), which is the common case for a developer running
 * this locally.
 *
 * @returns {Promise<{source: string, detail: string}>}
 */
export async function resolveCredential() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { source: 'ANTHROPIC_API_KEY', detail: 'environment API key' };
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return { source: 'ANTHROPIC_AUTH_TOKEN', detail: 'environment bearer token' };
  }

  let cred = await loadCredential();
  if (cred?.access_token) {
    if (Date.now() >= (cred.expires_at ?? 0) - 60_000) {
      if (cred.refresh_token && OAUTH.configured) {
        cred = await refresh(cred);
      } else {
        return { source: 'none', detail: 'stored OAuth token expired — run `npm run login`' };
      }
    }
    // The Agent SDK reads credentials from the environment.
    process.env.ANTHROPIC_AUTH_TOKEN = cred.access_token;
    return { source: 'oauth-profile', detail: `stored OAuth token (${CRED_PATH})` };
  }

  return { source: 'inherited', detail: 'existing Claude Code / ant login on this machine' };
}
