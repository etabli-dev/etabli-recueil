/**
 * The flags every ingesting command shares, and what each of them is allowed to mean.
 *
 * `recueil ingest`, `recueil ingest watch` and (in a later phase) the source runner inside the
 * server all build the same `IngestPipeline`, so the translation from flags to a pipeline lives
 * here rather than three times over.
 *
 * The OCR selection is the part worth reading. CONCEPT.md §5.1 puts OCRmyPDF in the *optional*
 * sidecars and `@recueil/ingest` puts it behind an interface, so the CLI has to let an operator say
 * which implementation is behind that interface — and has to be honest about what each one is:
 *
 * - `none` (the default) recognises nothing. A scan is filed without text and the confidence gate
 *   sends it to review, which is the correct outcome for a deployment with no OCR worker.
 * - `ocrmypdf` shells out to a real `ocrmypdf`. **No test in this repository exercises it**, there
 *   is no container on the build machine, and `@recueil/ingest`'s own adapter says the same in its
 *   header. `--ocr ocrmypdf` on a machine without the binary fails at the first scan and says so.
 * - `fake` is the in-process engine the tests use, driven by a corpus file the operator supplies.
 *   It exists so the OCR *route* — no text layer, engine called, text indexed, document findable —
 *   can be proven end to end without a sidecar. It recognises nothing it has not been given, which
 *   is what stops it being mistaken for a recogniser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_INGEST_CONFIG,
  FakeOcrEngine,
  OcrMyPdfEngine,
  UnavailableOcrEngine,
} from '@recueil/ingest';
import type { IngestConfig, OcrEngine } from '@recueil/ingest';
import { formatIssues, parseRuleSet } from '@recueil/rules';
import type { IngestionRuleSet, RuleSet } from '@recueil/rules';
import { InvalidArgumentError } from 'commander';

import { CliError } from './errors.js';
import { ExitCode } from './exit.js';

export const OCR_ENGINES = ['none', 'ocrmypdf', 'fake'] as const;
export type OcrEngineName = (typeof OCR_ENGINES)[number];

export const parseOcrEngine = (value: string): OcrEngineName => {
  if (!(OCR_ENGINES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`expected one of ${OCR_ENGINES.join(', ')}.`);
  }
  return value as OcrEngineName;
};

export const parsePositiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('expected a positive integer.');
  return parsed;
};

export const parseUnitInterval = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError('expected a number between 0 and 1.');
  }
  return parsed;
};

export const collectValues = (value: string, previous: string[]): string[] => [...previous, value];

export interface OcrFlags {
  ocr?: OcrEngineName;
  ocrCorpus?: string;
  ocrBinary?: string;
  ocrLang?: string[];
}

/** The corpus a `--ocr fake` run recognises: `{ "<sha256>": "text" }`, plus an optional default. */
interface FakeCorpusFile {
  default?: unknown;
  documents?: Record<string, unknown>;
  [digest: string]: unknown;
}

const readFakeCorpus = (path: string): { corpus: Record<string, string>; defaultText: string } => {
  const file = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new CliError(`could not read the OCR corpus '${file}': ${message(cause)}`, {
      exitCode: ExitCode.Usage,
      cause,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`the OCR corpus '${file}' is not a JSON object.`, {
      exitCode: ExitCode.Usage,
      detail: [
        '',
        '  Expected `{ "<sha256 of the file>": "the text to recognise" }`, optionally with a',
        '  "default" entry used for bytes the corpus does not name.',
      ],
    });
  }

  const source = parsed as FakeCorpusFile;
  const nested = source.documents;
  const entries = nested !== undefined && typeof nested === 'object' && !Array.isArray(nested) ? nested : source;

  const corpus: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (key === 'default' || key === 'documents') continue;
    if (typeof value !== 'string') {
      throw new CliError(`the OCR corpus entry '${key}' in '${file}' is not a string.`, {
        exitCode: ExitCode.Usage,
      });
    }
    corpus[key.toLowerCase()] = value;
  }

  return { corpus, defaultText: typeof source.default === 'string' ? source.default : '' };
};

/** Build the engine the flags asked for. Never guesses: an unavailable engine says so at use. */
export const resolveOcrEngine = (flags: OcrFlags): { engine: OcrEngine; label: string } => {
  const choice = flags.ocr ?? 'none';

  if (choice === 'none') {
    if (flags.ocrCorpus !== undefined) {
      throw new CliError('--ocr-corpus needs --ocr fake; there is no engine to give a corpus to.', {
        exitCode: ExitCode.Usage,
      });
    }
    return { engine: new UnavailableOcrEngine(), label: 'none (scans are filed without text)' };
  }

  if (choice === 'ocrmypdf') {
    const engine = new OcrMyPdfEngine({
      ...(flags.ocrBinary === undefined ? {} : { binary: flags.ocrBinary }),
      ...(flags.ocrLang === undefined || flags.ocrLang.length === 0 ? {} : { languages: flags.ocrLang }),
    });
    return { engine, label: `ocrmypdf (${flags.ocrBinary ?? 'ocrmypdf'}, untested in this build)` };
  }

  if (flags.ocrCorpus === undefined) {
    throw new CliError('--ocr fake needs --ocr-corpus: the fake recognises only what it is given.', {
      exitCode: ExitCode.Usage,
      detail: [
        '',
        '  The corpus is a JSON object mapping a file\'s SHA-256 to the text the engine should',
        '  return for it, with an optional "default" for everything else. Without one the fake',
        '  would return an empty string for every scan, which is indistinguishable from having no',
        '  OCR at all and would read as though OCR had run and found nothing.',
      ],
    });
  }

  const { corpus, defaultText } = readFakeCorpus(flags.ocrCorpus);
  const engine = new FakeOcrEngine({
    corpus,
    defaultText,
    supported: ['application/pdf', 'image/*'],
  });
  return {
    engine,
    label: `fake (${String(Object.keys(corpus).length)} document(s) in the corpus)`,
  };
};

export interface PipelineConfigFlags {
  concurrency?: number;
  threshold?: number;
  scratch?: string;
  maxArchiveDepth?: number;
  ocrEnabled?: boolean;
}

export const resolvePipelineConfig = (flags: PipelineConfigFlags): Partial<IngestConfig> => ({
  ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
  ...(flags.threshold === undefined ? {} : { confidenceThreshold: flags.threshold }),
  ...(flags.scratch === undefined ? {} : { scratchRoot: resolve(flags.scratch) }),
  ...(flags.maxArchiveDepth === undefined ? {} : { maxArchiveDepth: flags.maxArchiveDepth }),
  ...(flags.ocrEnabled === undefined ? {} : { ocrEnabled: flags.ocrEnabled }),
});

export const effectiveThreshold = (flags: PipelineConfigFlags): number =>
  flags.threshold ?? DEFAULT_INGEST_CONFIG.confidenceThreshold;

/**
 * Read a rule set off disk, refusing anything the schema does not accept.
 *
 * A rule set with a fault is refused whole. Loading the rules that happen to parse and running the
 * corpus through them would produce a report about a rule set nobody wrote.
 */
export const loadRuleSetFile = (path: string, expect?: 'ingestion' | 'dedup'): RuleSet => {
  const file = resolve(path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new CliError(`could not read the rule set '${file}': ${message(cause)}`, {
      exitCode: ExitCode.Usage,
      cause,
    });
  }

  const parsed = parseRuleSet(text, { format: file.endsWith('.json') ? 'json' : 'auto' });
  if (!parsed.ok) {
    throw new CliError(`'${file}' is not a valid rule set.`, {
      exitCode: ExitCode.Usage,
      detail: ['', ...formatIssues(parsed.issues).split('\n').map((line) => `  ${line}`)],
      payload: { error: 'invalid_rule_set', file, issues: parsed.issues },
    });
  }

  if (expect !== undefined && parsed.ruleSet.kind !== expect) {
    throw new CliError(
      `'${file}' is a ${parsed.ruleSet.kind} rule set; this command needs an ${expect} one.`,
      { exitCode: ExitCode.Usage, payload: { error: 'wrong_rule_kind', file, kind: parsed.ruleSet.kind } },
    );
  }

  return parsed.ruleSet;
};

export const asIngestionRuleSet = (ruleSet: RuleSet, file: string): IngestionRuleSet => {
  if (ruleSet.kind !== 'ingestion') {
    throw new CliError(`'${file}' is a ${ruleSet.kind} rule set; ingestion needs an ingestion one.`, {
      exitCode: ExitCode.Usage,
    });
  }
  return ruleSet;
};

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
