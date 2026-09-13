import { spawn } from 'node:child_process';

const processes = new Set();
let shuttingDown = false;

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  processes.add(child);

  child.on('exit', (code, signal) => {
    processes.delete(child);

    if (!shuttingDown && code !== 0) {
      console.error(`${name} stopped unexpectedly.`);
      shutdown(code ?? 1);
    }
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of processes) {
    child.kill('SIGTERM');
  }

  setTimeout(() => {
    for (const child of processes) {
      child.kill('SIGKILL');
    }

    process.exit(exitCode);
  }, 1500).unref();
}

start('R2NETTE API', process.execPath, [
  '--env-file=.env',
  './node_modules/vite-node/vite-node.mjs',
  'src/api/server.ts',
]);

start('R2NETTE frontend', process.execPath, [
  './node_modules/vite/bin/vite.js',
  '--config',
  'vite.config.ts',
]);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));