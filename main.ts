// main.ts — the trial lifecycle: bind an ephemeral port, register it with the
// environment, then poll until the environment says the trial is done.
// Never binds 8080 (that port belongs to the environment).

import { serve } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const server = serve();
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`forge listening on 127.0.0.1:${port}; registering with the environment`);
  void (async () => {
    try {
      const register = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (!register.ok) {
        console.error(`register failed: HTTP ${register.status}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`register failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        const response = await fetch(`${envUrl}/done`);
        const data = (await response.json()) as { done?: boolean };
        if (data.done === true) break;
      } catch {
        // The environment may not be ready yet; keep polling.
      }
    }
    server.close(() => process.exit(0));
  })();
});
