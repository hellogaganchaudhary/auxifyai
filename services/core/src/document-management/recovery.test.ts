/**
 * Unit tests for the pure recovery-window core (Req 28.7).
 *
 * These verify the boundary arithmetic of the recovery window in isolation from
 * the service: the window is inclusive at its closing instant, so recovery
 * succeeds *exactly* within `[deletedAt, deletedAt + windowMs]` and is expired
 * strictly past the deadline (the basis of the companion Property 60).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RECOVERY_WINDOW_MS,
  isRecoveryWindowExpired,
  isWithinRecoveryWindow,
  recoveryDeadlineMs,
} from './recovery.js';

const DELETED_AT = Date.UTC(2026, 0, 1, 0, 0, 0);
const WINDOW = DEFAULT_RECOVERY_WINDOW_MS;

describe('recoveryDeadlineMs (Req 28.7)', () => {
  it('is the deletion instant plus the window duration', () => {
    expect(recoveryDeadlineMs(DELETED_AT, WINDOW)).toBe(DELETED_AT + WINDOW);
  });
});

describe('isWithinRecoveryWindow (Req 28.7, Property 60)', () => {
  it('is true at the deletion instant (window open)', () => {
    expect(isWithinRecoveryWindow(DELETED_AT, DELETED_AT, WINDOW)).toBe(true);
  });

  it('is true strictly inside the window', () => {
    expect(isWithinRecoveryWindow(DELETED_AT, DELETED_AT + WINDOW - 1, WINDOW)).toBe(true);
  });

  it('is true exactly at the closing instant (inclusive boundary)', () => {
    expect(isWithinRecoveryWindow(DELETED_AT, DELETED_AT + WINDOW, WINDOW)).toBe(true);
  });

  it('is false one millisecond past the closing instant', () => {
    expect(isWithinRecoveryWindow(DELETED_AT, DELETED_AT + WINDOW + 1, WINDOW)).toBe(false);
  });

  it('is false before the deletion instant (non-physical clock)', () => {
    expect(isWithinRecoveryWindow(DELETED_AT, DELETED_AT - 1, WINDOW)).toBe(false);
  });
});

describe('isRecoveryWindowExpired (Req 28.7)', () => {
  it('is the strict complement of within-window at and after the deadline', () => {
    expect(isRecoveryWindowExpired(DELETED_AT, DELETED_AT + WINDOW, WINDOW)).toBe(false);
    expect(isRecoveryWindowExpired(DELETED_AT, DELETED_AT + WINDOW + 1, WINDOW)).toBe(true);
  });
});
