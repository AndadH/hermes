// src/tools/research.ts
//
// Five authoritative free-data tools for deep research queries.
// All are cold tools — reached via discoverTools → executeCode.
// None require secrets except FRED (free key, optional).
//
//   openAlex    — broad academic search: papers, authors, concepts, institutions
//   arxiv       — preprint lookup by ID or category; full abstracts; fresh papers
//   wikipedia   — grounding summaries and article search
//   fred        — US macroeconomic time-series (requires FRED_API_KEY)
//   worldBank   — global development indicators, country stats
//
// ── Context window discipline ─────────────────────────────────────────────────
//
// Both openAlex and arxiv support two params that control how much content
// comes back per result:
//
//   brief          (boolean, default false)
//     true  → title + authors + year + id only — use for discovery scans
//     false → full result including abstract/content
//
//   abstractLength (number, default 800)
//     Max characters of abstract/summary to include when brief=false.
//     Use a small value (e.g. 150) for a quick preview across many results,
//     or the full default when you've narrowed to 1-2 papers you care about.
//
// Recommended two-pass pattern:
//   Pass 1 — scan:  brief=true, limit=10  → tiny, just enough to pick winners
//   Pass 2 — read:  brief=false, limit=2, abstractLength=800  → full detail
//
// Wikipedia has an equivalent summaryLength param (default 1200 chars).

import type { Env } from '../types';

// ── Declarations ──────────────────────────────────────────────────────────────

export const researchDeclarations = [

  // ── openAlex ───────────────────────────────────────────────────────────────
  {
    name: 'openAlex',
    description:
      'Search the OpenAlex academic catalog — papers, authors, concepts, institutions. ' +
      'Free, no key needed. Covers arXiv, PubMed, CrossRef and more. ' +
      'Use for broad "find papers about X" queries, author lookups, or concept exploration. ' +
      'Use arxiv instead for preprint ID lookups or very fresh papers.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entity: {
          type: 'STRING',
          description: 'What to search: works | authors | concepts | institutions. Default: works.',
        },
        query: {
          type: 'STRING',
          description: 'Free-text search query.',
        },
        filter: {
          type: 'STRING',
          description:
            'Optional OpenAlex filter string. Multiple filters separated by commas. ' +
            'Year examples: "publication_year:2024" or "publication_year:>2023" for recent work. ' +
            'Other examples: "open_access.is_oa:true", "authorships.author.id:A123". ' +
            'NOTE: Do NOT use | as OR — use a year range like ">2023" or make separate calls instead.',
        },
        limit: {
          type: 'NUMBER',
          description: 'Max results to return. Default 5, max 25.',
        },
        brief: {
          type: 'BOOLEAN',
          description:
            'true = title, authors, year, id only — fast discovery scan, minimal tokens. ' +
            'false (default) = full result including abstract and URL.',
        },
        abstractLength: {
          type: 'NUMBER',
          description:
            'Max characters of abstract to include. Only used when brief=false. Default 800. ' +
            'Use ~150 for a quick preview across many results; 800 when focused on 1-2 papers.',
        },
      },
      required: ['query'],
    },
  },

  // ── arxiv ──────────────────────────────────────────────────────────────────
  {
    name: 'arxiv',
    description:
      'Query the arXiv preprint server. ' +
      'Best for: fetching a paper by arXiv ID (e.g. "2301.07041"), ' +
      'browsing a category (e.g. "cs.LG", "math.ST"), ' +
      'or finding very recent preprints before OpenAlex has indexed them. ' +
      'Returns title, authors, abstract, and arXiv URL.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: {
          type: 'STRING',
          description: 'arXiv paper ID (e.g. "2301.07041"). Takes priority over query.',
        },
        query: {
          type: 'STRING',
          description: 'Free-text or fielded query (ti:, au:, abs:, cat: prefixes supported).',
        },
        category: {
          type: 'STRING',
          description: 'Filter by arXiv category, e.g. "cs.LG", "quant-ph", "math.ST".',
        },
        limit: {
          type: 'NUMBER',
          description: 'Max results. Default 5, max 20.',
        },
        brief: {
          type: 'BOOLEAN',
          description:
            'true = title, authors, published date, id only — fast discovery scan, minimal tokens. ' +
            'false (default) = full result including abstract and PDF link.',
        },
        abstractLength: {
          type: 'NUMBER',
          description:
            'Max characters of abstract to include. Only used when brief=false. Default 800. ' +
            'Use ~150 for a quick preview; 800 when focused on specific papers.',
        },
      },
      required: [],
    },
  },

  // ── wikipedia ──────────────────────────────────────────────────────────────
  {
    name: 'wikipedia',
    description:
      'Search Wikipedia and retrieve article summaries. ' +
      'Use for grounding factual questions, definitions, historical events, ' +
      'notable people, and concepts that have a well-established Wikipedia article. ' +
      'Returns the article intro summary and a URL.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Topic or article title to search for.',
        },
        language: {
          type: 'STRING',
          description: 'Wikipedia language code. Default: "en".',
        },
        summaryLength: {
          type: 'NUMBER',
          description:
            'Max characters of article summary to return. Default 1200. ' +
            'Use ~300 for a one-liner definition; 1200 for the full intro.',
        },
      },
      required: ['query'],
    },
  },

  // ── fred ───────────────────────────────────────────────────────────────────
  {
    name: 'fred',
    description:
      'Fetch US macroeconomic time-series data from the St. Louis Fed (FRED). ' +
      'Use for: inflation (CPIAUCSL), GDP (GDP), unemployment (UNRATE), ' +
      'interest rates (FEDFUNDS), trade, industrial production, and hundreds more series. ' +
      'Returns observations in chronological order. ' +
      'Requires FRED_API_KEY secret — returns an error if not set.',
    parameters: {
      type: 'OBJECT',
      properties: {
        series_id: {
          type: 'STRING',
          description:
            'FRED series ID, e.g. "CPIAUCSL", "GDP", "UNRATE", "FEDFUNDS", "T10Y2Y". ' +
            'Find IDs at fred.stlouisfed.org.',
        },
        observation_start: {
          type: 'STRING',
          description: 'Start date in YYYY-MM-DD format. Defaults to 1 year ago.',
        },
        observation_end: {
          type: 'STRING',
          description: 'End date in YYYY-MM-DD format. Defaults to today.',
        },
        limit: {
          type: 'NUMBER',
          description: 'Max observations to return. Default 24, max 100.',
        },
      },
      required: ['series_id'],
    },
  },

  // ── worldBank ─────────────────────────────────────────────────────────────
  {
    name: 'worldBank',
    description:
      'Fetch global development indicators from the World Bank Open Data API. ' +
      'Use for: GDP per capita, population, literacy rates, CO2 emissions, ' +
      'energy use, poverty headcount, and thousands of other country-level metrics. ' +
      'No key required.',
    parameters: {
      type: 'OBJECT',
      properties: {
        indicator: {
          type: 'STRING',
          description:
            'World Bank indicator code, e.g. "NY.GDP.PCAP.CD" (GDP per capita), ' +
            '"SP.POP.TOTL" (total population), "SE.ADT.LITR.ZS" (literacy rate). ' +
            'Find codes at data.worldbank.org/indicator.',
        },
        country: {
          type: 'STRING',
          description:
            'ISO 3166-1 alpha-2 or alpha-3 country code, e.g. "US", "CN", "DEU". ' +
            'Use "all" for all countries.',
        },
        date_range: {
          type: 'STRING',
          description: 'Year or range, e.g. "2020", "2015:2023". Defaults to last 5 years.',
        },
        limit: {
          type: 'NUMBER',
          description: 'Max data points to return. Default 10, max 50.',
        },
      },
      required: ['indicator'],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultDateRange(yearsBack: number): { start: string; end: string } {
  const end   = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - yearsBack);
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
  };
}

// ── OpenAlex ──────────────────────────────────────────────────────────────────

export async function executeOpenAlex(
  args: Record<string, unknown>,
): Promise<unknown> {
  const entity         = String(args.entity  ?? 'works').toLowerCase().trim();
  const query          = String(args.query   ?? '').trim();
  const filter         = String(args.filter  ?? '').trim();
  const limit          = Math.min(Number(args.limit ?? 5), 25);
  const brief          = args.brief === true || args.brief === 'true';
  const abstractLength = Math.min(Number(args.abstractLength ?? 800), 2000);

  const validEntities = ['works', 'authors', 'concepts', 'institutions'];
  if (!validEntities.includes(entity)) {
    return { error: `Invalid entity "${entity}". Use: ${validEntities.join(', ')}` };
  }
  if (!query && !filter) return { error: 'Provide query or filter' };

  const params = new URLSearchParams();
  if (query)  params.set('search', query);
  if (filter) params.set('filter', filter);
  params.set('per-page', String(limit));
  params.set('mailto', 'hermes-worker@internal');  // polite pool

  // When brief=true skip abstract_inverted_index — significantly reduces response size
  const selectMap: Record<string, string> = {
    works: brief
      ? 'id,title,publication_year,doi,authorships'
      : 'id,title,publication_year,doi,open_access,primary_location,authorships,abstract_inverted_index',
    authors:      'id,display_name,works_count,cited_by_count,last_known_institution',
    concepts:     'id,display_name,level,description,works_count',
    institutions: 'id,display_name,type,country_code,works_count',
  };
  params.set('select', selectMap[entity]);

  const url = `https://api.openalex.org/${entity}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Hermes/1.0' } });
  } catch (err) {
    return { error: `OpenAlex fetch failed: ${String(err)}` };
  }

  if (!res.ok) {
    return { error: `OpenAlex returned HTTP ${res.status}` };
  }

  const json: any = await res.json();
  const results   = json?.results ?? [];

  if (entity === 'works') {
    return {
      total: json?.meta?.count ?? results.length,
      brief,
      results: results.map((w: any) => {
        const base = {
          id:      w.id,
          title:   w.title,
          year:    w.publication_year,
          doi:     w.doi ?? null,
          authors: (w.authorships ?? []).slice(0, 5).map((a: any) => a.author?.display_name),
        };
        if (brief) return base;
        return {
          ...base,
          open_access: w.open_access?.is_oa ?? false,
          url:         w.primary_location?.landing_page_url ?? w.doi ?? null,
          abstract:    reconstructAbstract(w.abstract_inverted_index, abstractLength),
        };
      }),
    };
  }

  // Authors, concepts, institutions — already compact, return as-is
  return { total: json?.meta?.count ?? results.length, results };
}

// OpenAlex stores abstracts as an inverted index: { word: [positions] }
// Reconstruct to a readable string, capped at maxLength characters.
function reconstructAbstract(
  index:     Record<string, number[]> | null | undefined,
  maxLength: number = 800,
): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  const text = words.filter(Boolean).join(' ');
  return text.slice(0, maxLength) || null;
}

// ── arXiv ─────────────────────────────────────────────────────────────────────

export async function executeArxiv(
  args: Record<string, unknown>,
): Promise<unknown> {
  const id             = String(args.id       ?? '').trim();
  const query          = String(args.query    ?? '').trim();
  const category       = String(args.category ?? '').trim();
  const limit          = Math.min(Number(args.limit ?? 5), 20);
  const brief          = args.brief === true || args.brief === 'true';
  const abstractLength = Math.min(Number(args.abstractLength ?? 800), 2000);

  if (!id && !query && !category) {
    return { error: 'Provide at least one of: id, query, category' };
  }

  let searchQuery = '';
  if (id) {
    searchQuery = `id:${id}`;
  } else {
    const parts: string[] = [];
    if (query)    parts.push(query);
    if (category) parts.push(`cat:${category}`);
    searchQuery = parts.join(' AND ');
  }

  const params = new URLSearchParams({
    search_query: searchQuery,
    max_results:  String(limit),
    sortBy:       'submittedDate',
    sortOrder:    'descending',
  });

  const url = `https://export.arxiv.org/api/query?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Hermes/1.0' } });
  } catch (err) {
    return { error: `arXiv fetch failed: ${String(err)}` };
  }

  if (!res.ok) {
    return { error: `arXiv returned HTTP ${res.status}` };
  }

  const xml     = await res.text();
  const entries = parseArxivXml(xml, brief, abstractLength);

  if (!entries.length) {
    return { total: 0, results: [], note: 'No results found.' };
  }

  return { total: entries.length, brief, results: entries };
}

// Minimal Atom feed parser — no external deps.
function parseArxivXml(
  xml:            string,
  brief:          boolean,
  abstractLength: number,
): object[] {
  const entries: object[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry  = match[1];

    const get = (tag: string) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(entry);
      return m ? m[1].trim() : null;
    };
    const getAll = (tag: string) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
      const results: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(entry)) !== null) results.push(m[1].trim());
      return results;
    };

    const rawId   = get('id') ?? '';
    const arxivId = rawId
      .replace('http://arxiv.org/abs/', '')
      .replace('https://arxiv.org/abs/', '');

    const base = {
      id:        arxivId,
      title:     (get('title') ?? '').replace(/\s+/g, ' '),
      authors:   getAll('name').slice(0, 6),
      published: get('published')?.slice(0, 10) ?? null,
      url:       `https://arxiv.org/abs/${arxivId}`,
    };

    if (brief) {
      entries.push(base);
    } else {
      entries.push({
        ...base,
        abstract: (get('summary') ?? '').replace(/\s+/g, ' ').slice(0, abstractLength),
        pdf:      `https://arxiv.org/pdf/${arxivId}`,
      });
    }
  }

  return entries;
}

// ── Wikipedia ─────────────────────────────────────────────────────────────────

export async function executeWikipedia(
  args: Record<string, unknown>,
): Promise<unknown> {
  const query         = String(args.query         ?? '').trim();
  const language      = String(args.language      ?? 'en').trim();
  const summaryLength = Math.min(Number(args.summaryLength ?? 1200), 5000);

  if (!query) return { error: 'query is required' };

  // Step 1: search for the best matching article title
  const searchParams = new URLSearchParams({
    action:   'query',
    list:     'search',
    srsearch: query,
    srlimit:  '3',
    format:   'json',
    origin:   '*',
  });

  const searchUrl = `https://${language}.wikipedia.org/w/api.php?${searchParams}`;

  let searchRes: Response;
  try {
    searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'Hermes/1.0' } });
  } catch (err) {
    return { error: `Wikipedia search failed: ${String(err)}` };
  }

  if (!searchRes.ok) return { error: `Wikipedia returned HTTP ${searchRes.status}` };

  const searchJson: any = await searchRes.json();
  const hits            = searchJson?.query?.search ?? [];

  if (!hits.length) return { results: [], note: 'No Wikipedia articles found.' };

  // Step 2: fetch summary for the top result
  const title      = hits[0].title;
  const summaryUrl = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

  let summaryRes: Response;
  try {
    summaryRes = await fetch(summaryUrl, { headers: { 'User-Agent': 'Hermes/1.0' } });
  } catch (err) {
    return { error: `Wikipedia summary fetch failed: ${String(err)}` };
  }

  if (!summaryRes.ok) return { error: `Wikipedia summary returned HTTP ${summaryRes.status}` };

  const summary: any = await summaryRes.json();

  return {
    title:        summary.title,
    summary:      (summary.extract ?? '').slice(0, summaryLength),
    url:          summary.content_urls?.desktop?.page ?? `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    also_matched: hits.slice(1).map((h: any) => h.title),
  };
}

// ── FRED ──────────────────────────────────────────────────────────────────────

export async function executeFred(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const seriesId = String(args.series_id ?? '').trim().toUpperCase();
  if (!seriesId) return { error: 'series_id is required' };

  const apiKey = (env as unknown as Record<string, string>).FRED_API_KEY;
  if (!apiKey) {
    return {
      error:
        'FRED_API_KEY secret is not set. ' +
        'Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html and run: ' +
        'wrangler secret put FRED_API_KEY',
    };
  }

  const { start, end } = defaultDateRange(1);
  const limit          = Math.min(Number(args.limit ?? 24), 100);

  const params = new URLSearchParams({
    series_id:         seriesId,
    api_key:           apiKey,
    file_type:         'json',
    observation_start: String(args.observation_start ?? start),
    observation_end:   String(args.observation_end   ?? end),
    limit:             String(limit),
    sort_order:        'asc',
  });

  const metaParams = new URLSearchParams({
    series_id: seriesId,
    api_key:   apiKey,
    file_type: 'json',
  });

  let [obsRes, metaRes]: Response[] = [];
  try {
    [obsRes, metaRes] = await Promise.all([
      fetch(`https://api.stlouisfed.org/fred/series/observations?${params}`),
      fetch(`https://api.stlouisfed.org/fred/series?${metaParams}`),
    ]);
  } catch (err) {
    return { error: `FRED fetch failed: ${String(err)}` };
  }

  if (!obsRes.ok)  return { error: `FRED observations returned HTTP ${obsRes.status}` };
  if (!metaRes.ok) return { error: `FRED series metadata returned HTTP ${metaRes.status}` };

  const [obsJson, metaJson]: any[] = await Promise.all([obsRes.json(), metaRes.json()]);

  const series = metaJson?.seriess?.[0];
  const obs    = (obsJson?.observations ?? [])
    .filter((o: any) => o.value !== '.')  // FRED uses '.' for missing values
    .map((o: any) => ({ date: o.date, value: parseFloat(o.value) }));

  return {
    series_id:    seriesId,
    title:        series?.title           ?? seriesId,
    units:        series?.units_short     ?? series?.units ?? '',
    frequency:    series?.frequency_short ?? '',
    updated:      series?.last_updated    ?? null,
    observations: obs,
  };
}

// ── World Bank ────────────────────────────────────────────────────────────────

export async function executeWorldBank(
  args: Record<string, unknown>,
): Promise<unknown> {
  const indicator = String(args.indicator ?? '').trim();
  const country   = String(args.country   ?? 'all').trim();
  const limit     = Math.min(Number(args.limit ?? 10), 50);

  if (!indicator) return { error: 'indicator is required' };

  const currentYear = new Date().getFullYear();
  const dateRange   = String(args.date_range ?? `${currentYear - 5}:${currentYear}`);

  const params = new URLSearchParams({
    format:   'json',
    date:     dateRange,
    per_page: String(limit),
  });

  const url = `https://api.worldbank.org/v2/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(indicator)}?${params}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Hermes/1.0' } });
  } catch (err) {
    return { error: `World Bank fetch failed: ${String(err)}` };
  }

  if (!res.ok) return { error: `World Bank returned HTTP ${res.status}` };

  const json: any = await res.json();

  // World Bank returns [metadata, data] as a two-element array
  if (!Array.isArray(json) || json.length < 2) {
    return { error: 'Unexpected World Bank response format' };
  }

  const meta = json[0];
  const data = json[1] ?? [];

  if (!data.length) {
    return {
      indicator,
      country,
      date_range: dateRange,
      total:      0,
      results:    [],
      note:       'No data found. Check indicator code and country code.',
    };
  }

  const indicatorName = data[0]?.indicator?.value ?? indicator;

  return {
    indicator,
    indicator_name: indicatorName,
    total:   meta?.total ?? data.length,
    results: data
      .filter((d: any) => d.value !== null)
      .map((d: any) => ({
        country: d.country?.value ?? country,
        year:    d.date,
        value:   d.value,
      })),
  };
}