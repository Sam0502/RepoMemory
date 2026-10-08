#!/usr/bin/env node
// One-command onboarding for RepoMemory (humans, not CI).
//
//   node scripts/setup.mjs                  # full setup
//   node scripts/setup.mjs --skip-model     # skip the ~90MB ONNX download
//   node scripts/setup.mjs --skip-db       # bring your own PostgreSQL+pgvector
//   node scripts/setup.mjs --skip-install --skip-build   # DB + migrate only
//
// Steps: prereq checks → pnpm install → start Postgres → wait for it → build
// → migrate → download ONNX model → print next steps. Exits non-zero with a
// human-readable error on the first failure.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

const exec = promisify(execFile);
const args = new Set(process.argv.slice(2));
const skip = (flag) => args.has(`--skip-${flag}`);

function log(msg) {
  console.log(`[setup] ${msg}`);
}

function fail(msg) {
  console.error(`[setup] ERROR: ${msg}`);
  process.exit(1);
}

async function run(cmd, cmdArgs, label) {
  log(`${label}: ${cmd} ${cmdArgs.join(' ')}`);
  try {
    const { stdout, stderr } = await exec(cmd, cmdArgs, { maxBuffer: 256 * 1024 * 1024 });
    if (stdout.trim()) console.log(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
  } catch (error) {
    fail(`${label} failed: ${error.message.split('\n')[0]}`);
  }
}

async function checkPrereqs() {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) fail(`Node.js 20+ required (found ${process.version})`);
  try {
    await exec(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version']);
  } catch {
    fail('pnpm not found — install it with `npm install -g pnpm`');
  }
  if (!skip('db')) {
    try {
      await exec('docker', ['--version']);
    } catch {
      fail('Docker not found — needed for PostgreSQL (or re-run with --skip-db and point PG_* at your own database)');
    }
  }
  log(`prereqs ok (node ${process.version})`);
}

function waitForTcp(host, port, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, host);
      socket.on('connect', () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 1000);
        }
      });
    };
    attempt();
  });
}

async function main() {
  await checkPrereqs();

  if (!skip('install')) {
    await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install'], 'install dependencies');
  }

  if (!skip('build')) {
    await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['-r', 'run', 'build'], 'build all packages');
  }

  if (!skip('db')) {
    await run('docker', ['compose', 'up', '-d', 'postgres'], 'start PostgreSQL');
    const host = process.env.PG_HOST || 'localhost';
    const port = parseInt(process.env.PG_PORT || '5433', 10);
    log(`waiting for PostgreSQL at ${host}:${port}...`);
    try {
      await waitForTcp(host, port);
    } catch (error) {
      fail(error.message);
    }
    log('PostgreSQL is reachable');
  }

  await run(process.execPath, ['app/dist/cli.js', 'db', 'migrate'], 'run database migrations');

  if (!skip('model')) {
    await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['download-model'], 'download ONNX embedding model');
  } else {
    log('skipping model download (EMBEDDING_PROVIDER=placeholder still works for everything but semantic search)');
  }

  console.log('');
  console.log('Setup complete. Next:');
  console.log('  node app/dist/cli.js scan --repo /path/to/your/repo --full');
  console.log('  node app/dist/cli.js serve --repo /path/to/your/repo --port 3000');
}

main().catch((error) => fail(error.message));
