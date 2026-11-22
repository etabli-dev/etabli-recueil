#!/usr/bin/env node
/**
 * `recueil` — the entry point.
 *
 * Copyright (c) 2026 R. Heller. All rights reserved.
 */
import { main } from './main.js';

void main(process.argv).then((code) => {
  // Set rather than passed to process.exit, so that buffered stdout is flushed before the process
  // goes: `recueil export ... > file.bib` must not lose its last chunk to a hurried exit.
  process.exitCode = code;
});
