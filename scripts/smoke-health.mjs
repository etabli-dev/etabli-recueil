/**
 * Phase 0 exit criterion, checked end to end: `recueil serve` returns health with an empty library.
 *
 * This runs the *built* CLI — apps/cli/dist/index.js, the same file the `recueil` bin and the
 * container entrypoint resolve to — against a throwaway database and store in a temporary
 * directory, polls /health until it answers, prints the body verbatim and shuts the process down.
 * Nothing here imports the workspace, so a build that type-checks but does not run still fails.
 *
 *   pnpm build && pnpm smoke
 *
 * Exit status is the answer: 0 when health came back 200 with an empty library, 1 otherwise.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, 'apps', 'cli', 'dist', 'index.js');
const port = Number(process.env.SMOKE_PORT ?? 3877);
const deadlineMs = 30_000;

if (!existsSync(cli)) {
  console.error(`No built CLI at ${cli}. Run \`pnpm build\` first.`);
  process.exit(1);
}

/**
 * Refuse to run if something already holds the port.
 *
 * Without this the poll below can answer 200 from a server that is not the one this script
 * started — a stale process from an earlier run, most likely — and report a pass for a build that
 * never bound anything. A smoke test that can pass while the thing under test is broken is worse
 * than no smoke test.
 */
const portIsFree = await new Promise((resolve) => {
  const probe = createConnection({ host: '127.0.0.1', port }, () => {
    probe.destroy();
    resolve(false);
  });
  probe.on('error', () => resolve(true));
  probe.setTimeout(2_000, () => {
    probe.destroy();
    resolve(false);
  });
});

if (!portIsFree) {
  console.error(`Port ${port} is already in use. Stop whatever holds it, or set SMOKE_PORT.`);
  process.exit(1);
}

const workspace = await mkdtemp(join(tmpdir(), 'recueil-smoke-'));
const database = `file:${join(workspace, 't.db')}`;
const storage = join(workspace, 'storage');

const child = spawn(
  process.execPath,
  [cli, 'serve', '--port', String(port), '--database', database, '--storage', storage],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let stderr = '';
child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});

let exited = null;
child.on('exit', (code, signal) => {
  exited = { code, signal };
});

const stop = async () => {
  if (exited === null) {
    child.kill('SIGTERM');
    for (let waited = 0; exited === null && waited < 5_000; waited += 100) await delay(100);
    if (exited === null) child.kill('SIGKILL');
  }
  await rm(workspace, { recursive: true, force: true });
};

const fail = async (reason) => {
  await stop();
  console.error(`\nSmoke test failed: ${reason}`);
  process.exit(1);
};

const url = `http://127.0.0.1:${port}/health`;
const started = Date.now();
let response = null;

while (Date.now() - started < deadlineMs) {
  if (exited !== null) {
    await fail(`the server exited (code ${exited.code}, signal ${exited.signal}) before answering`);
  }
  try {
    response = await fetch(url);
    break;
  } catch {
    await delay(250);
  }
}

if (response === null) await fail(`${url} did not answer within ${deadlineMs / 1000}s\n${stderr}`);

const body = await response.text();
console.log(`\nGET ${url} -> ${response.status} ${response.headers.get('content-type')}`);
console.log(body);

if (response.status !== 200) await fail(`expected 200, got ${response.status}`);

let health;
try {
  health = JSON.parse(body);
} catch (error) {
  await fail(`the body is not JSON: ${error.message}`);
}

const problems = [];
if (health.status !== 'ok') problems.push(`status is ${JSON.stringify(health.status)}, not "ok"`);
if (health.name !== 'recueil') problems.push(`name is ${JSON.stringify(health.name)}, not "recueil"`);

const components = new Map((health.components ?? []).map((component) => [component.name, component]));
for (const name of ['database', 'storage']) {
  const component = components.get(name);
  if (!component) problems.push(`no ${name} component in the body`);
  else if (component.status !== 'ok') problems.push(`${name} is ${JSON.stringify(component.status)}, not "ok"`);
}

// The served body carries the store root the server resolved (apps/server/src/health.ts). If it
// is not the throwaway directory this script made, the answer came from somebody else's server.
if (health.storage?.path !== storage) {
  problems.push(
    `the answer came from a server rooted at ${JSON.stringify(health.storage?.path)}, not at ${storage}`,
  );
}

const library = health.library;
if (!library) {
  problems.push('the body carries no library summary, so the empty library is unproven');
} else {
  for (const name of ['items', 'documents', 'attachments', 'collections']) {
    if (library[name] !== 0) problems.push(`library.${name} is ${JSON.stringify(library[name])}, not 0`);
  }
}

await stop();

if (problems.length > 0) {
  console.error('\nSmoke test failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\nPhase 0 exit criterion met: the built CLI served health with an empty library.');
