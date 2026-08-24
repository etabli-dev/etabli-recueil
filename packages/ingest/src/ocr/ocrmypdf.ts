/**
 * The real OCRmyPDF adapter.
 *
 * **This file is not exercised by the test suite, and that is deliberate.** OCRmyPDF is a sidecar
 * (CONCEPT §5.1) and no test in Recueil may require a container or a system binary: a suite that
 * cannot run on a fresh checkout is a suite nobody runs. What the tests exercise is the
 * `OcrEngine` interface, through `FakeOcrEngine`. What this file gets instead is a narrow surface,
 * an argument list a reader can check against the OCRmyPDF manual, and an honest `health()` that
 * says whether the binary is actually there.
 *
 * The compatibility claim this file makes is therefore: **untested against a real OCRmyPDF in
 * this repository**. It is written from the documented command-line interface of OCRmyPDF 16 and
 * it has not been run against one here. Do not read the existence of this adapter as evidence that
 * the integration works; run `recueil ingest --ocr=ocrmypdf` against a real scan and read the
 * result before believing it.
 *
 * How to turn it on:
 *
 * ```ts
 * import { IngestPipeline, OcrMyPdfEngine } from '@recueil/ingest';
 *
 * const pipeline = new IngestPipeline({
 *   recueil,
 *   ocr: new OcrMyPdfEngine({ binary: 'ocrmypdf', languages: ['eng', 'deu'] }),
 * });
 * ```
 *
 * With a container instead of a local binary, point `binary` at a wrapper script that runs
 * `docker run --rm -i jbarlow83/ocrmypdf "$@"`; the adapter only needs something that takes the
 * documented arguments on `argv` and the PDF on stdin.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdapterUnavailableError } from '../errors.js';
import type { HealthReport } from '../types.js';
import type { OcrEngine, OcrRequest, OcrResult } from './engine.js';

export interface OcrMyPdfOptions {
  /** The executable. A path, a name on `PATH`, or a wrapper around `docker run`. */
  binary?: string;
  /** Tesseract language codes, in preference order. */
  languages?: readonly string[];
  /** Seconds OCRmyPDF may spend per page before it gives up on that page. */
  pageTimeoutSeconds?: number;
  /** Extra arguments, appended before the input and output paths. */
  extraArgs?: readonly string[];
  /** Where the two temporary files go. Defaults to the OS temporary directory. */
  scratchRoot?: string;
  /** Wall-clock ceiling for the whole invocation. */
  timeoutMs?: number;
  /** The confidence recorded for text this engine produced. Never 1 (`spec/hooks.md` §3). */
  confidence?: number;
}

export class OcrMyPdfEngine implements OcrEngine {
  readonly id = 'ocrmypdf';

  private readonly binary: string;
  private readonly languages: readonly string[];
  private readonly pageTimeoutSeconds: number;
  private readonly extraArgs: readonly string[];
  private readonly scratchRoot: string;
  private readonly timeoutMs: number;
  private readonly confidence: number;

  constructor(options: OcrMyPdfOptions = {}) {
    this.binary = options.binary ?? 'ocrmypdf';
    this.languages = options.languages ?? ['eng'];
    this.pageTimeoutSeconds = options.pageTimeoutSeconds ?? 180;
    this.extraArgs = options.extraArgs ?? [];
    this.scratchRoot = options.scratchRoot ?? tmpdir();
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.confidence = options.confidence ?? 0.6;
  }

  supports(mediaType: string): boolean {
    return mediaType === 'application/pdf' || mediaType.startsWith('image/');
  }

  async recognise(request: OcrRequest): Promise<OcrResult> {
    const languages = request.languages ?? this.languages;
    const workspace = await mkdtemp(join(this.scratchRoot, 'recueil-ocr-'));
    const input = join(workspace, 'in.pdf');
    const output = join(workspace, 'out.pdf');
    const sidecar = join(workspace, 'out.txt');

    try {
      await writeFile(input, request.bytes);

      const args = [
        // `--skip-text` rather than `--force-ocr`: the pipeline only calls OCR when its own probe
        // found no text layer, and if OCRmyPDF disagrees it is the one holding the page.
        '--skip-text',
        '--language',
        languages.join('+'),
        '--sidecar',
        sidecar,
        '--output-type',
        'pdf',
        '--tesseract-timeout',
        String(this.pageTimeoutSeconds),
        '--quiet',
        ...this.extraArgs,
        input,
        output,
      ];

      const run = await this.spawn(args, request.signal);

      // Exit code 6 is "the file already has text and --skip-text was given", which is not an
      // error: it means the probe and OCRmyPDF disagreed and OCRmyPDF wins.
      if (run.code !== 0 && run.code !== 6) {
        throw new AdapterUnavailableError(
          'ocrmypdf',
          `exited with code ${String(run.code)}: ${run.stderr.trim().slice(0, 500)}`,
          { code: run.code },
        );
      }

      const text = await readFile(sidecar, 'utf8').catch(() => '');
      const pdf = await readFile(output).catch(() => undefined);

      const warnings: string[] = [];
      if (run.code === 6) warnings.push('OCRmyPDF found an existing text layer and skipped the page');
      if (run.stderr.trim().length > 0) warnings.push(run.stderr.trim().slice(0, 500));

      const result: OcrResult = {
        text: text.trim(),
        pageCount: request.pageCount ?? null,
        confidence: text.trim().length === 0 ? 0 : this.confidence,
        engine: this.id,
      };
      if (pdf !== undefined) result.pdf = pdf;
      if (warnings.length > 0) result.warnings = warnings;
      return result;
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async health(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    try {
      const run = await this.spawn(['--version'], undefined);
      if (run.code !== 0) {
        return { status: 'unavailable', message: run.stderr.trim().slice(0, 200), checkedAt };
      }
      return { status: 'ok', message: run.stdout.trim(), checkedAt };
    } catch (error) {
      return {
        status: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }

  private spawn(
    args: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal === undefined ? {} : { signal }),
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (error.code === 'ENOENT') {
          reject(
            new AdapterUnavailableError('ocrmypdf', `'${this.binary}' is not on PATH`, {
              binary: this.binary,
            }),
          );
          return;
        }
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
}
