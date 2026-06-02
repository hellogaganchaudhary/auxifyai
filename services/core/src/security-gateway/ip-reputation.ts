/**
 * IP / abuse gating for the Security_Gateway (Req 34, WAF).
 *
 * Before a request is authenticated or routed, the gateway screens its
 * originating IP against an abuse / deny list so a known-bad source is refused
 * at the edge. {@link StaticIpReputation} implements the {@link IpReputation}
 * port over a fixed set of blocked IPs — the simple, deterministic backing the
 * gateway uses in tests and minimal deployments; production wires a WAF /
 * threat-intel feed implementing the same port.
 *
 * The default policy is fail-open *only for the unknown* — an IP not on the
 * block list is permitted — while the gateway itself fails *closed* if the
 * reputation port throws, so an un-screenable request is never routed.
 */

import type { IpReputation, IpReputationVerdict } from './types.js';

/**
 * A {@link IpReputation} backed by a static, in-memory set of blocked IPs
 * (Req 34).
 *
 * An IP in the blocked set is denied (`blocked: true`); any other IP is
 * permitted. {@link block} / {@link unblock} adjust the set so a test can model
 * an abusive source becoming (un)blocked.
 */
export class StaticIpReputation implements IpReputation {
  private readonly blocked: Set<string>;

  constructor(blocked: Iterable<string> = []) {
    this.blocked = new Set(blocked);
  }

  /** Add an IP to the block list. */
  block(ip: string): void {
    this.blocked.add(ip);
  }

  /** Remove an IP from the block list. */
  unblock(ip: string): void {
    this.blocked.delete(ip);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port
  async evaluate(ip: string): Promise<IpReputationVerdict> {
    if (this.blocked.has(ip)) {
      return { blocked: true, reason: `IP "${ip}" is on the abuse block list` };
    }
    return { blocked: false };
  }
}

/**
 * An {@link IpReputation} that permits every IP — used where IP gating is
 * handled by an upstream WAF, or disabled.
 */
export class AllowAllIpReputation implements IpReputation {
  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port
  async evaluate(): Promise<IpReputationVerdict> {
    return { blocked: false };
  }
}
