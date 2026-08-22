import { describe, expect, it } from 'vitest';

import { COMMANDS, CURRENT_PHASE, isImplemented, phaseTitle } from '../src/catalogue.js';
import { runCli } from './support.js';

const pending = COMMANDS.filter((spec) => !isImplemented(spec));

describe('commands that are not implemented yet', () => {
  it('there are some, and none of them is a command this build ships', () => {
    expect(pending.length).toBeGreaterThan(0);
    for (const shipped of ['serve', 'import', 'export', 'backup', 'restore']) {
      expect(pending.map((spec) => spec.name)).not.toContain(shipped);
    }
  });

  it('includes the commands of the current phase that are not built yet, without softening it', async () => {
    // `token` and `job` belong to Phase 1 and Phase 1 is under way. A build that let them exit
    // zero, or that quietly renumbered them into a later phase, would be lying about itself.
    const inThisPhase = pending.filter((spec) => spec.phase === CURRENT_PHASE);
    expect(inThisPhase.map((spec) => spec.name)).toEqual(['token', 'job']);

    for (const spec of inThisPhase) {
      const result = await runCli([spec.name]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('is not implemented yet');
      expect(result.stderr).toContain(`Phase ${spec.phase}`);
    }
  });

  it.each(pending.map((spec) => [spec.name, spec.phase] as const))(
    '`%s` exits non-zero and names Phase %i',
    async (name, phase) => {
      const result = await runCli([name]);

      expect(result.code, 'a placeholder must not look like success').not.toBe(0);
      expect(result.code).toBe(1);

      const said = result.stderr;
      expect(said).toContain(`\`recueil ${name}\` is not implemented yet`);
      expect(said).toContain(`Phase ${phase}`);
      expect(said).toContain(phaseTitle(phase));
      expect(said).toContain('CONCEPT.md §7');

      // Nothing may go to stdout: a pipeline must not receive a plausible-looking empty result.
      expect(result.stdout).toBe('');
    },
  );

  it('answers with the phase even when given arguments it cannot understand', async () => {
    const result = await runCli(['ingest', 'watch', '--folder', '/nowhere', '--rule', 'r.json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not implemented yet');
    expect(result.stderr).not.toContain('unknown option');
  });

  it('reports itself in JSON when asked to', async () => {
    const result = await runCli(['--json', 'check']);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload['error']).toBe('not_implemented');
    expect(payload['command']).toBe('check');
    expect(payload['phase']).toBe(3);
    expect(payload['currentPhase']).toBe(CURRENT_PHASE);
  });

  it('survives --quiet without becoming silent about the failure', async () => {
    const result = await runCli(['--quiet', 'dedup']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not implemented yet');
  });
});

describe('a command that does not exist at all', () => {
  it('is a usage error, distinct from an unimplemented one', async () => {
    const result = await runCli(['frobnicate']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown command');
    expect(result.stderr).not.toContain('is not implemented yet');
  });
});
