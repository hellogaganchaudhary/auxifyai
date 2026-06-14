/**
 * Deep Research — a multi-step, web-grounded research orchestrator.
 *
 * This is the platform's answer to "GPT deep research": given a question, it
 * (1) asks a model to plan a set of focused search queries, (2) runs them
 * through the web-search provider rotation, (3) scrapes the most relevant
 * results for real page content, and (4) feeds those numbered sources back to a
 * model to synthesize a comprehensive, inline-cited Markdown report.
 *
 * Progress is streamed as server-sent events so the UI can show the live plan,
 * each source as it's found, and the report as it's written — ending with a
 * completion event carrying the full report Markdown and the source list (so it
 * can be turned into a downloadable file).
 */

import type { ChatChunk, ChatRequest } from '@auxify/types';

import type { ProviderRotationService } from '../modules/search/provider-rotation.service';
import type { SearchResultItem } from '../modules/search/providers/types';

/** Bound a provider call so one slow backend cannot stall the whole research run. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One SSE frame emitted by the orchestrator. */
export interface ResearchEvent {
  /** The SSE event name (`step`, `source`, `token`, `completion`, `error`). */
  event: string;
  /** The JSON-encoded payload. */
  data: string;
}

/** A resolved source used in the report. */
export interface ResearchSource {
  /** 1-based citation index. */
  index: number;
  /** Page title. */
  title: string;
  /** Resolvable URL. */
  url: string;
  /** Short snippet/summary. */
  snippet: string;
}

/** Input to a deep-research run. */
export interface DeepResearchInput {
  /** The research question. */
  query: string;
  /** The model id used for planning + synthesis. */
  modelId: string;
  /** Maximum number of sources to scrape and cite (default 8; exhaustive: 12). */
  maxSources?: number;
  /**
   * Max OUTPUT tokens for the report. Standard mode caps at 32,000 (one model
   * call); exhaustive mode batches section-by-section up to 100,000 (one lakh).
   */
  maxTokens?: number;
  /**
   * Report depth. `standard` (default) writes the report in a single streamed
   * model call. `exhaustive` ("very deep") plans an outline and writes each
   * section in its own batched call, so one request can produce a 50,000–
   * 100,000+ character report no single call could generate.
   */
  depth?: 'standard' | 'exhaustive';
}

/** The collaborators the orchestrator needs. */
export interface DeepResearchDeps {
  /** The web-search provider rotation. */
  search: ProviderRotationService;
  /** Stream a chat completion for a request (the composition resolves the provider). */
  runChat: (req: ChatRequest) => AsyncIterable<ChatChunk>;
}

/** Encode an object as an SSE frame. */
function ev(event: string, data: unknown): ResearchEvent {
  return { event, data: JSON.stringify(data) };
}

/** Accumulated token usage across all LLM calls in a research run. */
interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
}

/** Collect a full (non-streamed) completion from the chat stream. */
async function complete(
  runChat: DeepResearchDeps['runChat'],
  req: ChatRequest,
  usage?: UsageAccumulator,
): Promise<string> {
  let out = '';
  for await (const chunk of runChat(req)) {
    if (chunk.delta.length > 0) out += chunk.delta;
    if (chunk.usage !== undefined && usage !== undefined) {
      usage.inputTokens += chunk.usage.inputTokens;
      usage.outputTokens += chunk.usage.outputTokens;
    }
  }
  return out.trim();
}

/** Pull the first JSON object out of a model response (handles ```json fences). */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Strip ugly inline citation markers — `[1]`, `[1, 2]`, `[1][3]`, `[Source 2]`
 * — from report prose, while preserving Markdown links `[label](url)` and
 * reference-style definitions `[1]: url`. Tidies whitespace left behind.
 */
function stripCitationMarkers(markdown: string): string {
  return markdown
    .replace(/\[\s*(?:source\s*)?\d+(?:\s*[,&\u2013-]\s*(?:source\s*)?\d+)*\s*\](?!\()(?!:)/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1');
}

/** Plan focused search queries (and a rough outline) for the question. */
async function planQueries(
  deps: DeepResearchDeps,
  input: DeepResearchInput,
  usage?: UsageAccumulator,
): Promise<string[]> {
  const planReq: ChatRequest = {
    modelId: input.modelId,
    systemPrompt:
      'You are a research planner. Given a question, produce a JSON object with a ' +
      '`queries` array of 4-6 focused, diverse web-search queries that together ' +
      'cover the topic. Return ONLY JSON, no prose. Shape: {"queries": string[]}.',
    messages: [{ role: 'user', content: input.query }],
    maxTokens: 400,
    temperature: 0.2,
  };
  const raw = await complete(deps.runChat, planReq, usage);
  const parsed = extractJson(raw) as { queries?: unknown } | undefined;
  const queries = Array.isArray(parsed?.queries)
    ? parsed.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    : [];
  // Always include the original question; de-duplicate; cap at 6.
  const all = [input.query, ...queries];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const q of all) {
    const key = q.trim().toLowerCase();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      unique.push(q.trim());
    }
  }
  return unique.slice(0, 8);
}

/** Result from gatherResults: items plus any errors for diagnostics. */
interface GatherOutcome {
  items: SearchResultItem[];
  errors: string[];
}

/** Run all planned queries (in PARALLEL) and collect de-duplicated results. */
async function gatherResults(
  deps: DeepResearchDeps,
  queries: string[],
  perQuery: number,
): Promise<GatherOutcome> {
  const byUrl = new Map<string, SearchResultItem>();
  const errors: string[] = [];
  // Run every query concurrently so total search time is bounded by the
  // slowest single query, not the sum of all of them.
  // Timeout is 30s — the rotation service may try multiple providers
  // sequentially (9s each), so 12s is too tight for multi-provider fallback.
  const responses = await Promise.all(
    queries.map(async (query) => {
      try {
        return await withTimeout(
          deps.search.search({ query, maxResults: perQuery }),
          30_000,
          `search for "${query}"`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`[${query.slice(0, 60)}]: ${msg}`);
        process.stderr.write(`[deep-research] search failed for "${query}": ${msg}\n`);
        return null;
      }
    }),
  );
  for (const response of responses) {
    if (response === null) continue;
    for (const item of response.results) {
      if (item.url && !byUrl.has(item.url)) {
        byUrl.set(item.url, item);
      }
    }
  }
  return { items: [...byUrl.values()], errors };
}

/** Best-effort scrape of a URL's main content, capped for token safety. */
async function scrapeContent(deps: DeepResearchDeps, url: string): Promise<string> {
  try {
    const response = await withTimeout(
      deps.search.scrape({ url }),
      10_000,
      `read ${url}`,
    );
    return response.content.slice(0, 16_000);
  } catch {
    return '';
  }
}

/** A concise title derived from the research question. */
function titleFor(query: string): string {
  const q = query.trim().replace(/\s+/g, ' ');
  return q.length > 90 ? `${q.slice(0, 90)}…` : q;
}

/**
 * Plan a detailed section outline (12–22 non-overlapping headings) for an
 * exhaustive report, so the report can be written section-by-section across
 * multiple batched model calls within a single request.
 */
async function planOutline(
  deps: DeepResearchDeps,
  input: DeepResearchInput,
  corpus: string,
  usage?: UsageAccumulator,
): Promise<string[]> {
  const req: ChatRequest = {
    modelId: input.modelId,
    systemPrompt:
      'You are a research editor. Design the outline for an exhaustive, book-length report ' +
      'that fully answers the question using the provided sources. Return ONLY JSON of the ' +
      'shape {"sections": string[]} with 12 to 22 specific, non-overlapping section headings ' +
      '(plain text, no numbering or "#"). Include background/context, many detailed ' +
      'thematic sections, comparison/trade-offs, implementation/how-it-works, real-world ' +
      'examples/case studies, implications/recommendations, risks/limitations, future ' +
      'outlook, and a conclusion.',
    messages: [
      {
        role: 'user',
        content: `# Question\n${input.query}\n\n# Source excerpts\n${corpus.slice(0, 8_000)}\n\nReturn the outline JSON now.`,
      },
    ],
    maxTokens: 1_000,
    temperature: 0.3,
  };
  try {
    const raw = await complete(deps.runChat, req, usage);
    const parsed = extractJson(raw) as { sections?: unknown } | undefined;
    const sections = Array.isArray(parsed?.sections)
      ? parsed.sections.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [];
    const cleaned = sections
      .map((s) => s.replace(/^#+\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter((s) => s.length > 0)
      .slice(0, 24);
    if (cleaned.length >= 4) return cleaned;
  } catch {
    // Fall through to the default outline below.
  }
  return [
    'Executive Summary',
    'Background & Context',
    'Key Concepts & Definitions',
    'Key Findings',
    'Detailed Analysis',
    'How It Works',
    'Comparative Analysis & Trade-offs',
    'Real-World Examples & Case Studies',
    'Implications & Recommendations',
    'Risks, Limitations & Open Questions',
    'Future Outlook',
    'Conclusion',
  ];
}

/**
 * Run a deep-research session, yielding SSE frames for the live plan, each
 * source, the streamed report, and a final completion (report + sources).
 */
export async function* runDeepResearch(
  input: DeepResearchInput,
  deps: DeepResearchDeps,
): AsyncIterable<ResearchEvent> {
  const exhaustive = input.depth === 'exhaustive';
  const maxSources = exhaustive
    ? Math.max(input.maxSources ?? 12, 4)
    : Math.max(input.maxSources ?? 8, 2);
  // Output budget: standard caps at 32k tokens (single call); the exhaustive
  // "very deep" mode batches section-by-section with no hard ceiling.
  const tokenBudget = exhaustive
    ? Math.max(input.maxTokens ?? 100_000, 16_000)
    : Math.max(input.maxTokens ?? 16_000, 4_000);

  const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0 };

  if (!deps.search.hasAny()) {
    yield ev('error', {
      message:
        'Deep research needs at least one web-search provider. Set SERPER_API_KEY, ' +
        'TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, EXA_API_KEY, or FIRECRAWL_API_KEY.',
    });
    return;
  }

  // 1) Plan.
  yield ev('step', { phase: 'planning', message: 'Planning research queries…' });
  const queries = await planQueries(deps, input, usage);
  yield ev('step', { phase: 'planned', message: `Planned ${queries.length} queries.`, queries, total: queries.length });

  // 2) Search.
  yield ev('step', { phase: 'searching', message: 'Searching the web…' });
  let { items: results, errors: searchErrors } = await gatherResults(deps, queries, 6);

  // Retry with just the raw query if all planned queries failed (the query
  // planner might have produced queries that tripped provider filters).
  if (results.length === 0 && queries.length > 1) {
    yield ev('step', { phase: 'searching', message: 'Retrying with original query…' });
    const retry = await gatherResults(deps, [input.query], 10);
    results = retry.items;
    if (retry.errors.length > 0) searchErrors = [...searchErrors, ...retry.errors];
  }

  if (results.length === 0) {
    const detail = searchErrors.length > 0
      ? ` Provider errors: ${searchErrors.join(' | ')}`
      : ' All queries returned empty results.';
    yield ev('error', {
      message: `Web search returned no results.${detail}`,
      errors: searchErrors,
    });
    return;
  }
  yield ev('step', { phase: 'searched', message: `Found ${results.length} candidate sources.`, found: results.length });

  // 3) Scrape the top sources for real content — in PARALLEL so a large source
  // set stays fast (sequential scraping is the main latency cost).
  const top = results.slice(0, maxSources);
  const sources: ResearchSource[] = top.map((item, i) => ({
    index: i + 1,
    title: item.title || item.url,
    url: item.url,
    snippet: item.snippet ?? '',
  }));
  for (const source of sources) {
    yield ev('source', source);
  }
  yield ev('step', { phase: 'reading', message: `Reading ${top.length} sources…`, total: top.length });
  const bodies = await Promise.all(
    top.map(async (item) => {
      const content = await scrapeContent(deps, item.url);
      return content.length > 0 ? content : item.snippet ?? '';
    }),
  );
  yield ev('step', { phase: 'read', message: `Read ${top.length} sources. Synthesizing…`, total: top.length });

  // Build a token-bounded corpus for the model (each source body capped so the
  // exhaustive mode can re-send it across many section calls without blowing
  // the input context window).
  const perSourceCap = exhaustive ? 4_000 : 16_000;
  const corpusText = sources
    .map(
      (source, i) =>
        `### Source [${source.index}] ${source.title}\nURL: ${source.url}\n\n${(bodies[i] ?? '').slice(0, perSourceCap)}`,
    )
    .join('\n\n---\n\n')
    .slice(0, exhaustive ? 90_000 : 120_000);

  // 4) Synthesize the report. Standard = one streamed call. Exhaustive = write
  // it section-by-section across multiple batched calls (single request) so the
  // total can reach ~100k tokens / 100k+ characters no single call could emit.
  let report = '';

  if (exhaustive) {
    yield ev('step', { phase: 'outlining', message: 'Designing the report outline…' });
    const outline = await planOutline(deps, input, corpusText, usage);
    yield ev('step', {
      phase: 'outlined',
      message: `Outline ready — ${outline.length} sections. Writing in batches…`,
      sections: outline,
      total: outline.length,
    });

    const head = `# ${titleFor(input.query)}\n\n`;
    report = head;
    yield ev('token', { delta: head });

    let usedTokens = 0;
    let failedSections = 0;
    const perSection = 8_000;
    for (let i = 0; i < outline.length; i++) {
      if (usedTokens >= tokenBudget) break;
      const heading = outline[i]!;
      yield ev('step', {
        phase: 'writing',
        message: `Writing section ${i + 1}/${outline.length}: ${heading}`,
        current: i + 1,
        total: outline.length,
        heading,
        chars: report.length,
      });
      const sectionReq: ChatRequest = {
        modelId: input.modelId,
        systemPrompt:
          'You are a world-class research analyst writing ONE section of a long, exhaustive, ' +
          'publication-grade report. Write ONLY the requested section, in maximum depth and ' +
          'length, using rich Markdown (subheadings, bullet lists, and tables where useful). ' +
          'Ground every claim ONLY in the provided sources, but write clean, flowing prose — ' +
          'do NOT insert inline citation markers such as "[1]", "[1, 2]", or "[Source 3]" ' +
          'anywhere in the text. Do NOT write other sections, a document title, or a Sources ' +
          'list, and do not repeat content from earlier sections. Be thorough, specific, and long.',
        messages: [
          {
            role: 'user',
            content:
              `# Research question\n${input.query}\n\n` +
              `# Full outline\n${outline.map((s, j) => `${j + 1}. ${s}`).join('\n')}\n\n` +
              `# Sections already written\n${
                outline.slice(0, i).map((s) => `- ${s}`).join('\n') || '(none yet)'
              }\n\n` +
              `# Sources\n${corpusText}\n\n` +
              `Write the section now. Begin with the Markdown heading "## ${heading}" and then ` +
              `write its full, in-depth body.`,
          },
        ],
        maxTokens: Math.min(perSection, tokenBudget - usedTokens),
        temperature: 0.45,
      };

      // Resilient per-section generation: a single section that throws (e.g. a
      // transient provider throttle on a long Opus run) must NOT abort the whole
      // report. Retry up to 3 attempts, then skip the section and continue so a
      // ~100k-token report can complete even if a batch fails midway.
      let sectionText = '';
      let sectionOk = false;
      for (let attempt = 1; attempt <= 3 && !sectionOk; attempt++) {
        // On a retry, drop any partial text emitted by the failed attempt.
        if (attempt > 1 && sectionText.length > 0) {
          report = report.slice(0, report.length - sectionText.length);
        }
        sectionText = '';
        try {
          for await (const chunk of deps.runChat(sectionReq)) {
            if (chunk.delta.length > 0) {
              sectionText += chunk.delta;
              report += chunk.delta;
              yield ev('token', { delta: chunk.delta });
            }
            if (chunk.usage !== undefined) {
              usage.inputTokens += chunk.usage.inputTokens;
              usage.outputTokens += chunk.usage.outputTokens;
            }
          }
          sectionOk = true;
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'section failed';
          if (attempt < 3) {
            yield ev('step', {
              phase: 'retry',
              message: `Section ${i + 1} hiccupped (${msg}). Retrying (${attempt}/2)…`,
              current: i + 1,
              total: outline.length,
            });
            // Small backoff so a transient throttle clears.
            await new Promise((r) => setTimeout(r, 1500 * attempt));
          } else {
            // Give up on THIS section only; keep the rest of the report going.
            failedSections += 1;
            if (sectionText.length > 0) {
              report = report.slice(0, report.length - sectionText.length);
              sectionText = '';
            }
            yield ev('step', {
              phase: 'skipped',
              message: `Skipped section ${i + 1} after retries (${msg}). Continuing…`,
              current: i + 1,
              total: outline.length,
            });
          }
        }
      }

      if (!report.endsWith('\n')) {
        report += '\n\n';
        yield ev('token', { delta: '\n\n' });
      }
      usedTokens += Math.ceil(sectionText.length / 4);
      const words = report.split(/\s+/).filter(Boolean).length;
      yield ev('step', {
        phase: 'progress',
        message: `Drafted ${i + 1}/${outline.length} sections · ~${Math.round(
          usedTokens / 1000,
        )}k tokens · ${report.length.toLocaleString('en-US')} chars`,
        current: i + 1,
        total: outline.length,
        chars: report.length,
        words,
        tokens: usedTokens,
      });
    }
    if (failedSections > 0) {
      yield ev('step', {
        phase: 'progress',
        message: `Completed with ${failedSections} section(s) skipped after retries.`,
      });
    }
  } else {
    yield ev('step', { phase: 'synthesizing', message: 'Synthesizing the report…' });
    const synthReq: ChatRequest = {
      modelId: input.modelId,
      systemPrompt:
        'You are a world-class research analyst writing an exhaustive, publication-grade ' +
        'report. Using ONLY the numbered sources provided, write the LONGEST, most thorough ' +
        'and detailed Markdown report the material can support — aim for a comprehensive, ' +
        'multi-page analysis, not a summary. Never truncate early or be brief.\n\n' +
        'Required structure (use rich Markdown — headings, subheadings, bullet lists, and ' +
        'tables where useful):\n' +
        '1. # Title\n' +
        '2. ## Executive Summary (a full, multi-paragraph overview)\n' +
        '3. ## Background & Context\n' +
        '4. ## Detailed Findings — one ### subsection per major theme, each developed in ' +
        'depth with explanation, evidence, examples, figures, and nuance\n' +
        '5. ## Comparative Analysis / Trade-offs (use a table when it helps)\n' +
        '6. ## Implications & Recommendations\n' +
        '7. ## Limitations & Open Questions\n' +
        '8. ## Conclusion\n' +
        "9. ## Sources — list every source as a plain Markdown bullet: `- Title — URL`\n\n" +
        'Write clean, flowing prose: do NOT insert inline citation markers such as "[1]", ' +
        '"[1, 2]", or "[Source 3]" anywhere in the body — references belong ONLY in the final ' +
        'Sources section as plain bullets. Expand every section as far as the sources allow; ' +
        'prefer depth and completeness over brevity. Do not invent facts or sources beyond ' +
        'those given, but fully synthesize, compare, and interpret what the sources contain.',
      messages: [
        {
          role: 'user',
          content:
            `# Research question\n${input.query}\n\n# Sources\n${corpusText}\n\n` +
            'Write the complete, in-depth, maximum-length report now. Develop every section ' +
            'fully and keep writing until the analysis is genuinely exhaustive.',
        },
      ],
      maxTokens: tokenBudget,
      temperature: 0.4,
    };

    try {
      for await (const chunk of deps.runChat(synthReq)) {
        if (chunk.delta.length > 0) {
          report += chunk.delta;
          yield ev('token', { delta: chunk.delta });
        }
        if (chunk.usage !== undefined) {
          usage.inputTokens += chunk.usage.inputTokens;
          usage.outputTokens += chunk.usage.outputTokens;
        }
      }
    } catch (error) {
      yield ev('error', {
        message: error instanceof Error ? error.message : 'synthesis failed',
        usage,
      });
      return;
    }
  }

  // Remove any inline citation markers the model may still have emitted, so the
  // final report reads as clean prose (references live only in Sources).
  report = stripCitationMarkers(report);

  // Ensure a Sources section exists even if the model omitted it.
  if (!/##\s*sources/i.test(report)) {
    const list = sources.map((s) => `- ${s.title} — ${s.url}`).join('\n');
    const block = `\n\n## Sources\n${list}\n`;
    report += block;
    yield ev('token', { delta: block });
  }

  yield ev('completion', { report, sources, queries, usage });
}
