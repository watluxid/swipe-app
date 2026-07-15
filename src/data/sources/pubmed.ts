/**
 * PubMed-backed FeedSource for nephrology (plus palliative care in the
 * nephrology context).
 *
 * ── Where this runs ────────────────────────────────────────────────────────
 * SERVER-SIDE ONLY. It calls the NCBI E-utilities API (and optionally the
 * Anthropic API), so it must never ship to the browser. Wire it in behind the
 * app's `getFeedItems()` in one of two shapes:
 *
 *   1. As a scheduled job that writes the results to feed.json (or a DB), which
 *      the client-facing adapter then serves — closest to the current fixture
 *      setup, and keeps the client a static site.
 *   2. As the implementation behind a `/api/feed` endpoint that the client's
 *      remote FeedSource fetches.
 *
 * Either way the client stays source-agnostic: it only ever sees FeedItem[].
 *
 * ── What it does ───────────────────────────────────────────────────────────
 *   esearch  → PMIDs for nephrology MeSH/keyword terms, last N days
 *   dedupe   → drop PMIDs already in the caller's "seen" set (before any
 *              summary work)
 *   esummary → title, journal, publication date
 *   efetch   → abstract text + MeSH headings (for tags)
 *   summarize → 1–2 sentence summary of the conclusion
 *   → returns FeedItem[] in the app's exact schema.
 *
 * ── Summaries: no gen-AI by default ────────────────────────────────────────
 * The default summarizer is *extractive* and deterministic — it runs locally
 * with no model inference (see `extractiveSummarizer`). An opt-in LLM
 * paraphrase is available via `createLlmSummarizer()`. Either can be wrapped
 * in a `SummaryCache` keyed by PMID so any given paper is summarized once,
 * ever — a PMID's abstract never changes, so re-running the job re-uses cached
 * summaries instead of recomputing them.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import type { FeedItem } from "../../types";
import type { FeedSource } from "../adapter";
import pinnedFixture from "../fixtures/pinned.json";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

/**
 * Config, all from the environment so no secrets live in source.
 *   NCBI_API_KEY  — optional; raises the NCBI rate limit from 3 to 10 req/s.
 *   NCBI_TOOL / NCBI_EMAIL — NCBI etiquette: identify the app so they can
 *                            contact you before blocking, rather than after.
 *   ANTHROPIC_API_KEY — used by the SDK for summarization.
 */
interface PubMedConfig {
  apiKey?: string;
  tool: string;
  email?: string;
  /** Look-back window in days. */
  sinceDays: number;
  /** Hard cap on PMIDs pulled per run — bounds NCBI (and any LLM) spend. */
  maxItems: number;
  /** How many summaries to generate concurrently. */
  summaryConcurrency: number;
}

function loadConfig(overrides: Partial<PubMedConfig> = {}): PubMedConfig {
  const defaults: PubMedConfig = {
    apiKey: process.env.NCBI_API_KEY,
    tool: process.env.NCBI_TOOL ?? "swipe-reader-nephrology",
    email: process.env.NCBI_EMAIL,
    sinceDays: 30,
    maxItems: 40,
    summaryConcurrency: 3,
  };
  // Spreading `overrides` directly would let an explicit `{ sinceDays:
  // undefined }` (e.g. from a caller that only sets one option) clobber the
  // default — object spread overwrites on key *presence*, not value. Drop
  // undefined entries first so only genuine overrides apply.
  const provided = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return { ...defaults, ...provided };
}

/**
 * The topic query. Two blocks OR'd together:
 *   1. nephrology subtopics (MeSH major topics), and
 *   2. palliative/end-of-life care intersected with a kidney context,
 *      so we catch palliative-care papers that are *about* nephrology
 *      without dragging in all of palliative care.
 *
 * The 30-day window is applied via esearch's reldate/datetype params, not
 * baked into this string, so the window is easy to change in one place.
 */
function buildTopicQuery(): string {
  const nephrologySubtopics = [
    "Renal Insufficiency, Chronic",
    "Acute Kidney Injury",
    "Diabetic Nephropathies",
    "Glomerulonephritis",
    "Glomerulonephritis, IGA",
    "Nephrotic Syndrome",
    "Nephritis",
    "Polycystic Kidney Diseases",
    "Kidney Failure, Chronic",
    "Renal Dialysis",
    "Kidney Transplantation",
    "Hypertension, Renal",
    "Chronic Kidney Disease-Mineral and Bone Disorder",
    "Glomerular Filtration Rate",
    "Nephrology",
  ];

  const nephrologyBlock = nephrologySubtopics
    .map((term) => `"${term}"[MeSH Major Topic]`)
    .join(" OR ");

  // Palliative care AND a nephrology context.
  const palliativeBlock =
    '("Palliative Care"[MeSH Terms] OR "Hospice Care"[MeSH Terms] OR ' +
    '"Terminal Care"[MeSH Terms] OR "Advance Care Planning"[MeSH Terms]) ' +
    'AND ("Renal Insufficiency, Chronic"[MeSH Terms] OR ' +
    '"Kidney Failure, Chronic"[MeSH Terms] OR "Renal Dialysis"[MeSH Terms] OR ' +
    "kidney[Title/Abstract] OR renal[Title/Abstract] OR " +
    "dialysis[Title/Abstract] OR nephrology[Title/Abstract])";

  return `(${nephrologyBlock}) OR (${palliativeBlock})`;
}

/**
 * Serializes and rate-limits every NCBI request. NCBI allows 3 req/s without
 * an API key and 10 req/s with one; we serialize and enforce a minimum gap so
 * a single run can never trip their limiter. (A shared queue matters because
 * esearch/esummary/efetch all hit the same host.)
 */
class NcbiClient {
  private readonly minIntervalMs: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: PubMedConfig) {
    // Stay comfortably under the ceiling: ~9/s with a key, ~2.8/s without.
    this.minIntervalMs = cfg.apiKey ? 110 : 350;
  }

  private commonParams(): Record<string, string> {
    const params: Record<string, string> = { tool: this.cfg.tool };
    if (this.cfg.apiKey) params.api_key = this.cfg.apiKey;
    if (this.cfg.email) params.email = this.cfg.email;
    return params;
  }

  /** Queue a GET so calls are spaced by at least minIntervalMs. */
  private schedule<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run);
    // Advance the chain by the throttle interval regardless of success.
    this.chain = result.then(
      () => delay(this.minIntervalMs),
      () => delay(this.minIntervalMs),
    );
    return result;
  }

  async get(endpoint: string, params: Record<string, string>): Promise<string> {
    return this.schedule(async () => {
      const url = new URL(`${EUTILS_BASE}/${endpoint}`);
      for (const [k, v] of Object.entries({ ...this.commonParams(), ...params })) {
        url.searchParams.set(k, v);
      }
      const res = await fetch(url, { headers: { Accept: "*/*" } });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `NCBI ${endpoint} failed: ${res.status} ${res.statusText}\n` +
            `Request: ${url}\n` +
            `Response: ${body.slice(0, 500)}`,
        );
      }
      return res.text();
    });
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** esearch → PMIDs for the topic query within the look-back window. */
async function searchPmids(ncbi: NcbiClient, cfg: PubMedConfig): Promise<string[]> {
  const body = await ncbi.get("esearch.fcgi", {
    db: "pubmed",
    term: buildTopicQuery(),
    retmode: "json",
    retmax: String(cfg.maxItems),
    // Newest first, and restrict to the last N days by publication date.
    sort: "date",
    datetype: "pdat",
    reldate: String(cfg.sinceDays),
  });
  const json = JSON.parse(body) as {
    esearchresult?: { idlist?: string[] };
  };
  return json.esearchresult?.idlist ?? [];
}

interface SummaryMeta {
  pmid: string;
  title: string;
  journal: string;
  /** ISO 8601, best-effort from PubMed's sortpubdate. */
  date: string;
}

/** esummary → title, journal, and a sortable publication date per PMID. */
async function fetchSummaries(
  ncbi: NcbiClient,
  pmids: string[],
): Promise<Map<string, SummaryMeta>> {
  const body = await ncbi.get("esummary.fcgi", {
    db: "pubmed",
    id: pmids.join(","),
    retmode: "json",
  });
  const json = JSON.parse(body) as {
    result?: Record<string, unknown>;
  };
  const result = json.result ?? {};
  const out = new Map<string, SummaryMeta>();
  for (const pmid of pmids) {
    const entry = result[pmid] as
      | { title?: string; fulljournalname?: string; source?: string; sortpubdate?: string; pubdate?: string }
      | undefined;
    if (!entry) continue;
    out.set(pmid, {
      pmid,
      title: (entry.title ?? "").replace(/\.$/, ""),
      journal: entry.fulljournalname ?? entry.source ?? "PubMed",
      date: parsePubDate(entry.sortpubdate ?? entry.pubdate),
    });
  }
  return out;
}

/** PubMed dates look like "2026/07/12 00:00" or "2026 Jul 12". Best-effort ISO. */
function parsePubDate(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();
  const normalized = raw.replace(/\//g, "-").split(" ")[0];
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

interface AbstractRecord {
  pmid: string;
  /** Full abstract text, sections joined. */
  abstract: string;
  /** The conclusion section if the abstract is structured, else "". */
  conclusion: string;
  /** MeSH major-topic descriptors, slugified, for tags. */
  meshTags: string[];
}

/** efetch (XML) → abstract text, conclusion section, and MeSH tags per PMID. */
async function fetchAbstracts(
  ncbi: NcbiClient,
  pmids: string[],
): Promise<Map<string, AbstractRecord>> {
  const xml = await ncbi.get("efetch.fcgi", {
    db: "pubmed",
    id: pmids.join(","),
    rettype: "abstract",
    retmode: "xml",
  });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // fast-xml-parser only decodes numeric character references (the
    // &#x2009;/&#xa0; thin-space/nbsp codes PubMed abstracts are full of)
    // when htmlEntities is set — processEntities alone covers only the 5
    // predefined XML entities (&amp; &lt; &gt; &quot; &apos;).
    htmlEntities: true,
    // Keep AbstractText and MeshHeading as arrays even when singular.
    isArray: (name) => name === "AbstractText" || name === "MeshHeading",
  });
  const doc = parser.parse(xml) as {
    PubmedArticleSet?: { PubmedArticle?: unknown };
  };

  const articles = toArray(doc.PubmedArticleSet?.PubmedArticle);
  const out = new Map<string, AbstractRecord>();

  for (const article of articles) {
    const citation = (article as Record<string, unknown>).MedlineCitation as
      | Record<string, unknown>
      | undefined;
    if (!citation) continue;

    const pmid = String(extractText(citation.PMID));
    const articleNode = citation.Article as Record<string, unknown> | undefined;
    const abstractTexts = toArray(
      (articleNode?.Abstract as Record<string, unknown> | undefined)?.AbstractText,
    );

    let full = "";
    let conclusion = "";
    for (const node of abstractTexts) {
      const text = extractText(node);
      if (!text) continue;
      full += (full ? " " : "") + text;
      const label = String(
        (node as Record<string, unknown>)?.["@_Label"] ?? "",
      ).toUpperCase();
      if (label.includes("CONCLUSION")) {
        conclusion += (conclusion ? " " : "") + text;
      }
    }

    out.set(pmid, {
      pmid,
      abstract: full,
      conclusion,
      meshTags: extractMeshTags(citation.MeshHeadingList),
    });
  }
  return out;
}

function extractMeshTags(meshHeadingList: unknown): string[] {
  const headings = toArray(
    (meshHeadingList as Record<string, unknown> | undefined)?.MeshHeading,
  );
  const tags: string[] = [];
  for (const heading of headings) {
    const descriptor = (heading as Record<string, unknown>).DescriptorName as
      | Record<string, unknown>
      | string
      | undefined;
    if (!descriptor || typeof descriptor === "string") continue;
    // Prefer major topics — the paper's actual focus.
    if (descriptor["@_MajorTopicYN"] !== "Y") continue;
    const name = String(descriptor["#text"] ?? "").toLowerCase();
    if (name) tags.push(slugify(name));
  }
  return tags.slice(0, 4);
}

/**
 * A summarizer turns one article's abstract into the feed's summary text.
 * May be sync (extractive) or async (LLM) — callers `await` the result either
 * way.
 */
export type Summarizer = (
  title: string,
  record: AbstractRecord,
) => string | Promise<string>;

// ── Extractive summarizer (default: no AI, no per-iteration inference) ───────

const MAX_SUMMARY_SENTENCES = 2;
const MAX_SUMMARY_CHARS = 320;

/**
 * Deterministic, local summarizer — the default. No model inference, so no
 * per-iteration power cost.
 *
 *   - Structured abstract: the labeled CONCLUSIONS section is already the
 *     takeaway, so we return its lead sentence(s) verbatim.
 *   - Unstructured abstract: a classic frequency-based extractive pass (Luhn /
 *     LexRank style) scores each sentence by the salience of the content words
 *     it contains, nudged by conclusion cue-words and a mild bias toward the
 *     end of the abstract (where conclusions live), then keeps the top
 *     sentences in reading order.
 *
 * Trade-off vs. the LLM path: this reuses the authors' wording rather than
 * paraphrasing in plain language. For a skim feed of abstracts that's usually
 * fine; switch to `createLlmSummarizer()` where you specifically need the
 * plain-language rewrite.
 */
export const extractiveSummarizer: Summarizer = (_title, record) => {
  const source = (record.conclusion || record.abstract).trim();
  if (!source) return "";

  const sentences = splitSentences(source);
  if (sentences.length <= MAX_SUMMARY_SENTENCES) {
    return clamp(sentences.join(" "));
  }

  // A labeled conclusion is already isolated — its lead is the takeaway.
  if (record.conclusion) {
    return clamp(sentences.slice(0, MAX_SUMMARY_SENTENCES).join(" "));
  }

  // Unstructured: score and pick the most salient sentences.
  const freq = wordFrequencies(source);
  const scored = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: scoreSentence(sentence, freq, index, sentences.length),
  }));
  const top = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUMMARY_SENTENCES)
    .sort((a, b) => a.index - b.index); // back into reading order

  return clamp(top.map((t) => t.sentence).join(" "));
};

const CONCLUSION_CUES = [
  "conclud",
  "suggest",
  "demonstrat",
  "indicat",
  "we found",
  "our findings",
  "in summary",
  "associated with",
  "improve",
  "reduce",
  "increase",
  "no difference",
  "effective",
  "benefit",
  "risk",
];

const STOPWORDS = new Set(
  ("a an and are as at be by for from has have in is it its of on or that the to " +
    "was were will with we our this these those study patients results background " +
    "methods objective aim among between during than which who whom into over under")
    .split(" "),
);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z-]+/g) ?? [];
}

function wordFrequencies(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const word of tokenize(text)) {
    if (STOPWORDS.has(word) || word.length < 3) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  return freq;
}

function scoreSentence(
  sentence: string,
  freq: Map<string, number>,
  index: number,
  total: number,
): number {
  const words = tokenize(sentence);
  if (words.length === 0) return 0;

  let contentScore = 0;
  for (const word of words) {
    if (STOPWORDS.has(word) || word.length < 3) continue;
    contentScore += freq.get(word) ?? 0;
  }
  // Normalize by length so long sentences don't win by volume alone.
  let score = contentScore / Math.sqrt(words.length);

  const lower = sentence.toLowerCase();
  if (CONCLUSION_CUES.some((cue) => lower.includes(cue))) score *= 1.35;

  // Conclusions land at the end: mild recency bonus (0 → 1 across the abstract).
  score *= 1 + 0.25 * (index / Math.max(1, total - 1));

  return score;
}

function splitSentences(text: string): string[] {
  // Protect a few common abstract abbreviations from the naive splitter.
  const guarded = text
    .replace(/\b(vs|e\.g|i\.e|cf|approx|no|fig)\.\s/gi, "$1<DOT> ")
    .replace(/\b([A-Z])\.\s/g, "$1<DOT> "); // single-letter initials
  return guarded
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.replace(/<DOT>/g, ".").trim())
    .filter(Boolean);
}

function clamp(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  const cut = text.slice(0, MAX_SUMMARY_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : MAX_SUMMARY_CHARS).trimEnd()}…`;
}

// ── LLM summarizer (opt-in) ──────────────────────────────────────────────────

const SUMMARY_SYSTEM = `You rewrite the conclusion of a medical abstract as a short, plain-language summary for a nephrology-literate reader skimming a feed.

Rules:
- 1 to 2 sentences. Paraphrase in your own words; never copy phrasing from the abstract.
- State what the study concluded and why it matters clinically — not its methods.
- Write naturally and vary your sentence structure. Do NOT use stock openers like "This study found", "Researchers showed", or "In conclusion".
- Plain language: expand or gloss jargon where a non-specialist would stumble.
- If the abstract lacks a real conclusion, summarize its main finding instead.
- Output only the summary text — no preamble, quotes, or citations.`;

/**
 * Opt-in Claude paraphrase. Construct it only when you actually want the
 * plain-language rewrite; the default path never touches the Anthropic API.
 * Wrap it in a SummaryCache so a given PMID is only ever sent once.
 */
export function createLlmSummarizer(options: {
  client?: Anthropic;
  model?: string;
} = {}): Summarizer {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? "claude-opus-4-8";

  return async (title, record) => {
    const source = record.conclusion || record.abstract;
    if (!source) return "";

    const message = await client.messages.create({
      model,
      max_tokens: 200,
      system: SUMMARY_SYSTEM,
      messages: [
        { role: "user", content: `Title: ${title}\n\nAbstract conclusion:\n${source}` },
      ],
    });

    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text.trim())
      .join(" ")
      .trim();
  };
}

// ── Summary cache (skip re-summarizing a PMID across runs) ────────────────────

export interface SummaryCache {
  get(pmid: string): string | undefined;
  set(pmid: string, summary: string): void;
}

/**
 * JSON-file-backed cache keyed by PMID. Loaded once on creation; each new
 * summary is written through. Because a PMID's abstract is immutable, a cached
 * summary is valid forever — this is what turns "summarize on every run" into
 * "summarize once, ever", whichever summarizer you use.
 */
export function fileSummaryCache(filePath: string): SummaryCache {
  let store: Record<string, string> = {};
  try {
    store = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
  } catch {
    // No cache yet (or unreadable) — start empty.
  }
  return {
    get: (pmid) => store[pmid],
    set: (pmid, summary) => {
      store[pmid] = summary;
      try {
        writeFileSync(filePath, JSON.stringify(store, null, 2));
      } catch {
        // Best-effort persistence; an unwritable cache just means recompute.
      }
    },
  };
}

/** Run an async mapper over items with a fixed concurrency ceiling. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface FetchFeedOptions {
  /**
   * IDs already marked seen (discarded or saved), in the app's id format
   * (`pmid-<PMID>`). Matching articles are dropped before any summary work.
   */
  seenIds?: Set<string>;
  /** Override the look-back window (default 30 days). */
  sinceDays?: number;
  /** Override the per-run item cap (default 40). */
  maxItems?: number;
  /**
   * How to summarize each conclusion. Defaults to the deterministic,
   * inference-free `extractiveSummarizer`. Pass `createLlmSummarizer()` for a
   * plain-language paraphrase.
   */
  summarizer?: Summarizer;
  /**
   * Optional cache so a PMID is summarized once, ever. On a cache hit the
   * summarizer isn't called at all. Use `fileSummaryCache(path)` to persist
   * across runs.
   */
  cache?: SummaryCache;
}

/**
 * The main job. Returns FeedItem[] in the app's exact schema, ready to serve
 * or persist. Articles the caller has already seen are skipped up front, and
 * cached PMIDs skip summarization entirely — so a daily run does no
 * redundant summary work.
 */
export async function fetchNephrologyFeed(
  options: FetchFeedOptions = {},
): Promise<FeedItem[]> {
  const cfg = loadConfig({
    sinceDays: options.sinceDays,
    maxItems: options.maxItems,
  });
  const seen = options.seenIds ?? new Set<string>();
  const summarize = options.summarizer ?? extractiveSummarizer;
  const cache = options.cache;
  const ncbi = new NcbiClient(cfg);

  // 1. Search, then dedupe against the seen set before spending anything.
  const allPmids = await searchPmids(ncbi, cfg);
  const pmids = allPmids.filter((pmid) => !seen.has(`pmid-${pmid}`));
  if (pmids.length === 0) return [];

  // 2. Metadata + abstracts (two batched NCBI calls).
  const [meta, abstracts] = await Promise.all([
    fetchSummaries(ncbi, pmids),
    fetchAbstracts(ncbi, pmids),
  ]);

  // 3. Summarize new abstracts under a concurrency ceiling. A cached PMID
  //    skips the summarizer entirely.
  const items = await mapWithConcurrency(pmids, cfg.summaryConcurrency, async (pmid) => {
    const m = meta.get(pmid);
    const a = abstracts.get(pmid);
    if (!m || !a || !a.abstract) return null;

    let summary = cache?.get(pmid);
    if (summary === undefined) {
      summary = await summarize(m.title, a);
      if (summary && cache) cache.set(pmid, summary);
    }
    if (!summary) return null;

    const year = m.date.slice(0, 4);
    const item: FeedItem = {
      id: `pmid-${pmid}`,
      title: m.title,
      subtitle: `${m.journal} · ${year}`,
      summary,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      tags: a.meshTags.length > 0 ? a.meshTags : ["nephrology"],
      date: m.date,
      pinned: false,
    };
    return item;
  });

  return items.filter((item): item is FeedItem => item !== null);
}

// ── XML helpers ─────────────────────────────────────────────────────────────

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * fast-xml-parser yields a string for a bare element, or an object with
 * `#text` (plus attributes) for an element that has attributes or mixed
 * content. Pull the text out of either shape.
 */
function extractText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object") {
    const text = (node as Record<string, unknown>)["#text"];
    return text == null ? "" : String(text);
  }
  return "";
}

function slugify(value: string): string {
  return value
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * The FeedSource this whole module exists to provide. Drop it in as
 * `activeSource` in adapter.ts on the server side and the app is fed live
 * PubMed data with zero UI changes. Pinned items still come from the static
 * pinned.json (landmark trials), unchanged.
 */
export const pubmedSource: FeedSource = {
  getFeedItems: () => fetchNephrologyFeed(),
  getPinnedItems: async () => pinnedFixture as FeedItem[],
};
