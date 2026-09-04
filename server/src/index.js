/**
 * LORD-V4D3R — Imperial Bridge.
 *
 * A small server that:
 *   • serves the static console (so you can develop without deploying)
 *   • in bridge mode, exposes /api/chat as SSE backed by the Claude Agent SDK
 *   • performs a real OAuth 2.1 + PKCE login
 *
 * It binds to 127.0.0.1 by default. The container image binds 0.0.0.0 and
 * defaults to V4D3R_MODE=static, which holds no credential at all. Turning on
 * bridge mode over a public bind requires V4D3R_ACCESS_TOKEN — see the guard
 * below, and the Docker section of the README.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

import express from 'express';
import cors from 'cors';

import {
  PORT,
  HOST,
  IS_PUBLIC_BIND,
  MODE,
  ACCESS_TOKEN,
  PUBLIC_URL,
  MODEL,
  ALLOWED_TOOLS,
  ALLOWED_ORIGINS,
  OAUTH,
} from './config.js';
import {
  createPkce,
  authorizeUrl,
  exchangeCode,
  resolveCredential,
} from './oauth.js';

/**
 * Refuse to hand the operator's Anthropic credential to the open internet.
 * An unauthenticated public bridge is a stranger's free inference budget
 * billed to you, plus read-only filesystem tools pointed at this container.
 */
if (MODE === 'bridge' && IS_PUBLIC_BIND && !ACCESS_TOKEN) {
  console.error(
    '\n  REFUSING TO START — bridge mode is bound to a public interface with\n' +
      '  no V4D3R_ACCESS_TOKEN. Anyone who finds the URL would be spending your\n' +
      '  Anthropic balance. Set V4D3R_ACCESS_TOKEN to a long random string, or\n' +
      '  run V4D3R_MODE=static and let visitors bring their own credential.\n',
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin(origin, cb) {
      // Same-origin / curl requests arrive with no Origin header.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} is not permitted. Add it to V4D3R_ORIGINS.`));
    },
  }),
);

app.use(express.static(webRoot));

/* ---------------------------------------------------------------- health -- */

let credentialInfo = { source: 'unresolved', detail: '' };

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'lord-v4d3r-bridge',
    mode: MODE,
    // The console keys off this to decide whether /api/chat is worth calling
    // and whether it must present a token first.
    chat: MODE === 'bridge',
    authRequired: MODE === 'bridge' && Boolean(ACCESS_TOKEN),
    runtime: MODE === 'bridge' ? 'claude-agent-sdk' : 'static',
    model: MODEL,
    tools: MODE === 'bridge' ? ALLOWED_TOOLS : [],
    credential: credentialInfo.source,
  });
});

/* ------------------------------------------------------------------ chat -- */

/**
 * Constant-time-ish bearer check. Node's timingSafeEqual needs equal lengths,
 * so compare digests of the two strings rather than the strings themselves.
 */
function tokenOk(header) {
  const presented = /^Bearer (.+)$/i.exec(header ?? '')?.[1] ?? '';
  const digest = (v) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(presented), digest(ACCESS_TOKEN));
}

app.post('/api/chat', async (req, res) => {
  if (MODE !== 'bridge') {
    return res.status(501).json({
      error:
        'This deployment runs in static mode and has no agent. ' +
        'Use your own credential, or point the console at a bridge.',
    });
  }
  if (ACCESS_TOKEN && !tokenOk(req.get('authorization'))) {
    return res.status(401).json({ error: 'Bridge access token missing or incorrect.' });
  }

  const { messages, sessionId } = req.body ?? {};
  const last = Array.isArray(messages) ? messages.at(-1) : null;

  if (!last || last.role !== 'user' || typeof last.content !== 'string') {
    return res.status(400).json({ error: 'Expected messages[] ending in a user turn.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const controller = new AbortController();

  // Abort on client disconnect only. Note this must be `res`, not `req`: an
  // IncomingMessage emits 'close' as soon as its body has been consumed, which
  // express.json() has already done by this point — listening on `req` aborts
  // every turn immediately.
  let finished = false;
  res.on('close', () => {
    if (!finished) controller.abort();
  });

  try {
    // Imported lazily: the Agent SDK is a heavy dependency and static-mode
    // deployments should never pay to load it.
    const { runTurn } = await import('./agent.js');
    for await (const ev of runTurn(last.content, sessionId, controller.signal)) {
      send(ev);
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('[bridge] turn failed:', err);
    send({ type: 'error', message: err.message ?? String(err) });
  } finally {
    finished = true;
    res.end();
  }
});

/* ----------------------------------------------------------------- oauth -- */

/** In-flight PKCE state, keyed by the `state` parameter. */
const pending = new Map();

app.get('/auth/login', (_req, res) => {
  if (!OAUTH.configured) {
    return res
      .status(501)
      .send('No OAuth client configured. Set V4D3R_OAUTH_* — see .env.example.');
  }
  const pkce = createPkce();
  pending.set(pkce.state, pkce);
  setTimeout(() => pending.delete(pkce.state), 10 * 60_000).unref?.();
  res.redirect(authorizeUrl(pkce));
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description: description } = req.query;

  if (error) return res.status(400).send(`Authorization failed: ${description ?? error}`);
  if (!code || !state) return res.status(400).send('Missing code or state.');

  const pkce = pending.get(String(state));
  pending.delete(String(state));
  if (!pkce) return res.status(400).send('Unknown or expired state — restart the login.');

  try {
    await exchangeCode(String(code), pkce.verifier);
    credentialInfo = await resolveCredential();
    res.send(
      '<body style="background:#05060a;color:#ff2b2b;font-family:monospace;padding:48px">' +
        '<h2>THE LINK IS ESTABLISHED</h2>' +
        '<p style="color:#8b97ad">You may close this window and return to the console.</p>' +
        '</body>',
    );
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

/* ------------------------------------------------------------------ boot -- */

const wantsLogin = process.argv.includes('--login');

// Static deployments hold no credential and must not go looking for one on
// the host — resolveCredential() reads files and env that only matter to a
// bridge.
credentialInfo =
  MODE === 'bridge'
    ? await resolveCredential()
    : { source: 'none', detail: 'static mode — visitors supply their own' };

app.listen(PORT, HOST, async () => {
  const base = PUBLIC_URL || `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  ██ LORD-V4D3R — IMPERIAL BRIDGE');
  console.log(`     mode        ${MODE}`);
  console.log(`     console     ${base}`);
  console.log(`     model       ${MODEL}`);
  console.log(`     tools       ${MODE === 'bridge' ? ALLOWED_TOOLS.join(', ') || '(none)' : '(none)'}`);
  console.log(`     credential  ${credentialInfo.source} — ${credentialInfo.detail}`);
  if (MODE === 'bridge' && !ACCESS_TOKEN) {
    console.log('     access      OPEN — anyone who can reach this port can use it');
  } else if (MODE === 'bridge') {
    console.log('     access      bearer token required');
  }
  if (!OAUTH.configured) {
    console.log('     oauth       not configured (see .env.example)');
  }
  console.log('');

  if (wantsLogin) {
    if (!OAUTH.configured) {
      console.error('  Cannot --login: no OAuth client configured. See .env.example.');
      process.exit(1);
    }
    const { default: open } = await import('open');
    await open(`${base}/auth/login`);
    console.log('  Browser opened for authorization…');
  }
});
