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

async function pbkdf2Hash(password, salt, iterations = 120000) {
  const hash = await new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, 'sha256', (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
  return { iterations, salt: b64url(salt), hash: b64url(hash) };
}

async function signJwt(payload, secret) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
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
    // If not parsed by Vercel, read raw
    try { body = JSON.parse(await new Promise(r => { let d=''; req.on('data', c => d+=c); req.on('end', () => r(d)); })); } catch { body = {}; }
  }

  const email = (body.email || '').toLowerCase().trim();
  const password = body.password || '';
  const fullName = (body.fullName || '').trim();
  if (!email || !password || !fullName) return json(res, 400, { error: 'fullName, email, password required' });

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const users = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION_USERS);

  const existing = await users.findOne({ email });
  if (existing) { await client.close(); return json(res, 409, { error: 'Email already registered' }); }

  const salt = crypto.randomBytes(16);
  const pwd = await pbkdf2Hash(password, salt);
  const now = new Date().toISOString();

  const ins = await users.insertOne({
    email,
    fullName,
    password: { algo: 'pbkdf2-sha256', ...pwd },
    createdAt: now,
    updatedAt: now,
    groupSessionTokens: 0,
    privateSessionTokens: 0,
  });

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 24 * 7;
  const token = await signJwt({ sub: (ins.insertedId || '').toString(), email, iat, exp }, JWT_SECRET);
  await client.close();
  return json(res, 201, { ok: true, user: { id: (ins.insertedId || '').toString(), email, fullName }, token });
};
