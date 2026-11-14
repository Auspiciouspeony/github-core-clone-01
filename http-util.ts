// http-util.ts — the tiny request/response plumbing every surface shares.

import { randomBytes } from 'node:crypto';

export interface Req {
  method: string;
  /** Decoded pathname segments, e.g. ['api','v3','repos','adaiversen','x']. */
  segments: string[];
  /** The raw pathname (decoded, leading slash). */
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>; // lower-cased names
  body: Buffer;
  host: string;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string | null;
}

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
const requestPrefix = randomBytes(4).toString('hex');

/** A unique-enough per-request id without a crypto call on every request. */
export function requestId(): string {
  requestCounter += 1;
  return `${requestPrefix}-${requestCounter.toString(36)}`;
}

let cachedIso = '';
let cachedSecond = -1;

/** An ISO timestamp, recomputed at most once per second (timestamps are not checked for exactness). */
export function isoNow(): string {
  const second = Math.floor(Date.now() / 1000);
  if (second !== cachedSecond) {
    cachedSecond = second;
    cachedIso = new Date(second * 1000).toISOString();
  }
  return cachedIso;
}

export function jsonReply(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Reply {
  const text = `${JSON.stringify(body)}\n`;
  return {
    status,
    headers: { 'content-type': JSON_TYPE, ...extraHeaders },
    body: text,
  };
}

export function errorReply(status: number, message: string, extraHeaders: Record<string, string> = {}): Reply {
  return jsonReply(status, { message }, extraHeaders);
}

/** Parse a request body as JSON. Returns {ok:false} with the reply to send on malformed input. */
export function parseJsonBody(req: Req): { ok: true; value: unknown } | { ok: false; reply: Reply } {
  const text = req.body.toString('utf8').trim();
  if (text === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reply: errorReply(400, 'Bad request: malformed JSON') };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Split a repo-relative path into segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((part) => part !== '');
}
