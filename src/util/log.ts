/**
 * Output channel logging.
 *
 * FROZEN CONTRACT — modules import { log } and call log.debug/info/warn/error.
 * Nothing in this extension writes to console directly.
 */

import * as vscode from 'vscode';

class Logger {
  private channel: vscode.LogOutputChannel | undefined;

  /** Called once from activate(). Safe to log before this runs; those lines drop. */
  init(channel: vscode.LogOutputChannel): void {
    this.channel = channel;
  }

  debug(message: string, ...args: unknown[]): void {
    this.channel?.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.channel?.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.channel?.warn(message, ...args);
  }

  error(message: string, error?: unknown): void {
    if (error === undefined) {
      this.channel?.error(message);
    } else if (error instanceof Error) {
      this.channel?.error(`${message}: ${error.message}`);
    } else {
      this.channel?.error(`${message}: ${String(error)}`);
    }
  }

  show(): void {
    this.channel?.show();
  }
}

export const log = new Logger();

/** Run `fn`, log and swallow any throw, return `fallback`. */
export function safely<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    log.error(label, error);
    return fallback;
  }
}

/** Async form of `safely`. */
export async function safelyAsync<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    log.error(label, error);
    return fallback;
  }
}
