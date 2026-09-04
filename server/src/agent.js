/**
 * The Agent SDK half of LORD-V4D3R.
 *
 * Wraps `query()` from @anthropic-ai/claude-agent-sdk and re-emits its stream
 * as the same {type, text} event contract the browser transport expects, so
 * the UI does not care which runtime answered it.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

import { SYSTEM_PROMPT } from '../../web/js/persona.js';
import { MODEL, EFFORT, MAX_TURNS, ALLOWED_TOOLS } from './config.js';

/**
 * Run one turn.
 *
 * @param {string} prompt        the user's message
 * @param {string|undefined} sessionId  resume token from a previous turn
 * @param {AbortSignal} signal
 * @returns {AsyncGenerator<{type:string,text?:string,sessionId?:string}>}
 */
export async function* runTurn(prompt, sessionId, signal) {
  const abortController = new AbortController();
  signal?.addEventListener('abort', () => abortController.abort(), { once: true });

  const stream = query({
    prompt,
    options: {
      model: MODEL,
      effort: EFFORT,
      maxTurns: MAX_TURNS,
      abortController,
      // A custom prompt, not the Claude Code preset — this is a character, not
      // a coding assistant.
      systemPrompt: { type: 'custom', prompt: SYSTEM_PROMPT },
      // Do not inherit the host machine's CLAUDE.md / settings; the persona
      // must be identical to the browser client's.
      settingSources: [],
      // The allowlist IS the sandbox: bare entries here auto-approve, and any
      // tool absent from the list is never offered to the model. A canUseTool
      // callback would be dead code alongside it (the SDK warns about exactly
      // this) — to gate individual calls instead, drop the bare names here and
      // use a PreToolUse hook.
      allowedTools: ALLOWED_TOOLS,
      includePartialMessages: true,
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });

  let emittedSession = false;

  for await (const msg of stream) {
    if (signal?.aborted) break;

    if (!emittedSession && msg.session_id) {
      emittedSession = true;
      yield { type: 'session', sessionId: msg.session_id };
    }

    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (ev?.type !== 'content_block_delta') continue;
      const d = ev.delta;
      if (d.type === 'thinking_delta') yield { type: 'thinking', text: d.thinking };
      else if (d.type === 'text_delta') yield { type: 'text', text: d.text };
      continue;
    }

    if (msg.type === 'result') {
      if (msg.subtype !== 'success') {
        yield {
          type: 'notice',
          text: `The construct faltered (${msg.subtype}).`,
        };
      }
      break;
    }
  }
}
