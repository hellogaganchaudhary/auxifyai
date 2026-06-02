/**
 * Device_Manager typed errors (Req 33.10, 33.11).
 *
 * The Device_Manager's revocation operations are deliberately idempotent — a
 * sign-out or device revocation that resolves no live session simply does
 * nothing (it never reveals whether a session exists) — so the module needs few
 * rejection errors. {@link DeviceNotFoundError} is provided for callers that
 * want a strict "this device has no sessions" signal (for example an
 * administrative console acting on a device picked from the listing). It
 * projects into the platform-wide serializable {@link PlatformError} (Req 46.8)
 * so the same wire shape crosses the REST_API, the WebSocket_Gateway, and the
 * SDK, carrying structured, secret-free `details`.
 *
 * SECURITY: this error never carries a token hash, a session secret, or any
 * other sensitive material — only the non-secret device id that was looked up.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** The stable machine-readable code for a device with no matching sessions (Req 33.11). */
export const DEVICE_NOT_FOUND_CODE = 'DEVICE_NOT_FOUND' as const;

/**
 * Thrown when a device-scoped operation targets a {@link deviceId} that has no
 * matching session for the user (Req 33.11).
 *
 * The Device_Manager's `revokeDevice` is idempotent and does NOT raise this by
 * default (revoking a device with no live sessions revokes zero and returns
 * `0`); it is offered for callers that explicitly require a strict signal that
 * the named device was unknown. Categorized `not_found`.
 */
export class DeviceNotFoundError extends Error {
  /** The device id that was looked up (safe to surface; not a secret). */
  readonly deviceId: string;
  /** The user the device lookup was scoped to. */
  readonly userId: string;

  constructor(userId: string, deviceId: string) {
    super(`No session found for device "${deviceId}" and user "${userId}"`);
    this.name = 'DeviceNotFoundError';
    this.userId = userId;
    this.deviceId = deviceId;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `not_found`, code {@link DEVICE_NOT_FOUND_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: DEVICE_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { userId: this.userId, deviceId: this.deviceId },
    });
  }
}
