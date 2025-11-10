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
} from '../../_utils/dataApi';

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

async function authenticate(request: Request, env: BaseEnv): Promise<AuthPayload | null> {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  return verifyJwt(token, env.JWT_SECRET);
}

interface PutBody {
  title?: string;
  subject?: string;
  status?: string;
  dueDate?: string;
  details?: string;
  allDay?: boolean;
  timeLabel?: string;
  url?: string;
}

export const onRequestPut: PagesFunction<BaseEnv> = async (context) => {
  const { env, request, params } = context;
  const missing = ensureEnv(env, REQUIRED_ENV);
  if (missing) return missingEnvResponse(missing);

  const payload = await authenticate(request, env);
  if (!payload) return unauthorized();

  const rawId = params?.icalId;
  const icalId = typeof rawId === 'string' ? rawId.trim() : '';
  if (!icalId) return badRequest('Invalid assignment id.');

  try {
    const body = (await request.json().catch(() => ({}))) as PutBody;
    const title = (body.title || '').trim();
    if (!title) return badRequest('Title is required.');

    const subject = body.subject ? String(body.subject).trim() : '';
    const status = validateStatus(body.status);
    const dueIso = parseDueDate(body.dueDate);
    const details = body.details ? String(body.details).trim() : '';
    const allDay = body.allDay === undefined ? !body.timeLabel : !!body.allDay;
    const timeLabel = body.timeLabel ? String(body.timeLabel).trim() : '';
    const url = body.url ? String(body.url).trim() : '';

    const now = nowIso();
    const usersCollection = getUsersCollection(env);
    const filter = buildStudentFilter(payload.sub);

    const setPayload: Record<string, unknown> = {
      'assignments.$[item].title': title,
      'assignments.$[item].subject': subject,
      'assignments.$[item].status': status,
      'assignments.$[item].dueDate': dueIso,
      'assignments.$[item].details': details,
      'assignments.$[item].allDay': allDay,
      'assignments.$[item].timeLabel': timeLabel,
      'assignments.$[item].url': url,
      'assignments.$[item].source': 'override',
      'assignments.$[item].updatedAt': now,
    };

    const updateExisting = await dataApiFetch<{ matchedCount?: number; modifiedCount?: number }>(env, 'updateOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: usersCollection,
      filter: {
        ...filter,
        'assignments.icalId': icalId,
      },
      update: { $set: setPayload },
      arrayFilters: [{ 'item.icalId': icalId }],
    });

    let assignmentDoc: Record<string, unknown> | null = null;
    if (!updateExisting.matchedCount) {
      const newAssignment = {
        _id: generateAssignmentId(),
        title,
        subject,
        status,
        dueDate: dueIso,
        details,
        allDay,
        timeLabel,
        url,
        source: 'override',
        icalId,
        createdAt: now,
        updatedAt: now,
      };
      const pushResult = await dataApiFetch<{ matchedCount?: number }>(env, 'updateOne', {
        dataSource: env.MONGODB_DATA_SOURCE,
        database: env.MONGODB_DATABASE,
        collection: usersCollection,
        filter,
        update: { $push: { assignments: newAssignment } },
      });
      if (!pushResult.matchedCount) {
        return jsonResponse({ error: 'Student record not found.' }, 404);
      }
      assignmentDoc = newAssignment;
    } else {
      const findResult = await dataApiFetch<{ document?: Record<string, unknown> | null }>(env, 'findOne', {
        dataSource: env.MONGODB_DATA_SOURCE,
        database: env.MONGODB_DATABASE,
        collection: usersCollection,
        filter: {
          ...filter,
          'assignments.icalId': icalId,
        },
        projection: { assignments: { $elemMatch: { icalId } } },
      });
      if (Array.isArray(findResult.document?.assignments) && findResult.document.assignments.length) {
        assignmentDoc = findResult.document.assignments[0] as Record<string, unknown>;
      }
    }

    if (!assignmentDoc) {
      return jsonResponse({ error: 'Unable to load assignment.' }, 500);
    }

    const assignment = serializeAssignment(assignmentDoc);
    return jsonResponse({ ok: true, assignment });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: message }, 500);
  }
};
