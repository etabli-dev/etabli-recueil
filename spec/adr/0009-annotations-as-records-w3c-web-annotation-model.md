# 0009 — Annotations as records, W3C Web Annotation model

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Annotations embedded in PDF bytes break content-hash identity (ADR-0004) on every edit, and are not
portable to a web reader. Storing them only in a proprietary shape blocks export.

## Decision

Annotations are first-class database records using the W3C Web Annotation data model: a target
(document plus selector), a body, a type, a colour and an author. Export to embedded PDF annotations
is a conversion, not the storage format.

## Consequences

The underlying file is never rewritten, so its hash is stable. The same annotation renders in
PDF.js on every platform. Round-tripping annotations that arrive already embedded in a PDF requires
an extraction step at ingestion.
