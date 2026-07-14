/**
 * PubMed-backed FeedSource for nephrology (plus palliative care in the
 * nephrology context).
 *
 * ── Where this runs ────────────────────────────────────────────────────────
 * SERVER-SIDE ONLY. It calls the NCBI E-utilities API and the Anthropic API
 * with secret keys, so it must never ship to the browser. Wire it in behind
 * the app's `getFeedItems()` in one of two shapes:
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
 *              expensive summary work)
 *   esummary → title, journal, publication date
 *   efetch   → abstract text + MeSH headings (for tags)
 *   Claude   → a 1–2 sentence plain-language paraphrase of each conclusion
 *   → returns FeedItem[] in the app's exact schema.
 */

import Anthropic from "@anthropic-ai/sdk";
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
  /** Hard cap on PMIDs pulled per run — bounds both NCBI and Anthropic spend. */
  maxItems: number;
  /** Anthropic model for the plain-language summaries. */
  summaryModel: string;
  /** How many summaries to generate concurrently. */
  summaryConcurrency: number;
}

function loadConfig(overrides: Partial<PubMedConfig> = {}): PubMedConfig {
  return {
    apiKey: process.env.NCBI_API_KEY,
    tool: process.env.NCBI_TOOL ?? "swipe-reader-nephrology",
    email: process.env.NCBI_EMAIL,
    sinceDays: 30,
    maxItems: 40,
    summaryModel: "claude-opus-4-8",
    summaryConcurrency: 3,
    ...overrides,
  };
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
        throw new Error(`NCBI ${endpoint} failed: ${res.status} ${res.statusText}`);
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

const SUMMARY_SYSTEM = `You rewrite the conclusion of a medical abstract as a short, plain-language summary for a nephrology-literate reader skimming a feed.

Rules:
- 1 to 2 sentences. Paraphrase in your own words; never copy phrasing from the abstract.
- State what the study concluded and why it matters clinically — not its methods.
- Write naturally and vary your sentence structure. Do NOT use stock openers like "This study found", "Researchers showed", or "In conclusion".
- Plain language: expand or gloss jargon where a non-specialist would stumble.
- If the abstract lacks a real conclusion, summarize its main finding instead.
- Output only the summary text — no preamble, quotes, or citations.`;

/**
 * Generates the plain-language summary for one article. We feed the conclusion
 * when the abstract is structured, else the whole abstract — so the model
 * always has the takeaway, not just background.
 */
async function summarizeConclusion(
  anthropic: Anthropic,
  cfg: PubMedConfig,
  title: string,
  record: AbstractRecord,
): Promise<string> {
  const source = record.conclusion || record.abstract;
  if (!source) return "";

  const message = await anthropic.messages.create({
    model: cfg.summaryModel,
    max_tokens: 200,
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Title: ${title}\n\nAbstract conclusion:\n${source}`,
      },
    ],
  });

  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text.trim())
    .join(" ")
    .trim();
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
}

/**
 * The main job. Returns FeedItem[] in the app's exact schema, ready to serve
 * or persist. Articles the caller has already seen are skipped up front, so a
 * daily run only summarizes genuinely new papers.
 */
export async function fetchNephrologyFeed(
  options: FetchFeedOptions = {},
): Promise<FeedItem[]> {
  const cfg = loadConfig({
    sinceDays: options.sinceDays,
    maxItems: options.maxItems,
  });
  const seen = options.seenIds ?? new Set<string>();
  const ncbi = new NcbiClient(cfg);
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY / ant profile

  // 1. Search, then dedupe against the seen set before spending anything.
  const allPmids = await searchPmids(ncbi, cfg);
  const pmids = allPmids.filter((pmid) => !seen.has(`pmid-${pmid}`));
  if (pmids.length === 0) return [];

  // 2. Metadata + abstracts (two batched NCBI calls).
  const [meta, abstracts] = await Promise.all([
    fetchSummaries(ncbi, pmids),
    fetchAbstracts(ncbi, pmids),
  ]);

  // 3. Summarize new abstracts under a concurrency ceiling.
  const items = await mapWithConcurrency(pmids, cfg.summaryConcurrency, async (pmid) => {
    const m = meta.get(pmid);
    const a = abstracts.get(pmid);
    if (!m || !a || !a.abstract) return null;

    const summary = await summarizeConclusion(anthropic, cfg, m.title, a);
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
