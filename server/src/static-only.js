/**
 * Serve the static console with no agent, no credentials, no OAuth.
 * This is exactly what GitHub Pages will serve — use it to check that the
 * Pages build works before you push.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const port = Number(process.env.V4D3R_PORT ?? 8080);

express()
  .use(express.static(webRoot))
  .listen(port, '127.0.0.1', () => {
    console.log(`\n  LORD-V4D3R static console — http://127.0.0.1:${port}\n`);
  });
