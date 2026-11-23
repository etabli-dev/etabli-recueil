#!/usr/bin/env node
/**
 * npm create recueil-plugin <directory> [--name <package>] [--author <name>] [--sdk <range>]
 */
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { scaffold } from '../src/scaffold.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: 'string' }, author: { type: 'string' }, sdk: { type: 'string' }, licence: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
if (values.help || positionals.length !== 1) {
  console.log('Usage: npm create recueil-plugin <directory> [--name <package>] [--author <name>] [--sdk <range>] [--licence <spdx>]');
  process.exit(values.help ? 0 : 1);
}
const directory = resolve(positionals[0]);
const name = values.name ?? `recueil-plugin-${basename(directory).replace(/^recueil-plugin-/u, '')}`;
try {
  const written = await scaffold(directory, { name, ...(values.author ? { author: values.author } : {}), ...(values.sdk ? { sdk: values.sdk } : {}), ...(values.licence ? { licence: values.licence } : {}) });
  console.log(`Created ${name} in ${directory}:\n  ${written.join('\n  ')}\nNext: cd ${positionals[0]} && npm install && npm test`);
} catch (error) {
  console.error(`create-recueil-plugin: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
