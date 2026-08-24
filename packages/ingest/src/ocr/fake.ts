/**
 * The in-process OCR engine the tests use.
 *
 * Not a mock in the "records calls and returns undefined" sense — it is a real implementation of
 * `OcrEngine` with a deterministic corpus behind it, so a test can assert the whole route through
 * stage 5: no text layer, engine called once, text returned, text indexed, `ocr_status` set to
 * `done`, and the words findable through FTS5. `calls` exists so the resume test can prove the
 * expensive stage was *not* repeated, which is the only way to test a checkpoint honestly.
 */
import type { HealthReport, Sha256 } from '../types.js';
import type { OcrEngine, OcrRequest, OcrResult } from './engine.js';

export interface FakeOcrOptions {
  /** Digest to recognised text. A digest with no entry gets `defaultText`. */
  corpus?: Record<Sha256, string>;
  /** What to return for bytes not in the corpus. Empty means "recognised nothing". */
  defaultText?: string;
  /** Throw instead of answering, to exercise the `ocr_failed` route. */
  failWith?: Error;
  confidence?: number;
  /** Media types this engine claims. Defaults to PDFs and images. */
  supported?: readonly string[];
}

export class FakeOcrEngine implements OcrEngine {
  readonly id = 'fake';

  /** Every request, in order. The resume test reads `length`. */
  readonly calls: Array<{ sha256: Sha256; mediaType: string }> = [];

  private readonly corpus: Record<Sha256, string>;
  private readonly defaultText: string;
  private readonly failWith: Error | null;
  private readonly confidence: number;
  private readonly supported: ReadonlySet<string>;

  constructor(options: FakeOcrOptions = {}) {
    this.corpus = options.corpus ?? {};
    this.defaultText = options.defaultText ?? '';
    this.failWith = options.failWith ?? null;
    this.confidence = options.confidence ?? 0.65;
    this.supported = new Set(options.supported ?? ['application/pdf']);
  }

  supports(mediaType: string): boolean {
    return this.supported.has(mediaType) || (this.supported.has('image/*') && mediaType.startsWith('image/'));
  }

  async recognise(request: OcrRequest): Promise<OcrResult> {
    this.calls.push({ sha256: request.sha256, mediaType: request.mediaType });
    if (this.failWith !== null) throw this.failWith;
    const text = this.corpus[request.sha256] ?? this.defaultText;
    return {
      text,
      pageCount: request.pageCount ?? null,
      confidence: text.length === 0 ? 0 : this.confidence,
      engine: this.id,
    };
  }

  /** How many times these particular bytes were sent to OCR. */
  callsFor(sha256: Sha256): number {
    return this.calls.filter((call) => call.sha256 === sha256).length;
  }

  async health(): Promise<HealthReport> {
    return { status: 'ok', message: 'in-process fake', checkedAt: new Date().toISOString() };
  }
}
