/**
 * Stage 5, behind an interface.
 *
 * CONCEPT §5.3 stage 5 is "OCR when no text layer (OCRmyPDF) → text layer + extracted text", and
 * §5.1 puts OCRmyPDF in the optional sidecars. Optional is the operative word: a Recueil that has
 * no OCR worker must still ingest, and a test suite that needs a container is a test suite that
 * does not run. So the pipeline never speaks to OCRmyPDF. It speaks to this interface, and what is
 * behind it is a deployment decision.
 *
 * Two implementations ship: `OcrMyPdfEngine`, which shells out to a real `ocrmypdf` and is not
 * exercised by any test in this package, and `FakeOcrEngine`, which is in-process, deterministic
 * and is what every test uses. `README.md` says how to turn the real one on.
 */
import type { HealthReport, Sha256 } from '../types.js';

export interface OcrRequest {
  bytes: Buffer;
  mediaType: string;
  /** The digest of `bytes`. Handed over so an engine can cache without re-hashing. */
  sha256: Sha256;
  /** BCP 47 or Tesseract language codes, in preference order. */
  languages?: readonly string[];
  pageCount?: number | null;
  signal?: AbortSignal;
}

export interface OcrResult {
  /** The recognised text. Empty is a legitimate answer and is not an error. */
  text: string;
  /** The searchable PDF, when the engine produced one. Ingested as a derived document. */
  pdf?: Buffer;
  pageCount?: number | null;
  /** 0..1. An engine that cannot estimate confidence reports its configured default, never 1. */
  confidence: number;
  /** Which engine, for `field_provenance.source` and the job log. */
  engine: string;
  /** Anything the operator should see: a language fallback, a page that failed. */
  warnings?: string[];
}

export interface OcrEngine {
  readonly id: string;
  /** Can this engine do anything with these bytes? A PDF-only engine says so. */
  supports(mediaType: string): boolean;
  recognise(request: OcrRequest): Promise<OcrResult>;
  health?(): Promise<HealthReport>;
}

/**
 * The engine used when none is configured.
 *
 * It recognises nothing and says so, which is the honest behaviour for a deployment with no OCR
 * worker: `documents.ocr_status` becomes `skipped`, the scan is filed with no text, and the
 * confidence gate sees a document with no metadata and routes it to review. The alternative —
 * pretending a scan has no text because nobody looked — would file it silently and lose it.
 */
export class UnavailableOcrEngine implements OcrEngine {
  readonly id = 'none';

  supports(): boolean {
    return false;
  }

  async recognise(): Promise<OcrResult> {
    return {
      text: '',
      confidence: 0,
      engine: this.id,
      warnings: ['no OCR engine is configured; the scan was filed without text'],
    };
  }

  async health(): Promise<HealthReport> {
    return {
      status: 'unavailable',
      message: 'No OCR engine is configured.',
      checkedAt: new Date().toISOString(),
    };
  }
}
