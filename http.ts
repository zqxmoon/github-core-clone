// http.ts — the small request/reply contract between app.ts (the socket) and the surfaces.

export interface Ctx {
  method: string;
  /** The full URL pathname, still percent-encoded. */
  path: string;
  /** Pathname split into decoded segments (no empty entries). */
  segments: string[];
  query: URLSearchParams;
  /** The raw request body decoded as UTF-8 (git handlers read `rawBody` instead). */
  bodyText: string;
  rawBody: Buffer;
  /** The parsed JSON body, or undefined when the body is empty or not JSON. */
  json: unknown;
  /** True when a non-empty body failed JSON parsing. */
  jsonError: boolean;
  /** The bearer <redacted> presented, or null. */
  token: string | null;
  /** The request's Host header, for building absolute Link URLs. */
  host: string;
  /** The Git-Protocol header, when present (git advertisement negotiation). */
  gitProtocol: string | null;
}

export interface Reply {
  status: number;
  /** A JSON-serializable body; undefined means an empty body. */
  body?: unknown;
  /** Raw bytes instead of a JSON body (the git surface). */
  raw?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

export function errorReply(status: number, message: string): Reply {
  return { status, body: { message } };
}

/** An opaque, stable global id for a forge entity (GraphQL's Relay-style id). */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back to its kind and key; null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
