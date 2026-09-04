/**
 * LORD-V4D3R — Imperial Bridge.
 *
 * A small local server that:
 *   • serves the static console (so you can develop without deploying)
 *   • exposes /api/chat as SSE, backed by the Claude Agent SDK
 *   • performs a real OAuth 2.1 + PKCE login with a loopback redirect
 *
 * It binds to 127.0.0.1 by default. Do not expose it to a network without
 * putting authentication in front of it.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import express from 'express';
import cors from 'cors';

import { PORT, HOST, MODEL, ALLOWED_TOOLS, ALLOWED_ORIGINS, OAUTH } from './config.js';
import { runTurn } from './agent.js';
import {
  createPkce,
  authorizeUrl,
  exchangeCode,
  resolveCredential,
} from './oauth.js';

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
    runtime: 'claude-agent-sdk',
    model: MODEL,
    tools: ALLOWED_TOOLS,
    credential: credentialInfo.source,
  });
});

/* ------------------------------------------------------------------ chat -- */

app.post('/api/chat', async (req, res) => {
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

credentialInfo = await resolveCredential();

app.listen(PORT, HOST, async () => {
  const base = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  ██ LORD-V4D3R — IMPERIAL BRIDGE');
  console.log(`     console     ${base}`);
  console.log(`     model       ${MODEL}`);
  console.log(`     tools       ${ALLOWED_TOOLS.join(', ') || '(none)'}`);
  console.log(`     credential  ${credentialInfo.source} — ${credentialInfo.detail}`);
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
