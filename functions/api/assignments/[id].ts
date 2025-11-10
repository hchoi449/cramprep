import {
  BaseEnv,
  AuthPayload,
  ensureEnv,
  dataApiFetch,
  verifyJwt,
  serializeAssignment,
  getUsersCollection,
  buildStudentFilter,
  nowIso,
  parseDueDate,
  validateStatus,
} from '../_utils/dataApi';

const REQUIRED_ENV: (keyof BaseEnv)[] = [
  'MONGODB_DATA_API_URL',
  'MONGODB_DATA_API_KEY',
  'MONGODB_DATA_SOURCE',
  'MONGODB_DATABASE',
  'MONGODB_COLLECTION_USERS',
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
  if (!value) return null;
  return value;
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

    const usersCollection = getUsersCollection(env);
    const filter = buildStudentFilter(payload.sub);

    const setPayload: Record<string, unknown> = {};
    Object.entries(updates).forEach(([key, value]) => {
      setPayload[`assignments.$[item].${key}`] = value;
    });
    setPayload['assignments.$[item].updatedAt'] = updates.updatedAt;

    const updateResult = await dataApiFetch<{ matchedCount?: number; modifiedCount?: number }>(env, 'updateOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: usersCollection,
      filter,
      update: { $set: setPayload },
      arrayFilters: [{ 'item._id': id }],
    });

    if (!updateResult.matchedCount) {
      return notFound();
    }

    const findResult = await dataApiFetch<{ document?: Record<string, unknown> | null }>(env, 'findOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: usersCollection,
      filter: {
        ...filter,
        'assignments._id': id,
      },
      projection: { assignments: { $elemMatch: { _id: id } } },
    });
    const doc = findResult.document;
    const assignmentDoc = Array.isArray(doc?.assignments) && doc.assignments.length ? doc.assignments[0] : null;
    if (!assignmentDoc) return notFound();

    const assignment = serializeAssignment(assignmentDoc as Record<string, unknown>);
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
    const usersCollection = getUsersCollection(env);
    const result = await dataApiFetch<{ matchedCount?: number; modifiedCount?: number }>(env, 'updateOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: usersCollection,
      filter: buildStudentFilter(payload.sub),
      update: { $pull: { assignments: { _id: id } } },
    });
    if (!result.matchedCount || !result.modifiedCount) {
      return notFound();
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: message }, 500);
  }
};
