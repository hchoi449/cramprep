/**
 * GET /api/auth/me
 * Reads JWT from cookie and returns session info if valid.
 */

type Env = { JWT_SECRET: string };

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

async function verifyJwt(token: string, secret: string): Promise<any | null> {
  try {
    const enc = new TextEncoder();
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const data = `${h}.${p}`;
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
    const expected = base64UrlEncode(sig);
    if (expected !== s) return null;
    const json = new TextDecoder().decode(base64UrlDecodeToBytes(p));
    const payload = JSON.parse(json);
    if (!payload || (payload.exp && payload.exp < Math.floor(Date.now() / 1000))) return null;
    return payload;
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/(?:^|;\s*)tbp_session=([^;]+)/);
    const token = match ? decodeURIComponent(match[1]) : '';
    if (!token) return new Response(JSON.stringify({ authenticated: false }), { status: 200 });
    const payload = await verifyJwt(token, env.JWT_SECRET);
    if (!payload) return new Response(JSON.stringify({ authenticated: false }), { status: 200 });
    return new Response(JSON.stringify({ authenticated: true, user: { id: payload.sub, email: payload.email } }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    return new Response(JSON.stringify({ authenticated: false }), { status: 200 });
  }
};


