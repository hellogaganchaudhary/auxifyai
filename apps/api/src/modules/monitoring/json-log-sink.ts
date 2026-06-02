/**
 * JSON {@link LogSink} for the api app's Monitoring_Service wiring (Req 46.7).
 *
 * Writes each {@link StructuredLogEntry} as a single JSON line (newline-
 * terminated) so a process-level log collector can scrape stdout/stderr by
 * line. `debug`/`info` go to stdout; `warn`/`error` go to stderr — the standard
 * separation a log shipper expects. The two writers are injectable so unit
 * tests capture the lines without touching the real process streams.
 *
 * SECURITY (Req 34.7): the entry is already normalized to be JSON-serializable
 * and secret-free by the core {@link import('@auxify/core').toSerializableEntry}
 * before it reaches a sink — this writer only renders that entry as JSON. A
 * caller must NEVER place a token, password, or secret-store value in a
 * message or field; secrets are referenced by name only.
 */

import type { LogSink, StructuredLogEntry } from '@auxify/core';

import type { JsonLogSinkOptions } from './types';

/** Default stdout writer: write a JSON line through `process.stdout.write`. */
function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Default stderr writer: write a JSON line through `process.stderr.write`. */
function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * A {@link LogSink} that emits each entry as a single JSON line on stdout
 * (`debug`/`info`) or stderr (`warn`/`error`) (Req 46.7).
 *
 * The entry is serialized with `JSON.stringify`. The core
 * {@link import('@auxify/core').MonitoringService} normalizes the entry with
 * {@link import('@auxify/core').toSerializableEntry} BEFORE calling
 * {@link JsonLogSink.emit}, so any non-serializable field has already been
 * dropped and `JSON.stringify` cannot throw on the typed shape.
 */
export class JsonLogSink implements LogSink {
  private readonly stdout: (line: string) => void;
  private readonly stderr: (line: string) => void;

  constructor(options: JsonLogSinkOptions = {}) {
    this.stdout = options.stdout ?? defaultStdout;
    this.stderr = options.stderr ?? defaultStderr;
  }

  /**
   * Emit one structured log entry as a single JSON line on the appropriate
   * stream (Req 46.7).
   *
   * @param entry The entry to write (already JSON-serializable, secret-free).
   */
  emit(entry: StructuredLogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === 'warn' || entry.level === 'error') {
      this.stderr(line);
    } else {
      this.stdout(line);
    }
  }
}
