/**
 * Device_Manager (Req 33.10, 33.11, 33.13, 20.5): the service that lets a user
 * or an administrator see and control the sessions that authenticate as a user.
 *
 * The {@link DeviceManager} lists a user's ACTIVE devices and sessions with
 * their last-active time (Req 33.10), revokes a single device's session tokens
 * while leaving the user's other devices signed in (Req 33.11), revokes one
 * session on sign-out (Req 33.13), and — on administrative user deactivation —
 * invalidates EVERY active session AND records the account as deactivated so the
 * user can no longer authenticate (Req 20.5).
 *
 * It deliberately COMPOSES the Auth_Service's session model rather than
 * inventing a parallel one: the SAME {@link import('../auth/index.js').SessionStore}
 * the {@link import('../auth/index.js').AuthService} writes is injected here, so
 * a revocation performed by the Device_Manager is immediately visible to
 * `AuthService.validate` / `AuthService.refresh`. A revoked session is marked
 * with `revokedAt` and RETAINS its one-way token hashes (digests, not secrets)
 * — exactly as `AuthService.signOut` does — so a later `validate` / `refresh`
 * resolves the record by its hash and rejects it with the precise
 * {@link import('../auth/index.js').InvalidSessionError} reason `'revoked'`.
 *
 * Every external capability is a narrow injectable port — the shared
 * {@link import('../auth/index.js').SessionStore}, the shared
 * {@link import('../audit/index.js').AuditRecorder} (Req 37.1), a
 * {@link DeactivationStore} (the "prevent the user from authenticating" half of
 * Req 20.5), and a {@link DeviceClock} (so "active" is evaluated
 * deterministically) — so the manager is pure orchestration and fully
 * unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * Surface:
 *   - {@link DeviceManager} — the service; one method per acceptance criterion:
 *     `listDevices` (Req 33.10), `revokeDevice` (Req 33.11), `revokeSession`
 *     (Req 33.13), and `deactivateUser` (Req 20.5);
 *   - {@link toDeviceSession} — the pure record→masked projection that drops
 *     every token hash so it never crosses the service boundary;
 *   - the {@link DeviceSession} listing shape, the injectable
 *     {@link DeactivationStore} and {@link DeviceClock} ports, and the
 *     {@link systemDeviceClock} default;
 *   - the typed {@link DeviceNotFoundError} and its stable
 *     {@link DEVICE_NOT_FOUND_CODE}.
 *
 * The Auth_Service's {@link import('../auth/index.js').SessionStore} and
 * {@link import('../auth/index.js').SessionRecord} are consumed here as TYPES
 * only and are NOT re-exported from this barrel — the auth barrel already
 * exports them, so re-exporting would collide at the package barrel. The
 * in-memory test fakes (a capturing audit recorder, an in-memory deactivation
 * store, the advanceable {@link MutableDeviceClock}, the session-record builder,
 * and the re-used in-memory session store) live in `./fakes.js` and are
 * intentionally NOT re-exported here — they would collide with the equally-named
 * audit-recorder / clock fakes of sibling modules at the package barrel.
 * Following the established convention, the tests import them directly from
 * `./fakes.js`.
 *
 * The injectable clock is surfaced as {@link DeviceClock} / {@link systemDeviceClock}
 * (rather than `Clock` / `systemClock`) so the names never collide with the
 * Auth_Service's, Model_Router's, Scheduler's, or Backup_Service's
 * identically-purposed clocks in the shared `@auxify/core` barrel; the domain
 * names are `Device`-prefixed for the same reason.
 */

export {
  DeviceManager,
  toDeviceSession,
  type DeviceManagerOptions,
} from './device-manager.js';

export { DeviceNotFoundError, DEVICE_NOT_FOUND_CODE } from './errors.js';

export {
  systemDeviceClock,
  type DeviceSession,
  type DeactivationStore,
  type DeviceClock,
} from './types.js';
