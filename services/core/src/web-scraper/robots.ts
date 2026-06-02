/**
 * Pure `robots.txt` evaluation for the Web_Scraper (Req 14.5).
 *
 * Before scraping a domain the Web_Scraper evaluates that domain's `robots.txt`
 * and skips any path it disallows (Req 14.5). This module parses a `robots.txt`
 * body into the directives that apply to the scraper's user agent and decides
 * whether a given path is allowed, using the standard precedence rule: the
 * longest matching path of an `Allow`/`Disallow` directive wins, with `Allow`
 * winning ties (so a site can carve an allowed sub-path out of a disallowed
 * tree).
 *
 * The functions are pure and total so the scraper can evaluate robots rules
 * deterministically in unit tests with no network. SECURITY: the `robots.txt`
 * body is untrusted text; it is parsed line-by-line as data only.
 */

/** A single `Allow`/`Disallow` rule from a `robots.txt` group. */
interface RobotsRule {
  /** Whether this rule allows (`true`) or disallows (`false`) the path prefix. */
  allow: boolean;
  /** The path prefix the rule matches (may be empty, meaning "match nothing"). */
  path: string;
}

/** The directives that apply to a particular user agent. */
export interface RobotsRules {
  /** The ordered `Allow`/`Disallow` rules that apply to the evaluated agent. */
  rules: RobotsRule[];
}

/** The token matching every user agent in a `robots.txt` group line. */
const WILDCARD_AGENT = '*';

/**
 * Parse a `robots.txt` body into the rules that apply to `userAgent`.
 *
 * Group selection follows the convention: a group's `User-agent` lines name the
 * agents it applies to; the rules for the most specific matching agent are
 * used, falling back to the `*` group. A `null`/empty body (no `robots.txt`
 * published) yields an empty rule set, i.e. everything allowed.
 *
 * @param body The raw `robots.txt` text, or `null` when none is published.
 * @param userAgent The scraper's user agent token to match groups against.
 * @returns The applicable rules.
 */
export function parseRobots(body: string | null, userAgent: string): RobotsRules {
  if (body === null || body.trim().length === 0) {
    return { rules: [] };
  }

  const agent = userAgent.toLowerCase();
  // Collect rules per agent group. Group boundaries are runs of `User-agent`
  // lines followed by directive lines.
  const groups = new Map<string, RobotsRule[]>();
  let currentAgents: string[] = [];
  let expectingAgents = true;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    const sep = line.indexOf(':');
    if (sep === -1) {
      continue;
    }
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      // A new run of agent lines starts a fresh group.
      if (!expectingAgents) {
        currentAgents = [];
        expectingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      ensureGroups(groups, currentAgents);
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      expectingAgents = false;
      if (currentAgents.length === 0) {
        continue;
      }
      const rule: RobotsRule = { allow: field === 'allow', path: value };
      for (const a of currentAgents) {
        groups.get(a)?.push(rule);
      }
    }
    // Other directives (Crawl-delay, Sitemap, …) are ignored for path gating.
  }

  const selected = selectAgentRules(groups, agent);
  return { rules: selected };
}

/**
 * Decide whether `path` is allowed by the parsed `rules` (Req 14.5).
 *
 * Applies the longest-match-wins precedence: among all rules whose path prefix
 * matches `path`, the one with the longest prefix decides; an `Allow` wins a
 * tie with an equally-long `Disallow`. With no matching rule, the path is
 * allowed.
 *
 * @param rules The applicable rules from {@link parseRobots}.
 * @param path The request path (and query) to test.
 * @returns `true` if the path may be fetched.
 */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  const match = matchingRule(rules, path);
  return match === null ? true : match.allow;
}

/**
 * Return the most specific matching rule for `path`, or `null` when none match
 * (so the path is allowed). Exposed so the scraper can surface the matched
 * disallow rule in a {@link import('./errors.js').RobotsDisallowedError}.
 *
 * @param rules The applicable rules.
 * @param path The request path (and query) to test.
 */
export function matchingRule(
  rules: RobotsRules,
  path: string,
): { allow: boolean; path: string } | null {
  let best: RobotsRule | null = null;
  for (const rule of rules.rules) {
    if (rule.path.length === 0) {
      // An empty `Disallow:` means "allow all"; an empty `Allow:` is a no-op.
      // Neither participates in longest-prefix matching.
      continue;
    }
    if (!pathMatches(rule.path, path)) {
      continue;
    }
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === null ? null : { allow: best.allow, path: best.path };
}

/** Match a `robots.txt` rule path (supporting `*` wildcard and `$` anchor) against a request path. */
function pathMatches(rulePath: string, requestPath: string): boolean {
  if (!rulePath.includes('*') && !rulePath.endsWith('$')) {
    return requestPath.startsWith(rulePath);
  }
  const regex = robotsPatternToRegExp(rulePath);
  return regex.test(requestPath);
}

/** Convert a `robots.txt` path pattern (`*` wildcard, trailing `$` anchor) to a RegExp. */
function robotsPatternToRegExp(pattern: string): RegExp {
  let anchored = false;
  let body = pattern;
  if (body.endsWith('$')) {
    anchored = true;
    body = body.slice(0, -1);
  }
  const escaped = body
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/** Strip an inline `#` comment from a `robots.txt` line. */
function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

/** Ensure each agent in `agents` has an entry in `groups`. */
function ensureGroups(groups: Map<string, RobotsRule[]>, agents: string[]): void {
  for (const a of agents) {
    if (!groups.has(a)) {
      groups.set(a, []);
    }
  }
}

/**
 * Select the rules for the most specific matching agent: an exact substring
 * match on the configured agent, else the `*` group, else empty.
 */
function selectAgentRules(groups: Map<string, RobotsRule[]>, agent: string): RobotsRule[] {
  let bestKey: string | null = null;
  for (const key of groups.keys()) {
    if (key === WILDCARD_AGENT) {
      continue;
    }
    if (agent.includes(key) && (bestKey === null || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  if (bestKey !== null) {
    return groups.get(bestKey) ?? [];
  }
  return groups.get(WILDCARD_AGENT) ?? [];
}
