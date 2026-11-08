import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { spawnCli, stopCliProcesses, waitForOutput } from './support.js';

it('reaps a tracked server before its temporary library is removed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'recueil-cli-cleanup-'));
  const child = spawnCli([
    '--json', 'serve', '--host', '127.0.0.1', '--port', '0',
    '--database', join(directory, 'library.sqlite'), '--storage', join(directory, 'storage'),
  ]);
  try {
    await waitForOutput(child, (stdout) => stdout.includes('127.0.0.1'));
    await stopCliProcesses();
    expect(child.signalCode).toBe('SIGKILL');
    // Repeated cleanup also terminates immediately instead of waiting for an old close event.
    await stopCliProcesses();
  } finally {
    await stopCliProcesses();
    rmSync(directory, { recursive: true, force: true });
  }
});
