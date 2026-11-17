// The entrypoint: the lifecycle the harness drives the entry with. This file
// is the kit starter's main.ts, kept byte-identical: it binds an ephemeral
// port, registers it with the env, polls /done, and exits 0 when the env says
// the trial is over.
import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown, attempt: number): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000 + attempt * 500),
  });
  return res.status;
}

async function getJson(url: string, attempt: number): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000 + attempt * 500) });
  return res.json();
}

async function main(): Promise<number> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) {
    console.error('MAKEFUN_ENV_URL is not set');
    return 1;
  }
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    console.error('could not read the bound address');
    return 1;
  }
  const port = address.port;

  let delayMs = 100;
  for (let attempt = 0; ; attempt++) {
    try {
      const status = await postJson(`${envUrl}/register`, { port }, attempt);
      if (status === 200 || status === 409) break;
      console.error(`register attempt ${attempt} got HTTP ${status}`);
    } catch (err) {
      console.error(`register attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2000);
  }

  delayMs = 250;
  for (;;) {
    try {
      const body = await getJson(`${envUrl}/done`, 0);
      if (body && body.done === true) break;
    } catch (err) {
      console.error(`done poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5000);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

const code = await main();
process.exit(code);
