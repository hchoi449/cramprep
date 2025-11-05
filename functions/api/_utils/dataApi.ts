/* Shared helpers for MongoDB Data API access and JWT auth within Cloudflare Pages functions. */

const VALID_ASSIGNMENT_STATUSES = new Set(['todo', 'in-progress', 'completed']);

export type BaseEnv = {
  MONGODB_DATA_API_URL: string;
  MONGODB_DATA_API_KEY: string;
  MONGODB_DATA_SOURCE: string;
  MONGODB_DATABASE: string;
  MONGODB_COLLECTION_ASSIGNMENTS?: string;
  JWT_SECRET: string;
};

export interface AuthPayload {
  sub: string;
  email?: string;
  exp?: number;
  [key: string]: unknown;
}

export interface SerializedAssignment {
  id?: string;
  title: string;
  subject: string;
  status: string;
  dueDate: string | null;
  details: string;
  allDay: boolean;
  timeLabel: string;
  url?: string;
  createdAt: string | null;
  updatedAt: string | null;
  source: string;
  icalId: string | null;
}

export function ensureEnv(env: Partial<BaseEnv>, keys: (keyof BaseEnv)[]): string | null {
  for (const key of keys) {
    if (!env[key]) return String(key);
  }
  return null;
}

export async function dataApiFetch<T>(env: BaseEnv, action: string, body: unknown): Promise<T> {
  const url = `${env.MONGODB_DATA_API_URL.replace(/\/$/, '')}/${action}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.MONGODB_DATA_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Data API ${action} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

function base64UrlToUint8Array(input: string): Uint8Array {
  const pad = input.length % 4 === 2 ? '==' : input.length % 4 === 3 ? '=' : '';
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const decoded = atob(normalized);
  const arr = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    arr[i] = decoded.charCodeAt(i);
  }
  return arr;
}

export async function verifyJwt(token: string, secret: string): Promise<AuthPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const data = `${headerB64}.${payloadB64}`;
    const sig = base64UrlToUint8Array(signatureB64);
    const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(data));
    if (!ok) return null;
    const payloadBytes = base64UrlToUint8Array(payloadB64);
    const payloadJson = new TextDecoder().decode(payloadBytes);
    const payload = JSON.parse(payloadJson) as AuthPayload;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseDueDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }
  return null;
}

export function toExtendedDate(value: string | null): unknown {
  if (!value) return null;
  return { $date: value };
}

function extractObjectId(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const doc = raw as Record<string, unknown>;
    if (typeof doc.$oid === 'string') return doc.$oid;
  }
  return undefined;
}

function extractIsoDate(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }
  if (typeof raw === 'object') {
    const doc = raw as Record<string, unknown>;
    if (doc.$date instanceof Date) {
      const iso = doc.$date.toISOString();
      return iso;
    }
    if (typeof doc.$date === 'string' || typeof doc.$date === 'number') {
      const date = new Date(doc.$date);
      if (Number.isNaN(date.getTime())) return null;
      return date.toISOString();
    }
  }
  return null;
}

export function serializeAssignment(doc: Record<string, unknown>): SerializedAssignment {
  const dueDate = extractIsoDate(doc.dueDate);
  const createdAt = extractIsoDate(doc.createdAt);
  const updatedAt = extractIsoDate(doc.updatedAt);
  return {
    id: extractObjectId(doc._id),
    title: typeof doc.title === 'string' ? doc.title : '',
    subject: typeof doc.subject === 'string' ? doc.subject : '',
    status: typeof doc.status === 'string' && VALID_ASSIGNMENT_STATUSES.has(doc.status)
      ? doc.status
      : 'todo',
    dueDate,
    details: typeof doc.details === 'string' ? doc.details : '',
    allDay: doc.allDay === undefined ? true : !!doc.allDay,
    timeLabel: typeof doc.timeLabel === 'string' ? doc.timeLabel : '',
    url: typeof doc.url === 'string' ? doc.url : '',
    createdAt,
    updatedAt,
    source: typeof doc.source === 'string' ? doc.source : 'manual',
    icalId: typeof doc.icalId === 'string' ? doc.icalId : null,
  };
}

export function getAssignmentsCollection(env: BaseEnv): string {
  return env.MONGODB_COLLECTION_ASSIGNMENTS?.trim() || 'assignments';
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function validateStatus(status: unknown): string {
  if (typeof status === 'string' && VALID_ASSIGNMENT_STATUSES.has(status)) {
    return status;
  }
  return 'todo';
}

export { VALID_ASSIGNMENT_STATUSES };
