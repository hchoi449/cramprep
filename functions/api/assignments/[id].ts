import {
  BaseEnv,
  AuthPayload,
  ensureEnv,
  dataApiFetch,
  verifyJwt,
  serializeAssignment,
  getAssignmentsCollection,
  nowIso,
  parseDueDate,
  validateStatus,
} from '../_utils/dataApi';

const REQUIRED_ENV: (keyof BaseEnv)[] = [
  'MONGODB_DATA_API_URL',
  'MONGODB_DATA_API_KEY',
  'MONGODB_DATA_SOURCE',
  'MONGODB_DATABASE',
  'JWT_SECRET',
];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function unauthorized(): Response {
  return jsonResponse({ error: 'Unauthorized' }, 401);
}

function missingEnvResponse(key: string): Response {
  return jsonResponse({ error: `Missing env var: ${key}` }, 500);
}

function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

function notFound(): Response {
  return jsonResponse({ error: 'Assignment not found' }, 404);
}

async function authenticate(request: Request, env: BaseEnv): Promise<AuthPayload | null> {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  return verifyJwt(token, env.JWT_SECRET);
}

function normalizeId(id: unknown): string | null {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value || !/^[a-fA-F0-9]{24}$/.test(value)) return null;
  return value.toLowerCase();
}

interface PatchBody {
  title?: string;
  subject?: string;
  status?: string;
  dueDate?: string;
  details?: string;
  allDay?: boolean;
  timeLabel?: string;
  url?: string;
}

export const onRequestPatch: PagesFunction<BaseEnv> = async (context) => {
  const { env, request, params } = context;
  const missing = ensureEnv(env, REQUIRED_ENV);
  if (missing) return missingEnvResponse(missing);

  const payload = await authenticate(request, env);
  if (!payload) return unauthorized();

  const rawId = params?.id;
  const id = normalizeId(typeof rawId === 'string' ? rawId : '');
  if (!id) return badRequest('Invalid assignment id.');

  try {
    const body = (await request.json().catch(() => ({}))) as PatchBody;
    const updates: Record<string, unknown> = {};

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) return badRequest('Title cannot be empty.');
      updates.title = title;
    }
    if (body.subject !== undefined) {
      updates.subject = String(body.subject || '').trim();
    }
    if (body.status !== undefined) {
      const normalized = validateStatus(body.status);
      if (normalized !== body.status) return badRequest('Invalid status.');
      updates.status = normalized;
    }
    if (body.dueDate !== undefined) {
      updates.dueDate = parseDueDate(body.dueDate);
    }
    if (body.details !== undefined) {
      updates.details = String(body.details || '').trim();
    }
    if (body.timeLabel !== undefined) {
      updates.timeLabel = String(body.timeLabel || '').trim();
    }
    if (body.allDay !== undefined) {
      updates.allDay = !!body.allDay;
    }
    if (body.url !== undefined) {
      updates.url = String(body.url || '').trim();
    }

    if (!Object.keys(updates).length) {
      return badRequest('No fields to update.');
    }
    updates.updatedAt = nowIso();

    const collection = getAssignmentsCollection(env);
    const filter = {
      _id: { $oid: id },
      studentId: payload.sub,
    };

    const updateResult = await dataApiFetch<{ matchedCount?: number; modifiedCount?: number }>(env, 'updateOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection,
      filter,
      update: { $set: updates },
    });
    if (!updateResult.matchedCount) {
      return notFound();
    }

    const findResult = await dataApiFetch<{ document?: Record<string, unknown> | null }>(env, 'findOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection,
      filter,
    });
    if (!findResult.document) {
      return notFound();
    }
    const assignment = serializeAssignment(findResult.document);
    return jsonResponse({ ok: true, assignment });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: message }, 500);
  }
};

export const onRequestDelete: PagesFunction<BaseEnv> = async (context) => {
  const { env, request, params } = context;
  const missing = ensureEnv(env, REQUIRED_ENV);
  if (missing) return missingEnvResponse(missing);

  const payload = await authenticate(request, env);
  if (!payload) return unauthorized();

  const rawId = params?.id;
  const id = normalizeId(typeof rawId === 'string' ? rawId : '');
  if (!id) return badRequest('Invalid assignment id.');

  try {
    const collection = getAssignmentsCollection(env);
    const result = await dataApiFetch<{ deletedCount?: number }>(env, 'deleteOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection,
      filter: { _id: { $oid: id }, studentId: payload.sub },
    });
    if (!result.deletedCount) {
      return notFound();
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: message }, 500);
  }
};
