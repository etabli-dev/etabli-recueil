/**
 * The rule format version.
 *
 * A rule set is stored data, so the number is part of the contract rather than a comment. Version 1
 * is what this package reads and writes; a reader that meets a higher number refuses the set rather
 * than guessing what a construct it has never heard of was supposed to do, because guessing at
 * ingestion rules means filing somebody's documents wrongly and calling it success.
 */
export const RULE_FORMAT_VERSION = 1;

/** Every version this build can read. Widened when a compatible version is added, never narrowed. */
export const SUPPORTED_RULE_FORMAT_VERSIONS: readonly number[] = [RULE_FORMAT_VERSION];
