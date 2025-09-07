const crypto = require('crypto');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(data));
}

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
}

function verifyJwt(token, secret) {
  try {
    const [h, p, s] = token.split('.')
    if (!h || !p || !s) return null;
    const data = `${h}.${p}`;
    const expected = crypto.createHmac('sha256', secret).update(data).digest();
    const sig = b64urlToBuf(s);
    if (!crypto.timingSafeEqual(expected, sig)) return null;
    const payload = JSON.parse(Buffer.from(p.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const { JWT_SECRET } = process.env;
  if (!JWT_SECRET) return json(res, 500, { error: 'Missing env var: JWT_SECRET' });
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json(res, 200, { authenticated: false });
  const payload = verifyJwt(token, JWT_SECRET);
  if (!payload) return json(res, 200, { authenticated: false });
  return json(res, 200, { authenticated: true, user: { id: payload.sub, email: payload.email } });
};
