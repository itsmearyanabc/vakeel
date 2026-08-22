/**
 * pm2 process definitions for a shared VPS.
 *
 * ## The constraint this file is shaped by
 *
 * This box runs other people's production apps. Nothing here may touch them,
 * which rules out the two things a pm2 setup normally does casually:
 *
 *  1. **`interpreter` is set explicitly.** pm2 apps otherwise inherit whatever
 *     Node the pm2 daemon was started with. This service needs Node >= 22 (the
 *     OpenAI SDK refuses to run below it), and the other apps on this host are
 *     on Node 20. Upgrading system Node would silently move them onto 22 the
 *     next time they restarted. Pointing only these two apps at an nvm-managed
 *     Node 22 leaves everything else exactly where it is.
 *
 *  2. **Names are prefixed.** `vakeel-web` and `vakeel-worker`, so
 *     `pm2 restart vakeel-web` can never match somebody else's process, and a
 *     careless `pm2 restart all` is the only way to disturb a neighbour.
 *
 * ## Why two processes and not `start-all.js`
 *
 * `scripts/start-all.js` supervises both in one process, which existed for
 * platforms that bill per service. A VPS has no such limit, and splitting them
 * buys real things: pm2 restarts a crashed worker without dropping the webhook
 * listener, the two get separate logs, and the web process can be reloaded on
 * deploy while the worker drains its current job.
 *
 * ## Usage
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * Set NODE_INTERPRETER to the output of `nvm which 22` before starting, or edit
 * the default below.
 */

/**
 * Path to the Node 22 binary these apps run under.
 *
 * Left as `node` when unset, which is correct on a machine whose system Node is
 * already 22 and wrong on this one - hence the check in scripts/deploy.sh,
 * which refuses to start rather than letting it fail confusingly at runtime.
 */
const interpreter = process.env.NODE_INTERPRETER || 'node';

/** Everything both processes share. */
const common = {
  cwd: __dirname,
  interpreter,
  // The app reads .env itself through process.loadEnvFile(), so pm2 does not
  // need to know about any of it. One fewer place for the two to disagree.
  env: { NODE_ENV: 'production' },
  autorestart: true,
  // A process that dies immediately and repeatedly is misconfigured, not
  // unlucky. Backing off stops it from filling the disk with logs at speed.
  exp_backoff_restart_delay: 200,
  max_restarts: 20,
  // Docker-style rotation is unavailable under pm2; this caps the damage until
  // pm2-logrotate is installed (see the runbook).
  max_memory_restart: '400M',
  time: true,
  merge_logs: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'vakeel-web',
      script: 'dist/main.js',
      // One instance. Fork mode rather than cluster: the in-process rate
      // limiters and caches are per-process, so a second instance would double
      // the effective sign-in limit and halve the cache hit rate. See
      // src/common/rate-limiter.ts.
      instances: 1,
      exec_mode: 'fork',
      // SIGINT gives Fastify time to finish in-flight requests, including an
      // SSE stream mid-answer.
      kill_timeout: 10_000,
    },
    {
      ...common,
      name: 'vakeel-worker',
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      // Longer than the web process: the worker finishes the message it is
      // holding before exiting, and that can be a full model round trip.
      kill_timeout: 30_000,
    },
  ],
};
