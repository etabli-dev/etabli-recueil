# 0013 — Curation canvas in-app, ggraph for publication figures

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0 (governs Phase 6)

## Context

A CuratedNetwork (§5.9) is a versioned JSON document, and Phase 6 builds a Cytoscape.js editor over
it. The open question was how far that editor should go: a curation tool that decides what is in the
figure, or a real figure editor that also produces the finished artwork. The second is a much larger
project — font embedding and kerning, colour management for print, legend and callout typography,
vector output that survives a journal's production pipeline — and it competes with Illustrator,
Inkscape and, for the audience Recueil is actually built for, with ggraph.

The people who will use this are already rendering figures in R. Phase 5 ships `rc_graph()` returning
tidygraph, so the tooling for the final render exists before the editor does.

## Decision

The in-app editor is a curation canvas, not a figure renderer. It owns what the figure contains and
how it is arranged: node and edge selection, promotion of shadow works, manual edges, groups and
clusters, layout algorithm and parameters, pinned positions, an optional timeline axis, style
mappings from fields to colour/shape/size, and annotation objects (labels, callouts, hulls, legends,
text boxes).

The supported publication path is export to tidygraph via the R package and final rendering in
ggraph. In-app SVG, PDF and PNG export exists and is labelled draft quality — good enough for a
slide, a preprint or a colleague, not the route to camera-ready artwork. GraphML, GEXF, JSON and
TikZ export cover the other destinations.

The export contract must be lossless enough for the R render to reproduce the curated result:
computed positions, pinned flags, group membership, style mappings and annotation objects all travel
with the graph, not just nodes and edges. Anything the canvas can draw that tidygraph cannot carry is
draft-only and is marked as such in the editor.

Revisit after the first real figure is produced end to end — that is the Phase 6 exit criterion.

## Consequences

Phase 6 stays at M–L effort and buys no typography, font-embedding or colour-management work. The
canvas can be judged on one thing, whether the right nodes are in the picture, which is the part no
other tool can do because only Recueil holds the library.

Someone who does not use R gets SVG into Inkscape, which is a worse experience than a native
renderer would be. That is accepted for v1 and is the specific thing the revisit looks at.

The annotation objects are the risk: callouts and hulls have no obvious tidygraph representation, so
either the R side grows helpers for them or they stay draft-only and the finished figure re-creates
them in ggplot2 layers. This is decided when the first figure is made, not before.
