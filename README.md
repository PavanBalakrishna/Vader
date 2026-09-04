# LORD-V4D3R

> *"You have accessed a restricted terminal, Commander. State your query."*

An Imperial chat console powered by Claude. Star Wars themed front end, Darth Vader persona, bring-your-own-credential — deployable to GitHub Pages so other people can use it with their own Anthropic account.

---

## The one architectural constraint you need to know

You asked for the Claude Agent SDK **and** a browser-only app on GitHub Pages. Those two cannot both be literally true, so this repo does both properly rather than faking one:

| | Runtime | Auth | Tools | Where it runs |
|---|---|---|---|---|
| **Holonet Direct** | Anthropic Messages API via `@anthropic-ai/sdk` | user's own key/token, kept in their browser | none | the static page, no server |
| **Imperial Bridge** | `@anthropic-ai/claude-agent-sdk` | OAuth / env / inherited `claude` login | Read, Glob, Grep, WebSearch, WebFetch | Node on your machine, or a container you host |

**Why the Agent SDK can't go in the browser:** `@anthropic-ai/claude-agent-sdk` is Claude Code packaged as a library. It spawns subprocesses and needs a filesystem. Its `/browser` export is *not* a standalone browser agent — it's a thin client that attaches to an already-provisioned server-side Claude Code session (internal, feature-flagged surface). GitHub Pages serves static files only, so there is no process for it to be.

The console auto-detects at load: if a bridge is reachable it uses the Agent SDK; otherwise it falls back to talking to Anthropic directly. Both paths share one persona file, so the character can't drift between them.

---

## Quick start

```bash
npm install

# Full experience — Agent SDK, tools, sessions
npm run bridge          # → http://127.0.0.1:8787

# Or just the static console, exactly as GitHub Pages will serve it
npm run web             # → http://127.0.0.1:8080

# Or the container, exactly as Render will run it
docker compose up --build   # → http://127.0.0.1:8787
```

The bridge picks up credentials in this order:

1. `ANTHROPIC_API_KEY`
2. `ANTHROPIC_AUTH_TOKEN` (OAuth bearer)
3. a token stored by `npm run login` (`~/.v4d3r/credentials.json`, mode 0600)
4. whatever `claude` / `ant` login already exists on the machine ← usually this one

Copy `.env.example` to `.env` to change the model, tool allowlist, port, or origins.

---

## Deploying to GitHub Pages

```bash
git init && git add -A && git commit -m "LORD-V4D3R"
git remote add origin git@github.com:YOURNAME/YOURREPO.git
git push -u origin main
```

Then **Settings → Pages → Source: GitHub Actions**. The included workflow publishes `web/` verbatim on every push to `main` — there is no build step, because the console is dependency-free ES modules.

Your visitors then paste their own Anthropic credential, which is stored in *their* browser (`sessionStorage` by default, `localStorage` if they tick "remember"). The site has no backend and never sees it.

### A caveat worth setting expectations on

Holonet Direct sends requests from the visitor's browser to `api.anthropic.com` with `anthropic-dangerous-direct-browser-access: true`. If Anthropic does not permit direct browser access for that credential, the request fails CORS. The app detects this specific failure and says so plainly rather than showing a generic error, and points the user at bridge mode. **Test this with your own key before telling people the hosted page works.**

---

## Docker, and hosting on Render for free

```bash
docker build -t lord-v4d3r .
docker run --rm -p 127.0.0.1:8787:8787 lord-v4d3r   # → http://127.0.0.1:8787
```

or `docker compose up --build`, which does the same with the settings the
deployed service uses.

The image runs `server/src/index.js` — the same process as `npm run bridge` —
but with two defaults changed for a host rather than a laptop: it binds
`0.0.0.0`, and it takes its port from `$PORT` if the platform sets one
(Render, Fly and Heroku all do).

### Pick a mode before you deploy

`V4D3R_MODE` decides which half of the app a deployment is, and it is the only
decision that really matters here:

| | What it serves | Whose credential | Safe to leave open? |
|---|---|---|---|
| `static` *(default when bound publicly)* | the console only | each visitor's own, kept in their browser | **yes** — this process holds no credential |
| `bridge` *(default on loopback)* | console + `/api/chat` on the Agent SDK | **yours** | no — requires `V4D3R_ACCESS_TOKEN` |

Unset, it picks by bind address: a loopback bind is somebody running the bridge
on their own machine, so `npm run bridge` behaves exactly as it always has, and
a container bound to `0.0.0.0` gets the static console.

**Bridge mode on a public URL means strangers spend your Anthropic balance**,
with read-only tools pointed at your container. So the server refuses to boot
in that configuration unless `V4D3R_ACCESS_TOKEN` is set, and then `/api/chat`
requires `Authorization: Bearer <token>`. The console sends it from
`localStorage`:

```js
localStorage.setItem('v4d3r.bridgeToken', '<the token>')
```

That is a shared secret handed out per browser, not a login. It is enough to
keep your key off the open internet; it is not enough to run a service for
people you do not know.

### Deploying to Render

Render's free tier runs Docker web services, which is all this needs.

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml`: one
   free web service, health-checked on `/health`, auto-deploying on push.
3. Open the `.onrender.com` URL. That's the console, in static mode — visitors
   paste their own Anthropic credential, exactly as on GitHub Pages.

To run the Agent SDK there instead, uncomment the bridge block in
`render.yaml` (it has Render generate the access token for you) and add
`ANTHROPIC_API_KEY` in the dashboard — never in the file, which is in git.
`V4D3R_TOOLS=none` is the honest setting for a deployment other people can
reach: `Read`/`Glob`/`Grep` see the container's own filesystem.

You don't need to set `V4D3R_PUBLIC_URL`; Render injects `RENDER_EXTERNAL_URL`
and the config picks it up to fix the OAuth redirect and allowlist the
console's own origin.

### Free-tier facts to set expectations on

- The service **sleeps after ~15 minutes** of no traffic, and the next visitor
  waits out a cold start of roughly a minute. In bridge mode that lands on top
  of the Agent SDK's own startup.
- There is **no persistent disk**. A token from `npm run login` written inside
  the container does not survive a deploy — use `ANTHROPIC_API_KEY`.
- Free web services share **750 instance-hours a month** across your account.

### Anywhere else

Nothing in the image is Render-specific. Any host that runs a container and
sets `$PORT` works the same way; set `V4D3R_PUBLIC_URL` yourself if the host
doesn't provide `RENDER_EXTERNAL_URL`.

---

## OAuth, honestly

The app implements a complete, standards-correct OAuth 2.1 Authorization Code + PKCE flow — in the browser (`web/js/auth.js`) and in the bridge with a loopback redirect (`server/src/oauth.js`). Neither needs a client secret.

What it does **not** ship with is endpoints, because **Anthropic does not currently publish self-serve OAuth client registration for third-party apps.** The `client_id` that Claude Code itself uses is a first-party client; pointing this app at it would mean impersonating Claude Code, so this repo does not do that.

So the OAuth path is wired and waiting. Fill in `V4D3R_OAUTH_*` in `.env` (or the `OAUTH` block in `web/js/config.js`) if you are issued a client, or if you point it at your own gateway fronting the Anthropic API — the "Sign in with OAuth" button un-greys itself automatically. Until then the working paths are the credential box and the bridge.

---

## Layout

```
web/                      ← this is what GitHub Pages serves
  index.html
  css/styles.css
  js/persona.js           ← THE character. Imported by both runtimes.
  js/config.js            ← model params, OAuth endpoints, bridge URL
  js/auth.js              ← credential store + browser PKCE
  js/transport.js         ← holonet + bridge, one event contract
  js/app.js               ← DOM, streaming, markdown
  js/vendor/              ← generated by `npm run vendor`, commit it
scripts/vendor-entry.js   ← bundle entry point
server/src/
  index.js                ← express, SSE, OAuth routes, static, mode + auth gate
  agent.js                ← Claude Agent SDK wrapper
  oauth.js                ← PKCE + token storage + credential resolution
  config.js
Dockerfile                ← the container both modes run in
docker-compose.yml        ← run that container locally
render.yaml               ← Render Blueprint, free tier
```

## Model configuration

`claude-opus-5`, adaptive thinking with `display: "summarized"`, `effort: "low"`, streaming, and server-side refusal fallbacks. The summarized reasoning is rendered in a collapsible **MEDITATION** panel — without it the default `display: "omitted"` shows a dead pause while the model thinks. Effort is `low` because conversational chat doesn't repay a higher setting; raise it in `config.js` / `.env` if you point this at hard technical work.

## Security notes

The threat that matters on a public deployment: **the page holds each visitor's API key in their browser, so any script execution on the page is credential theft.** Three things guard that.

- **No third-party JavaScript.** The Anthropic SDK is vendored into `web/js/vendor/` and served from your own origin. Loading it from a CDN would mean every visitor's key depends on that CDN not being compromised, and SRI can't cover a CDN's dynamically generated ESM bundles. Regenerate with `npm run vendor` after bumping the dependency.
- **CSP with `script-src 'self'`** and `default-src 'none'`. An injected script can't load code and has no origin to exfiltrate to except Anthropic. This is why the page carries no inline `style=` attributes — keeping `unsafe-inline` out of `style-src`. If you configure OAuth, add your token endpoint to `connect-src`.
- **Model output is escaped before rendering**, quotes included. That last part is not optional: the link rule interpolates a URL into `href="..."`, and HTML5 parsers recover from `href="x"onmouseover=…` by starting a *new* attribute. Escaping only `<`/`>`/`&` leaves a working XSS.

Bridge-specific (local users, not Pages visitors):

- The bridge binds `127.0.0.1` and, on loopback, has **no authentication** — anything running on your machine can drive it. Beyond loopback it will not start without `V4D3R_ACCESS_TOKEN`.
- Its tool allowlist is read-only by design. `V4D3R_TOOLS=none` makes it pure chat.
- `settingSources: []` means the bridge ignores your machine's `CLAUDE.md` and settings, so the persona is identical to the browser client's.
- **If you add a public origin to `V4D3R_ORIGINS`**, JavaScript served from that origin can drive your local Agent SDK, which can read files. Only allowlist origins you control, and understand you're trusting future deployments of them.
- **A hosted bridge is your credential on someone else's keyboard.** The boot guard (public bind + no `V4D3R_ACCESS_TOKEN` → exit) exists because that mistake is silent otherwise: the deployment works perfectly, and the bill arrives later. The token is a blunt instrument — one secret, no revocation, no per-user accounting. Deploy `static` unless you specifically want to pay for other people's turns.
- **Don't bake a `.env` into the image.** `.dockerignore` excludes it, because anyone who can pull a layer can read it. Secrets belong in the platform's environment settings.

Residual risks worth telling your users about: they are trusting *you* not to ship a malicious update, and an Anthropic API key is account-wide with billing attached — advise a dedicated key with a spend limit.

## Costs

Every message is billed to whoever's credential is in use. On the hosted page that's each visitor's own account, not yours.

---

*Fan project. Not affiliated with, endorsed by, or connected to Lucasfilm Ltd. or The Walt Disney Company. Star Wars and Darth Vader are their trademarks. Ship it as a parody/fan work and don't charge for it.*
