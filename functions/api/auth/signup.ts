/**
 * POST /api/auth/signup
 * Body: { email: string, password: string, username?: string }
 * Creates user via MongoDB Atlas Data API using PBKDF2 password hashing.
 * Returns Set-Cookie with JWT session.
 */

type Env = {
  MONGODB_DATA_API_URL: string;
  MONGODB_DATA_API_KEY: string;
  MONGODB_DATA_SOURCE: string;
  MONGODB_DATABASE: string;
  MONGODB_COLLECTION_USERS: string;
  JWT_SECRET: string;
};

interface SignupBody {
  email?: string;
  password?: string;
  username?: string;
}

async function pbkdf2Hash(password: string, saltBytes: Uint8Array, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return base64UrlEncode(new Uint8Array(bits));
}

function base64UrlEncode(data: Uint8Array): string {
  let str = '';
  data.forEach(b => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const data = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  const sigB64 = base64UrlEncode(sig);
  return `${data}.${sigB64}`;
}

async function dataApiFetch(env: Env, action: string, body: unknown): Promise<any> {
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
  return res.json();
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { request, env } = context;
    const body = (await request.json().catch(() => ({}))) as SignupBody;
    const email = (body.email || '').toLowerCase().trim();
    const password = body.password || '';
    const username = (body.username || '').trim();

    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password are required.' }), { status: 400 });
    }

    // Check existing user
    const found = await dataApiFetch(env, 'findOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: env.MONGODB_COLLECTION_USERS,
      filter: { email },
    });
    if (found?.document) {
      return new Response(JSON.stringify({ error: 'Email already registered.' }), { status: 409 });
    }

    // Hash password using PBKDF2-SHA256
    const iterations = 120000;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await pbkdf2Hash(password, salt, iterations);
    const saltB64 = base64UrlEncode(salt);

    const nowIso = new Date().toISOString();
    const insertRes = await dataApiFetch(env, 'insertOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: env.MONGODB_COLLECTION_USERS,
      document: {
        email,
        username: username || null,
        password: { algo: 'pbkdf2-sha256', iterations, salt: saltB64, hash },
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    });

    const userId = insertRes?.insertedId || email;
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 60 * 60 * 24 * 7; // 7 days
    const token = await signJwt({ sub: userId, email, iat, exp }, env.JWT_SECRET);

    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
    const cookie = `tbp_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;
    headers.append('Set-Cookie', cookie);
    return new Response(JSON.stringify({ ok: true, user: { id: userId, email, username } }), { status: 201, headers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
};


