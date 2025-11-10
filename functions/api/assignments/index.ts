import {
  BaseEnv,
  AuthPayload,
  ensureEnv,
  dataApiFetch,
  verifyJwt,
  serializeAssignment,
  getUsersCollection,
  buildStudentFilter,
  generateAssignmentId,
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
    const usersCollection = getUsersCollection(env);
    const filter = buildStudentFilter(payload.sub);
    const result = await dataApiFetch<{ document?: Record<string, unknown> | null }>(env, 'findOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: usersCollection,
      filter,
      projection: { assignments: 1 },
    });
    const assignmentsArray = Array.isArray(result.document?.assignments)
      ? (result.document?.assignments as Record<string, unknown>[])
      : [];
    assignmentsArray.sort((a, b) => {
      const aDue = typeof a.dueDate === 'string' ? new Date(a.dueDate).getTime() : Infinity;
      const bDue = typeof b.dueDate === 'string' ? new Date(b.dueDate).getTime() : Infinity;
      if (aDue !== bDue) return aDue - bDue;
      const aCreated = typeof a.createdAt === 'string' ? new Date(a.createdAt).getTime() : 0;
      const bCreated = typeof b.createdAt === 'string' ? new Date(b.createdAt).getTime() : 0;
      return bCreated - aCreated;
    });
    const assignments = assignmentsArray.map(serializeAssignment);
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

    const assignmentId = generateAssignmentId();
    const assignmentDoc = { ...document, _id: assignmentId };

    const usersCollection = getUsersCollection(env);
    const userFilter = buildStudentFilter(payload.sub);
    const updateResult = await dataApiFetch<{ matchedCount?: number; modifiedCount?: number }>(env, 'updateOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: usersCollection,
      filter: userFilter,
      update: { $push: { assignments: assignmentDoc } },
    });

    if (!updateResult.matchedCount) {
      return jsonResponse({ error: 'Student record not found.' }, 404);
    }

    const assignment = serializeAssignment(assignmentDoc);
    return jsonResponse({ ok: true, assignment }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: message }, 500);
  }
};
