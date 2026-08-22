/**
 * Exit codes.
 *
 * These are a published contract (docs/cli.qmd), not an implementation detail: cron jobs and CI
 * steps branch on them. `Review` is the interesting one — it exists because P3 ("flag, never
 * guess") needs a way to tell a shell script that a run finished but left work in the review
 * queue. A script that treats it as success is ignoring the queue it is filling.
 */
export const ExitCode = {
  /** The command did what it was asked to. */
  Success: 0,
  /** Unknown command, bad flag, bad argument — or a command that does not exist yet. */
  Usage: 1,
  /** The server refused the credential, or there was none. */
  Auth: 2,
  /** The server could not be reached at all. */
  Unreachable: 3,
  /** The job finished, but items were routed to the review queue. Not a failure. */
  Review: 4,
  /** The job itself failed. */
  JobFailed: 5,
} as const;

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCodeValue = (typeof ExitCode)[ExitCodeName];
