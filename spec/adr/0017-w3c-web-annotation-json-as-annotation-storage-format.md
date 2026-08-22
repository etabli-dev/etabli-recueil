# 0017 — W3C Web Annotation JSON as the annotation storage format

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0 (governs Phase 4)

## Context

ADR-0009 decided that annotations are database records rather than bytes inside the PDF, and named
the W3C Web Annotation data model as the conceptual model. It stopped there. It left open what
Phase 4 actually stores: a normalised relational schema of our own design that merely borrows the
model's vocabulary, or the model's own JSON serialisation kept intact as the stored payload. §10
lists this as the open Phase 4 question.

The difference matters at the edges. A schema of our own invites a bespoke selector vocabulary,
which then has to be specified, versioned and mapped to something else on every import and export. A
stored payload in the standard's own serialisation means the import and export of Hypothesis, of
another Web Annotation client, or of a future reader are mappings rather than translations.

## Decision

This ADR restates ADR-0009 at the storage-format level and fixes it: the stored and transported
representation of an annotation is W3C Web Annotation JSON — the Web Annotation Data Model in its
JSON-LD serialisation, with the `http://www.w3.org/ns/anno.jsonld` context.

Each annotation row holds the complete annotation document in a JSON column, plus indexed columns for
the fields the application queries: id, item, document, author, motivation and Recueil annotation
type, colour, created, modified, page and in-page ordering position, and the extracted quote text for
full-text indexing (§5.7). The indexed columns are derived from the payload by the write path and are
never edited independently of it; there is one writer.

Selectors are the model's own, not ours:

- text highlights and text-anchored notes use a `TextQuoteSelector` with prefix and suffix, refined
  by a `TextPositionSelector`
- area and image annotations use a `FragmentSelector` with a media-fragment `xywh=` value, plus the
  page number
- ink annotations use an `SvgSelector`

The REST API returns the same JSON it stores. Export of a document's or a library's annotations is an
`AnnotationPage` / `AnnotationCollection`, not a Recueil-specific envelope.

## Consequences

There is no bespoke selector vocabulary to specify, document or version, and the annotation payload
is portable to anything that speaks the standard. Anchoring a quote selector against a re-OCRed or
re-processed text layer is a solved problem with published implementations rather than one to invent.

PDF.js does not speak the model, so an adapter is needed in both directions in Phase 4. Export to
embedded PDF annotations remains a conversion, as ADR-0009 said, and the round trip is lossy in one
direction: an embedded annotation that carries coordinates but no surrounding text yields a position
selector with no quote, which will not survive a re-layout of the document.

Duplicating fields between the payload and the indexed columns is a consistency hazard. It is
contained by the single-writer rule and by deriving the columns rather than accepting them from
clients. Queries needing a field that is not indexed fall back to SQLite's JSON functions, which is
acceptable at single-user scale (ADR-0015) and is exactly the case Meilisearch (ADR-0011) covers when
it stops being acceptable.

JSON-LD brings a context document and an expansion algorithm that Recueil does not otherwise need.
The stored payload is treated as plain JSON in a fixed shape; the context is emitted for consumers
and is not resolved at runtime.
