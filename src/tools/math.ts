// src/tools/math.ts
//
// Three-tier math capability for Hermes:
//
//   Tier 1 — executeCode sandbox (JS/Math API)
//            Pure numeric evaluation, unit conversions, statistics.
//            Zero latency, no API call. The agent should reach for this first
//            for anything that is just number-crunching.
//
//   Tier 2 — newtonMath tool (Newton API — newton.now.sh)
//            Symbolic operations: derive, integrate, factor, simplify,
//            find zeroes, tangent lines, area under curve, trig evals.
//            Free, no key required.
//
//   Tier 3 — wolframAlpha tool (Wolfram|Alpha Short Answers API)
//            Full CAS: ODEs, series, transforms, number theory, unit
//            conversions with context, scientific constants, real-world
//            math facts. Requires WOLFRAM_APP_ID secret.

import type { Env } from '../types';

// ── Newton ────────────────────────────────────────────────────────────────────

// All operations supported by the Newton API.
export type NewtonOperation =
  | 'simplify'
  | 'factor'
  | 'derive'
  | 'integrate'
  | 'zeroes'
  | 'tangent'
  | 'area'
  | 'cos'
  | 'sin'
  | 'tan'
  | 'arccos'
  | 'arcsin'
  | 'arctan'
  | 'abs'
  | 'log';

const NEWTON_BASE = 'https://newton.now.sh/api/v2';

export const mathDeclarations = [
  // ── newtonMath ─────────────────────────────────────────────────────────────
  {
    name: 'newtonMath',
    description:
      'Symbolic math via the Newton micro-service. ' +
      'Use for: simplify, factor, derive, integrate, zeroes, tangent, area, cos, sin, tan, ' +
      'arccos, arcsin, arctan, abs, log. ' +
      'Expression must be url-safe (^ is fine, use (over) for fractions). ' +
      'For tangent lines pass "c|f(x)" — e.g. "2|x^3". ' +
      'For area under curve pass "c:d|f(x)" — e.g. "2:4|x^3". ' +
      'Prefer executeCode for pure numeric work; use newtonMath when you need a symbolic result.',
    parameters: {
      type: 'OBJECT',
      properties: {
        operation: {
          type: 'STRING',
          description:
            'One of: simplify | factor | derive | integrate | zeroes | tangent | area | ' +
            'cos | sin | tan | arccos | arcsin | arctan | abs | log',
        },
        expression: {
          type: 'STRING',
          description:
            'The math expression. Use (over) for fractions (e.g. "1(over)2"). ' +
            'For tangent: "c|f(x)". For area: "c:d|f(x)".',
        },
      },
      required: ['operation', 'expression'],
    },
  },

  // ── wolframAlpha ───────────────────────────────────────────────────────────
  {
    name: 'wolframAlpha',
    description:
      'Query Wolfram|Alpha for advanced math and science. ' +
      'Use when Newton or code-mode cannot handle it: ODEs, series expansions, Laplace/Fourier ' +
      'transforms, number theory, matrix operations, statistical distributions, unit conversions ' +
      'with context, physical constants, or any natural-language math question. ' +
      'Returns a concise plain-text answer. ' +
      'Requires WOLFRAM_APP_ID secret — returns an error if it is not set.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description:
            'A natural language or symbolic math query. ' +
            'Examples: "integrate sin(x^2) dx", "eigenvalues of [[1,2],[3,4]]", ' +
            '"500 USD in EUR", "speed of light in cm/s".',
        },
      },
      required: ['query'],
    },
  },
];

// ── Newton executor ───────────────────────────────────────────────────────────

export async function executeNewtonMath(
  args: Record<string, unknown>,
): Promise<unknown> {
  const operation  = String(args.operation  ?? '').trim().toLowerCase();
  const expression = String(args.expression ?? '').trim();

  if (!operation)  return { error: 'operation is required' };
  if (!expression) return { error: 'expression is required' };

  const validOps: NewtonOperation[] = [
    'simplify', 'factor', 'derive', 'integrate', 'zeroes', 'tangent', 'area',
    'cos', 'sin', 'tan', 'arccos', 'arcsin', 'arctan', 'abs', 'log',
  ];

  if (!validOps.includes(operation as NewtonOperation)) {
    return {
      error: `Unknown operation "${operation}". Valid operations: ${validOps.join(', ')}`,
    };
  }

  // Newton expects the expression to be url-encoded.
  // The ^ character is valid in a URL path segment but encode spaces and special chars.
  const encoded = encodeURIComponent(expression);
  const url     = `${NEWTON_BASE}/${operation}/${encoded}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Hermes/1.0' },
    });
  } catch (err) {
    return { error: `Newton fetch failed: ${String(err)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      error: `Newton returned HTTP ${res.status}`,
      detail: body.slice(0, 200),
    };
  }

  let json: { operation: string; expression: string; result: string };
  try {
    json = await res.json();
  } catch {
    return { error: 'Newton returned non-JSON response' };
  }

  return {
    operation:  json.operation,
    expression: json.expression,
    result:     json.result,
  };
}

// ── WolframAlpha executor ─────────────────────────────────────────────────────
export async function executeWolframAlpha(
  args: Record<string, unknown>,
  env: Env,
): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'query is required' };

  const appId = (env as unknown as Record<string, string>).WOLFRAM_APP_ID;
  if (!appId) {
    return {
      error:
        'WOLFRAM_APP_ID secret is not set. ' +
        'Get a free key at https://developer.wolframalpha.com and run: ' +
        'wrangler secret put WOLFRAM_APP_ID',
    };
  }

  const url =
    `https://api.wolframalpha.com/v2/query` +
    `?appid=${encodeURIComponent(appId)}` +
    `&input=${encodeURIComponent(query)}` +
    `&output=JSON` +
    `&format=plaintext` +
    `&podstate=Result__Step-by-step+solution`;  // request step-by-step if available

  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Hermes/1.0' } });
  } catch (err) {
    return { error: `Wolfram|Alpha fetch failed: ${String(err)}` };
  }

  if (!res.ok) {
    return { error: `Wolfram|Alpha returned HTTP ${res.status}` };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    return { error: 'Wolfram|Alpha returned non-JSON response' };
  }

  const queryResult = json?.queryresult;

  if (!queryResult?.success) {
    return {
      error: 'Wolfram|Alpha could not interpret the query. Try rephrasing.',
      query,
      tips: queryResult?.tips?.tip?.map((t: any) => t['@val']) ?? [],
    };
  }

  // Extract all pods with plaintext content — give the agent the full picture
  const pods: { title: string; text: string }[] = [];
  for (const pod of queryResult.pods ?? []) {
    const lines: string[] = [];
    for (const sub of pod.subpods ?? []) {
      const text = sub.plaintext?.trim();
      if (text) lines.push(text);
    }
    if (lines.length) {
      pods.push({ title: pod.title, text: lines.join('\n') });
    }
  }

  if (!pods.length) {
    return { error: 'Wolfram|Alpha returned no readable pods', query };
  }

  return { query, pods };
}