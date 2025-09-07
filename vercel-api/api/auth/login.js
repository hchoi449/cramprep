const { MongoClient } = require('mongodb');
const crypto = require('crypto');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(data));
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signJwt(payload, secret) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

function verify(password, { salt, iterations, hash }) {
  return new Promise((resolve, reject) => {
    const saltBuf = Buffer.from(salt.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
    crypto.pbkdf2(password, saltBuf, iterations, 32, 'sha256', (err, derived) => {
      if (err) return reject(err);
      const cmp = Buffer.from(hash.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
      resolve(crypto.timingSafeEqual(derived, cmp));
    });
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const { MONGODB_URI, MONGODB_DATABASE, MONGODB_COLLECTION_USERS, JWT_SECRET } = process.env;
  for (const k of ['MONGODB_URI','MONGODB_DATABASE','MONGODB_COLLECTION_USERS','JWT_SECRET']) {
    if (!process.env[k]) return json(res, 500, { error: `Missing env var: ${k}` });
  }

  let body = {};
  try { body = req.body || {}; } catch {}
  if (!body || Object.keys(body).length === 0) {
    try { body = JSON.parse(await new Promise(r => { let d=''; req.on('data', c => d+=c); req.on('end', () => r(d)); })); } catch { body = {}; }
  }

  const email = (body.email || '').toLowerCase().trim();
  const password = body.password || '';
  if (!email || !password) return json(res, 400, { error: 'email and password required' });

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const users = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION_USERS);

  const user = await users.findOne({ email });
  if (!user || !user.password) { await client.close(); return json(res, 401, { error: 'Invalid credentials' }); }
  const ok = await verify(password, user.password);
  if (!ok) { await client.close(); return json(res, 401, { error: 'Invalid credentials' }); }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 24 * 7;
  const token = await signJwt({ sub: (user._id || '').toString(), email: user.email, iat, exp }, JWT_SECRET);
  await client.close();
  return json(res, 200, { ok: true, user: { id: (user._id || '').toString(), email: user.email, fullName: user.fullName || null }, token });
};
