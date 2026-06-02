/**
 * Messaging_Service domain errors (Req 27.1-27.8).
 *
 * These make the service's not-found and fail-closed access conditions explicit
 * and testable. {@link ChannelNotFoundError} and {@link ChannelMessageNotFoundError}
 * are raised when an operation targets a resource that does not exist within the
 * caller's Organization (tenant scoping already prevents cross-tenant reads, so
 * "not in my tenant" surfaces as "not found"); {@link ChannelAccessDeniedError}
 * is the fail-closed denial raised when a user who is not a member attempts to
 * read or post to a private channel (Req 27.8), and is recorded in the
 * Audit_Service by the service before it is thrown.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** Stable machine-readable code for a missing channel. */
export const CHANNEL_NOT_FOUND_CODE = 'CHANNEL_NOT_FOUND' as const;

/** Stable machine-readable code for a missing channel message. */
export const CHANNEL_MESSAGE_NOT_FOUND_CODE = 'CHANNEL_MESSAGE_NOT_FOUND' as const;

/** Stable machine-readable code for a denied private-channel access (Req 27.8). */
export const CHANNEL_ACCESS_DENIED_CODE = 'CHANNEL_ACCESS_DENIED' as const;

/**
 * Thrown when a channel referenced by an operation does not exist within the
 * caller's Organization.
 */
export class ChannelNotFoundError extends Error {
  /** The channel id that was looked up. */
  readonly channelId: string;

  constructor(channelId: string) {
    super(`Channel "${channelId}" was not found in the current organization`);
    this.name = 'ChannelNotFoundError';
    this.channelId = channelId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: CHANNEL_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { channelId: this.channelId },
    });
  }
}

/**
 * Thrown when a message referenced by an operation (e.g. a reply's parent) does
 * not exist within the caller's Organization.
 */
export class ChannelMessageNotFoundError extends Error {
  /** The message id that was looked up. */
  readonly messageId: string;

  constructor(messageId: string) {
    super(`Channel message "${messageId}" was not found in the current organization`);
    this.name = 'ChannelMessageNotFoundError';
    this.messageId = messageId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: CHANNEL_MESSAGE_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { messageId: this.messageId },
    });
  }
}

/**
 * Thrown when a non-member attempts to read or post to a private channel — the
 * fail-closed Access_Control restriction on private channels (Req 27.8).
 *
 * The Messaging_Service records the denied attempt in the Audit_Service before
 * raising this (Req 37.2).
 */
export class ChannelAccessDeniedError extends Error {
  /** The channel the access was denied for. */
  readonly channelId: string;
  /** The user whose access was denied. */
  readonly userId: string;

  constructor(channelId: string, userId: string) {
    super(`User "${userId}" is not a member of private channel "${channelId}"`);
    this.name = 'ChannelAccessDeniedError';
    this.channelId = channelId;
    this.userId = userId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authorization',
      code: CHANNEL_ACCESS_DENIED_CODE,
      message: this.message,
      correlationId,
      details: { channelId: this.channelId, userId: this.userId },
    });
  }
}
