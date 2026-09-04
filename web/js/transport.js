/**
 * Two ways to reach Claude. Both expose the same async-generator contract:
 *
 *   for await (const ev of transport.stream(messages, { signal })) { ... }
 *   ev = { type: 'thinking'|'text'|'notice', text } | { type: 'done' }
 *
 * HOLONET  — browser talks straight to api.anthropic.com with the user's own
 *            credential. No server, nothing for the host to see. Requires
 *            Anthropic to allow direct browser access for the credential.
 * BRIDGE   — browser talks to a Node process running the Claude Agent SDK,
 *            which brings tools, sessions and real OAuth. That process may be
 *            on the visitor's own machine, or it may be the very server that
 *            served this page (the container image does both jobs).
 */

import {
  MODEL_PARAMS,
  BETAS,
  ANTHROPIC_BASE_URL,
  BRIDGE_CANDIDATES,
  BRIDGE_TOKEN,
} from './config.js';
import { SYSTEM_PROMPT } from './persona.js';
import { CredentialStore, ensureFresh } from './auth.js';

/**
 * The Anthropic SDK is vendored into this repo and served from our own origin
 * rather than pulled from a CDN at runtime.
 *
 * This is a security decision, not a preference. The SDK executes with full
 * access to the visitor's credential in browser storage, so loading it from a
 * third party would mean every visitor's key depends on that third party not
 * being compromised — and SRI cannot cover a CDN's dynamically generated ESM
 * bundles. Serving it ourselves lets the CSP be `script-src 'self'`.
 *
 * Regenerate with `npm run vendor` after bumping the dependency.
 */
let sdkPromise = null;
function loadSdk() {
  sdkPromise ??= import('./vendor/anthropic-sdk.js').then((m) => m.default ?? m.Anthropic);
  return sdkPromise;
}

/* --------------------------------------------------------------- holonet -- */

export const holonet = {
  id: 'holonet',
  label: 'HOLONET DIRECT',

  async available() {
    return Boolean(CredentialStore.load());
  },

  async *stream(messages, { signal } = {}) {
    const Anthropic = await loadSdk();
    const cred = await ensureFresh(CredentialStore.load());
    if (!cred) throw new Error('No credential. Authenticate first.');

    const headers = CredentialStore.authHeaders(cred);
    const client = new Anthropic({
      baseURL: ANTHROPIC_BASE_URL,
      ...(cred.kind === 'oauth'
        ? { authToken: cred.access_token }
        : { apiKey: cred.value }),
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(headers['anthropic-beta'] ? { 'anthropic-beta': headers['anthropic-beta'] } : {}),
      },
    });

    yield* runMessages(client, messages, signal);
  },
};

/**
 * Issue the request, degrading gracefully if this account/endpoint does not
 * yet accept the newer beta parameters.
 */
async function* runMessages(client, messages, signal, allowBetas = true) {
  const body = {
    ...MODEL_PARAMS,
    system: SYSTEM_PROMPT,
    messages,
    ...(allowBetas ? { betas: BETAS } : {}),
  };
  if (!allowBetas) delete body.fallbacks;

  let stream;
  try {
    stream = allowBetas
      ? client.beta.messages.stream(body, { signal })
      : client.messages.stream(body, { signal });
  } catch (err) {
    if (allowBetas && isBetaRejection(err)) {
      yield { type: 'notice', text: 'Refusal-fallback beta unavailable; proceeding without it.' };
      yield* runMessages(client, messages, signal, false);
      return;
    }
    throw err;
  }

  try {
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      const d = event.delta;
      if (d.type === 'thinking_delta') yield { type: 'thinking', text: d.thinking };
      else if (d.type === 'text_delta') yield { type: 'text', text: d.text };
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      yield {
        type: 'notice',
        text: 'The Dark Side clouds this request — it was declined by a safety classifier.',
      };
    }
    yield { type: 'done' };
  } catch (err) {
    if (allowBetas && isBetaRejection(err)) {
      yield { type: 'notice', text: 'Refusal-fallback beta unavailable; proceeding without it.' };
      yield* runMessages(client, messages, signal, false);
      return;
    }
    throw decorate(err);
  }
}

function isBetaRejection(err) {
  if (err?.status !== 400) return false;
  const msg = String(err?.message ?? '').toLowerCase();
  return msg.includes('fallback') || msg.includes('beta') || msg.includes('output_config');
}

/** Turn opaque network failures into something a user can act on. */
function decorate(err) {
  const msg = String(err?.message ?? err);
  if (err?.status === 401) {
    return new Error('Credential rejected. Your key or token is invalid or expired.');
  }
  if (err?.status === 429) {
    return new Error('Rate limited by the Imperial fleet. Wait, then try again.');
  }
  if (/failed to fetch|networkerror|load failed|cors/i.test(msg)) {
    return new Error(
      'The browser could not reach api.anthropic.com — this is almost certainly CORS. ' +
        'Direct browser access may not be permitted for this credential. ' +
        'Switch to IMPERIAL BRIDGE mode (see README) and try again.',
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/* ---------------------------------------------------------------- bridge -- */

export const bridge = {
  id: 'bridge',
  label: 'IMPERIAL BRIDGE',

  /**
   * The Agent SDK keeps conversation state server-side, so the bridge only
   * needs the newest turn plus this resume token. Without it every message
   * would start a fresh session and the construct would have no memory.
   */
  sessionId: undefined,

  /** Which candidate answered, once one has. */
  baseUrl: null,

  /** Whether that bridge demands a token — set by available(). */
  authRequired: false,

  reset() {
    this.sessionId = undefined;
  },

  /**
   * Probe the candidates in order and keep the first that reports it can
   * actually run a turn.
   *
   * `chat: false` matters as much as a failed request: a static deployment
   * serves this same console and answers /health, but has no agent behind it,
   * and treating that as a bridge would strand the visitor on a transport
   * that returns 501 for every message. The container image in static mode is
   * exactly that case.
   */
  async available() {
    for (const base of BRIDGE_CANDIDATES) {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) continue;
        const info = await res.json();
        // `chat` is absent on bridges predating the static/bridge split; those
        // always had an agent, so treat undefined as yes.
        if (info?.chat === false) continue;
        this.baseUrl = base;
        this.authRequired = Boolean(info?.authRequired);
        return true;
      } catch {
        // Unreachable, wrong protocol, timed out — try the next candidate.
      }
    }
    this.baseUrl = null;
    return false;
  },

  async *stream(messages, { signal } = {}) {
    const base = this.baseUrl ?? BRIDGE_CANDIDATES[0];
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A bridge reachable beyond loopback requires this; a local one
        // ignores it. Sending it unconditionally keeps the two paths identical.
        ...(BRIDGE_TOKEN ? { Authorization: `Bearer ${BRIDGE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ messages, sessionId: this.sessionId }),
      signal,
    });
    if (res.status === 401) {
      throw new Error(
        'The bridge rejected your access token. Set it with ' +
          "localStorage.setItem('v4d3r.bridgeToken', '…') and reload.",
      );
    }
    if (!res.ok || !res.body) {
      throw new Error(`Bridge refused the transmission (${res.status}): ${await res.text()}`);
    }

    for await (const ev of readSse(res.body, signal)) {
      if (ev.type === 'session') {
        this.sessionId = ev.sessionId;
        continue;
      }
      yield ev;
    }
  },
};

/** Minimal SSE reader — the bridge speaks `data: {json}\n\n`. */
async function* readSse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!frame.startsWith('data:')) continue;

        const payload = frame.slice(5).trim();
        if (payload === '[DONE]') {
          yield { type: 'done' };
          return;
        }
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.type === 'error') throw new Error(ev.message);
        yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const TRANSPORTS = { holonet, bridge };
