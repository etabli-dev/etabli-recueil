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
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ResourceBudgetError } from '../budgets.js';
import { AdapterUnavailableError } from '../errors.js';
import type { HealthReport } from '../types.js';
import type { OcrEngine, OcrRequest, OcrResult } from './engine.js';

/**
 * Defaults for what this adapter will read back out of the workspace.
 *
 * A sidecar's output is derived from a PDF a stranger sent, so it is untrusted in the ADR-0022
 * sense even though the process itself is one the operator chose to run. Both reads were
 * unbounded `readFile`s; a page of text is kilobytes and an OCR'd scan is tens of megabytes, so
 * these are generous and still a bound.
 */
export const DEFAULT_OCR_MAX_TEXT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_OCR_MAX_PDF_BYTES = 512 * 1024 * 1024;

/** How much of the child's stdout and stderr is kept. Only 500 characters are ever read. */
const MAX_CAPTURE = 64 * 1024;

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
  /** Ceiling on the sidecar text file this adapter will read back. */
  maxTextBytes?: number;
  /** Ceiling on the OCR'd PDF this adapter will read back. */
  maxOutputBytes?: number;
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
  private readonly maxTextBytes: number;
  private readonly maxOutputBytes: number;

  constructor(options: OcrMyPdfOptions = {}) {
    this.binary = options.binary ?? 'ocrmypdf';
    this.languages = options.languages ?? ['eng'];
    this.pageTimeoutSeconds = options.pageTimeoutSeconds ?? 180;
    this.extraArgs = options.extraArgs ?? [];
    this.scratchRoot = options.scratchRoot ?? tmpdir();
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.confidence = options.confidence ?? 0.6;
    this.maxTextBytes = options.maxTextBytes ?? DEFAULT_OCR_MAX_TEXT_BYTES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OCR_MAX_PDF_BYTES;
  }

  supports(mediaType: string): boolean {
    return mediaType === 'application/pdf' || mediaType.startsWith('image/');
  }

  async recognise(request: OcrRequest): Promise<OcrResult> {
    const languages = request.languages ?? this.languages;
    // `mkdtemp` does not create its parent, and a configured `scratchRoot` that does not exist yet
    // is an ordinary state on a fresh deployment — the same defect `ScratchManager` carried.
    await mkdir(this.scratchRoot, { recursive: true });
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

      const text = (await readBounded(sidecar, this.maxTextBytes, 'ocr.maxTextBytes'))?.toString('utf8') ?? '';
      const pdf = (await readBounded(output, this.maxOutputBytes, 'ocr.maxOutputBytes')) ?? undefined;

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

      /*
       * Bounded accumulation.
       *
       * Only the first five hundred characters of either stream are ever used — they go into an
       * `AdapterUnavailableError` message or a warning — and a `+=` with no ceiling holds however
       * much a chatty sidecar, or a wrapper script in a loop, decides to print. `MAX_CAPTURE`
       * keeps that a constant. It is far more than any real diagnostic and far less than a stream
       * nobody is reading can grow to.
       */
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8').slice(0, MAX_CAPTURE);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8').slice(0, MAX_CAPTURE);
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

/**
 * Read a file the sidecar wrote, under a ceiling.
 *
 * The size is taken from a `stat` of a path inside a directory this process created with `mkdtemp`
 * and is about to delete, so the check and the read are not racing an outsider — which is the one
 * thing that makes a stat-then-read acceptable here rather than the shape ADR-0022 §2 forbids. A
 * file the sidecar did not write is `null` rather than an error, exactly as the `.catch(() => …)`
 * this replaces intended; a file it wrote and that is too big is a named refusal, because a silent
 * empty result would look like "OCR found no text".
 */
const readBounded = async (
  path: string,
  limit: number,
  limitName: string,
): Promise<Buffer | null> => {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  if (size > limit) {
    throw new ResourceBudgetError(
      limitName,
      limit,
      `OCRmyPDF wrote ${size} bytes to '${path}', over the ${limitName} budget of ${limit}.`,
      { path, byteSize: size },
    );
  }
  try {
    return await readFile(path);
  } catch {
    return null;
  }
};
