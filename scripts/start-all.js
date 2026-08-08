#!/usr/bin/env node
/**
 * Run the web and worker processes in one container.
 *
 * ## Why this exists
 *
 * The two are normally separate services so they can scale on their own
 * bottlenecks - web on inbound HTTP, worker on queue depth. On a single small
 * instance that split costs twice as much for no benefit, so this runs both.
 *
 * ## Why not `node dist/main.js & node dist/worker.js`
 *
 * That shell form has a silent failure mode. `&` backgrounds the web process
 * and the shell waits only on the worker, so if the **web** process crashes the
 * container keeps running with nothing listening on the port. The platform sees
 * a live container, keeps routing traffic to it, and every webhook Meta sends is
 * refused - which eventually gets the number throttled. Nothing in the logs says
 * why, because the process that would have logged it is gone.
 *
 * This supervisor makes either death fatal: whichever child exits first, the
 * other is stopped and the container exits non-zero so the platform restarts it.
 * Crashing loudly beats running in a state that looks healthy and is not.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const children = [];
let shuttingDown = false;

function log(message) {
  process.stdout.write(`${JSON.stringify({ level: 'info', module: 'supervisor', msg: message })}\n`);
}

function start(name, entry) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dist', entry)], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(`${name} exited (code=${code} signal=${signal}) - stopping the container so it is restarted`);
    stopAll(typeof code === 'number' && code !== 0 ? code : 1);
  });

  child.on('error', (err) => {
    log(`${name} failed to start: ${err.message}`);
    stopAll(1);
  });

  children.push({ name, child });
  return child;
}

function stopAll(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }

  // Give in-flight work a moment to finish, then exit regardless. Without the
  // fallback a child that ignores SIGTERM would hang the container forever.
  const timer = setTimeout(() => process.exit(exitCode), 5000);
  timer.unref();

  let remaining = children.length;
  for (const { child } of children) {
    if (child.exitCode !== null) {
      remaining -= 1;
      continue;
    }
    child.on('exit', () => {
      remaining -= 1;
      if (remaining <= 0) process.exit(exitCode);
    });
  }
  if (remaining <= 0) process.exit(exitCode);
}

// Forward platform shutdown signals so both children drain cleanly on deploy.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`received ${signal} - shutting both processes down`);
    shuttingDown = true;
    for (const { child } of children) {
      if (child.exitCode === null) child.kill(signal);
    }
    const timer = setTimeout(() => process.exit(0), 10000);
    timer.unref();
  });
}

log('starting web and worker in a single container');
start('web', 'main.js');
start('worker', 'worker.js');
