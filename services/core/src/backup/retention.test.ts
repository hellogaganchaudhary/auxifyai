/**
 * Unit tests for the pure backup-retention core (Req 39.4).
 *
 * These verify the boundary arithmetic of the retention window in isolation from
 * the service: the window is inclusive at its closing instant, so a backup is
 * retained *exactly* within `[createdAt, createdAt + retentionMs]` and is
 * eligible for purge strictly past the deadline.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKUP_RETENTION_MS,
  isRetentionExpired,
  isWithinRetention,
  retentionDeadlineMs,
} from './retention.js';

const CREATED_AT = Date.UTC(2026, 0, 1, 0, 0, 0);
const RETENTION = DEFAULT_BACKUP_RETENTION_MS;

describe('retentionDeadlineMs (Req 39.4)', () => {
  it('is the capture instant plus the retention duration', () => {
    expect(retentionDeadlineMs(CREATED_AT, RETENTION)).toBe(CREATED_AT + RETENTION);
  });
});

describe('isWithinRetention (Req 39.4)', () => {
  it('is true at the capture instant (window open)', () => {
    expect(isWithinRetention(CREATED_AT, CREATED_AT, RETENTION)).toBe(true);
  });

  it('is true strictly inside the window', () => {
    expect(isWithinRetention(CREATED_AT, CREATED_AT + RETENTION - 1, RETENTION)).toBe(true);
  });

  it('is true exactly at the closing instant (inclusive boundary)', () => {
    expect(isWithinRetention(CREATED_AT, CREATED_AT + RETENTION, RETENTION)).toBe(true);
  });

  it('is false one millisecond past the closing instant', () => {
    expect(isWithinRetention(CREATED_AT, CREATED_AT + RETENTION + 1, RETENTION)).toBe(false);
  });

  it('is false before the capture instant (non-physical clock)', () => {
    expect(isWithinRetention(CREATED_AT, CREATED_AT - 1, RETENTION)).toBe(false);
  });
});

describe('isRetentionExpired (Req 39.4)', () => {
  it('is the strict complement of within-retention at and after the deadline', () => {
    expect(isRetentionExpired(CREATED_AT, CREATED_AT + RETENTION, RETENTION)).toBe(false);
    expect(isRetentionExpired(CREATED_AT, CREATED_AT + RETENTION + 1, RETENTION)).toBe(true);
  });
});
