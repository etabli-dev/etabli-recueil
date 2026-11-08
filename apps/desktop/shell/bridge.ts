/**
 * The four commands the shell process answers (`src-tauri/src/lib.rs`), typed.
 *
 * The capability file grants these and nothing else, so this module is the whole of what a page in
 * the window can ask the operating system for.
 */
import { invoke } from '@tauri-apps/api/core';

export interface ShellState {
  serverUrl: string;
  defaultServerUrl: string;
  /** False on the first run, and when the settings file could not be used. */
  saved: boolean;
  settingsProblem: string | null;
  /** Where the token for `serverUrl` is: nowhere, the system credential store, or this session. */
  token: 'none' | 'stored' | 'session';
  credentialStoreProblem: string | null;
}

/** The shape `apps/web/src/host.ts` expects. */
export interface Connection {
  baseUrl: string;
  token?: string;
}

export const shellState = (): Promise<ShellState> => invoke<ShellState>('shell_state');

/** The address in canonical form, or a rejection carrying the reason in a sentence. */
export const checkServerUrl = (serverUrl: string): Promise<string> =>
  invoke<string>('check_server_url', { serverUrl });

export const saveConnection = (request: {
  serverUrl: string;
  token?: string;
  forgetToken: boolean;
}): Promise<ShellState> =>
  invoke<ShellState>('save_connection', {
    serverUrl: request.serverUrl,
    token: request.token ?? null,
    forgetToken: request.forgetToken,
  });

export const connection = (): Promise<Connection> => invoke<Connection>('connection');

/** Command rejections arrive as the plain string the Rust side returned. */
export const describeError = (error: unknown): string =>
  typeof error === 'string' ? error : error instanceof Error ? error.message : 'The shell did not answer.';
