/**
 * POST /api/auth/login
 * Body: { email: string, password: string }
 * Verifies user via MongoDB Atlas Data API and PBKDF2 comparison.
 * Returns Set-Cookie with JWT session on success.
 */

type Env = {
  MONGODB_DATA_API_URL: string;
  MONGODB_DATA_API_KEY: string;
  MONGODB_DATA_SOURCE: string;
  MONGODB_DATABASE: string;
  MONGODB_COLLECTION_USERS: string;
  JWT_SECRET: string;
};

interface LoginBody { email?: string; password?: string; }

function base64UrlDecodeToBytes(b64: string): Uint8Array {
  const pad = b64.length % 4 === 2 ? '==' : b64.length % 4 === 3 ? '=' : '';
  const str = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i);
  return arr;
}

function base64UrlEncode(data: Uint8Array): string {
  let str = '';
  data.forEach(b => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function pbkdf2Hash(password: string, saltBytes: Uint8Array, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  return base64UrlEncode(new Uint8Array(bits));
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
    headers: { 'Content-Type': 'application/json', 'api-key': env.MONGODB_DATA_API_KEY },
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
    // Validate required environment variables
    const required: (keyof Env)[] = [
      'MONGODB_DATA_API_URL',
      'MONGODB_DATA_API_KEY',
      'MONGODB_DATA_SOURCE',
      'MONGODB_DATABASE',
      'MONGODB_COLLECTION_USERS',
      'JWT_SECRET',
    ];
    for (const k of required) {
      if (!env[k]) {
        return new Response(JSON.stringify({ error: `Missing env var: ${k}` }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      }
    }
    const body = (await request.json().catch(() => ({}))) as LoginBody;
    const email = (body.email || '').toLowerCase().trim();
    const password = body.password || '';
    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password are required.' }), { status: 400 });
    }

    // Lookup user
    const found = await dataApiFetch(env, 'findOne', {
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: env.MONGODB_COLLECTION_USERS,
      filter: { email },
    });
    const user = found?.document;
    if (!user || !user.password) {
      return new Response(JSON.stringify({ error: 'Invalid credentials.' }), { status: 401 });
    }

    const { iterations, salt, hash } = user.password as { iterations: number; salt: string; hash: string };
    const computed = await pbkdf2Hash(password, base64UrlDecodeToBytes(salt), iterations);
    if (computed !== hash) {
      return new Response(JSON.stringify({ error: 'Invalid credentials.' }), { status: 401 });
    }

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 60 * 60 * 24 * 7;
    const token = await signJwt({ sub: user._id || user.email, email: user.email, iat, exp }, env.JWT_SECRET);
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
    headers.append('Set-Cookie', `tbp_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`);
    return new Response(JSON.stringify({ ok: true, user: { id: user._id || user.email, email: user.email, fullName: user.fullName || null } }), { status: 200, headers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
};


