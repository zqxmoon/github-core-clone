// main.ts — process bootstrap for the forge.
//
// The grading harness drives this process from the outside, so the file has
// exactly one job: get the HTTP app from app.ts onto an OS-assigned port,
// announce that port to the harness, and stay alive until the harness
// declares the run finished. All request handling lives in app.ts.
//
// Harness contract, as implemented below:
//   * MAKEFUN_ENV_URL holds the harness origin. Missing means there is
//     nobody to announce to, so we fail fast with exit code 1.
//   * The app listens on port 0 and the kernel chooses the real port.
//     (Port 8080 belongs to the harness and is never ours to take.)
//   * We POST {"port": <n>} to <env>/register. A 200 confirms us; a 409
//     means an earlier registration already claimed the slot, which is
//     equally fine from our side. 400/405 signal a contract violation and
//     abort the process. Anything else — refused connections, 5xx, slow
//     answers — is treated as "harness still warming up" and retried.
//   * We then poll GET <env>/done. The harness replies immediately with
//     {"done": false} while grading runs, so polling (not holding a
//     request open) is the right shape. Only {"done": true} lets us leave.
//   * On done: close the listener and exit 0.

import { createApp } from './app.ts';

/** Origin of the grading harness, normalised without trailing slashes. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin.length === 0) {
  process.stderr.write('main: MAKEFUN_ENV_URL is unset, cannot register with the harness\n');
  process.exit(1);
}

/** Upper bound for a single register/done round trip before we give up on it. */
const ROUND_TRIP_LIMIT_MS = 30_000;
/** Retry pause starts here and doubles per failure, never passing the cap. */
const PAUSE_FIRST_MS = 250;
const PAUSE_CAP_MS = 2_000;

/** Promise-flavoured setTimeout. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run `fn` until it reports success, sleeping between attempts with a
 * doubling pause. Fatal contract errors escape by throwing from `fn`;
 * everything else is retried indefinitely, because the harness may simply
 * not be up yet and the process must never exit on its own.
 */
async function untilDone(fn: () => Promise<boolean>): Promise<void> {
  let wait = PAUSE_FIRST_MS;
  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch (err) {
      // A thrown value carrying `fatal` is a contract error: rethrow it.
      // Any other failure just means "not yet".
      if (err !== null && typeof err === 'object' && (err as { fatal?: unknown }).fatal === true) {
        throw (err as { cause: unknown }).cause;
      }
    }
    if (ok) return;
    await pause(wait);
    wait = Math.min(PAUSE_CAP_MS, wait * 2);
  }
}

/** Tell the harness which port the kernel gave us. */
async function announce(port: number): Promise<void> {
  await untilDone(async () => {
    const res = await fetch(`${envOrigin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(ROUND_TRIP_LIMIT_MS),
    });
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      const detail = await res.text();
      throw { fatal: true, cause: new Error(`register rejected with HTTP ${res.status}: ${detail}`) };
    }
    return false;
  });
}

/** Block until the harness answers {"done": true} on its done endpoint. */
async function awaitFinish(): Promise<void> {
  await untilDone(async () => {
    const res = await fetch(`${envOrigin}/done`, {
      signal: AbortSignal.timeout(ROUND_TRIP_LIMIT_MS),
    });
    if (!res.ok) return false;
    const payload: unknown = await res.json();
    return (
      payload !== null &&
      typeof payload === 'object' &&
      (payload as { done?: unknown }).done === true
    );
  });
}

/** Start the app on an ephemeral port; resolves with the chosen port. */
function startApp(): Promise<{ port: number; close: () => void }> {
  const server = createApp();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('listener did not report a TCP port'));
        return;
      }
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

try {
  const running = await startApp();
  process.stdout.write(`main: forge listening on port ${running.port}\n`);
  await announce(running.port);
  process.stdout.write('main: registered, idling until the harness finishes\n');
  await awaitFinish();
  running.close();
  process.stdout.write('main: harness done, exiting\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`main: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
