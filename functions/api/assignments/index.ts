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

async function authenticate(request: Request, env: BaseEnv): Promise<AuthPayload | null> {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  return verifyJwt(token, env.JWT_SECRET);
}

export const onRequestGet: PagesFunction<BaseEnv> = async (context) => {
  const { env, request } = context;
  const missing = ensureEnv(env, REQUIRED_ENV);
  if (missing) return missingEnvResponse(missing);

  const payload = await authenticate(request, env);
  if (!payload) return unauthorized();

  try {
    const collection = getAssignmentsCollection(env);
    const result = await dataApiFetch<{ documents?: Record<string, unknown>[] }>(env, 'find', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection,
      filter: { studentId: payload.sub },
      sort: { dueDate: 1, createdAt: -1 },
      limit: 200,
    });
    const docs = Array.isArray(result.documents) ? result.documents : [];
    const assignments = docs.map(serializeAssignment);
    return jsonResponse({ ok: true, assignments });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: message }, 500);
  }
};

interface CreateAssignmentBody {
  title?: string;
  subject?: string;
  status?: string;
  dueDate?: string;
  details?: string;
  allDay?: boolean;
  timeLabel?: string;
  url?: string;
}

export const onRequestPost: PagesFunction<BaseEnv> = async (context) => {
  const { env, request } = context;
  const missing = ensureEnv(env, REQUIRED_ENV);
  if (missing) return missingEnvResponse(missing);

  const payload = await authenticate(request, env);
  if (!payload) return unauthorized();

  try {
    const body = (await request.json().catch(() => ({}))) as CreateAssignmentBody;
    const title = (body.title || '').trim();
    if (!title) {
      return jsonResponse({ error: 'Title is required.' }, 400);
    }
    const subject = body.subject ? String(body.subject).trim() : '';
    const status = validateStatus(body.status);
    const dueIso = parseDueDate(body.dueDate);
    const details = body.details ? String(body.details).trim() : '';
    const allDay = body.allDay === undefined ? !body.timeLabel : !!body.allDay;
    const timeLabel = body.timeLabel ? String(body.timeLabel).trim() : '';
    const url = body.url ? String(body.url).trim() : '';

    const now = nowIso();
    const document: Record<string, unknown> = {
      studentId: payload.sub,
      title,
      subject,
      status,
      dueDate: dueIso,
      details,
      allDay,
      timeLabel,
      url,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    };

    const collection = getAssignmentsCollection(env);
    const insertResult = await dataApiFetch<{ insertedId?: Record<string, unknown> }>(env, 'insertOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection,
      document,
    });
    const assignment = serializeAssignment({
      ...document,
      _id: insertResult.insertedId,
    });
    return jsonResponse({ ok: true, assignment }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: message }, 500);
  }
};
