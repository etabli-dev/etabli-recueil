import { describe, expect, it } from 'vitest';

import { COMMANDS, CURRENT_PHASE, phaseTitle } from '../src/catalogue.js';
import { runCli } from './support.js';

const pending = COMMANDS.filter((spec) => spec.phase > CURRENT_PHASE);

describe('commands that are not implemented yet', () => {
  it('there are some, and `serve` is not one of them', () => {
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.map((spec) => spec.name)).not.toContain('serve');
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
    const result = await runCli(['import', 'zotero', '--data-dir', '/nowhere', '--report', 'r.md']);
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
