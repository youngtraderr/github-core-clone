import { createApp } from './app.ts';

// Run the forge until its supervising environment finishes the trial.
const environmentOrigin = String(process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
const pause = (duration: number) => new Promise<void>(finish => setTimeout(finish, duration));
async function announce(boundPort: number): Promise<void> {
  let delay = 250;
  for (;;) {
    let reply: Response | undefined;
    try {
      reply = await fetch(environmentOrigin + '/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: boundPort }), signal: AbortSignal.timeout(30000),
      });
    } catch { /* Retry while the supervisor starts. */ }
    if (reply && [200, 409].includes(reply.status)) return;
    if (reply && [400, 405].includes(reply.status)) throw Error('Supervisor rejected port registration: ' + reply.status);
    await pause(delay);
    delay = Math.min(2000, delay * 2);
  }
}
async function supervise(): Promise<void> {
  if (!environmentOrigin) throw Error('MAKEFUN_ENV_URL must identify the trial supervisor');
  const forge = createApp();
  await new Promise<void>((ready, fail) => { forge.once('error', fail); forge.listen(0, ready); });
  const binding = forge.address();
  if (typeof binding !== 'object' || binding === null) throw Error('TCP binding unavailable');
  await announce(binding.port);
  for (;;) {
    try {
      const state = await fetch(environmentOrigin + '/done', { signal: AbortSignal.timeout(30000) });
      if (state.ok && (await state.json()).done === true) break;
    } catch { /* Keep serving during transient supervisor outages. */ }
    await pause(250);
  }
  await new Promise<void>(finished => forge.close(() => finished()));
}
supervise().then(() => process.exit(0), failure => {
  process.stderr.write('[forge lifecycle] ' + String(failure) + '\n');
  process.exit(1);
});
