const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(s) {
  return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
}

function signJwt(payload, secret) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

function verifyJwt(token, secret) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const data = `${h}.${p}`;
  const expected = crypto.createHmac('sha256', secret).update(data).digest();
  const sig = fromB64url(s);
  if (!crypto.timingSafeEqual(expected, sig)) return null;
  const payload = JSON.parse(Buffer.from(p.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
  return payload;
}

function pbkdf2Hash(password, salt, iterations = 120000) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, 'sha256', (err, derived) => {
      if (err) return reject(err);
      resolve({ iterations, salt: b64url(salt), hash: b64url(derived) });
    });
  });
}

async function bootstrap() {
  const { MONGODB_URI, MONGODB_DATABASE, MONGODB_COLLECTION_USERS, JWT_SECRET, PORT } = process.env;
  if (!MONGODB_URI || !MONGODB_DATABASE || !MONGODB_COLLECTION_USERS || !JWT_SECRET) {
    // Log but keep server to help debug
    console.error('Missing env vars. Required: MONGODB_URI, MONGODB_DATABASE, MONGODB_COLLECTION_USERS, JWT_SECRET');
  }

  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const users = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION_USERS);
  // Students profile store (thinkpod/student)
  const STUD_DB = process.env.MONGODB_DATABASE_STUDENTS || 'thinkpod';
  const STUD_COL = process.env.MONGODB_COLLECTION_STUDENTS || 'student';
  const students = client.db(STUD_DB).collection(STUD_COL);
  const SESS_DB = process.env.MONGODB_DATABASE_SESSIONS || 'thinkpod';
  const SESS_COL = process.env.MONGODB_COLLECTION_SESSIONS || 'sessiontime';
  const sessionsCol = client.db(SESS_DB).collection(SESS_COL);

  app.get('/auth/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

  // Sessions API for timetable
  app.get('/sessions', async (req, res) => {
    try {
      // Seed one sample session if collection empty
      const total = await sessionsCol.estimatedDocumentCount();
      if (total === 0) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 19, 0, 0); // tomorrow 7pm local
        const end = new Date(start.getTime() + 60 * 60000);
        await sessionsCol.insertOne({ title: 'Homework Help Session', subject: 'General', start: start.toISOString(), end: end.toISOString(), createdAt: new Date().toISOString() });
      }
      const nowIso = new Date().toISOString();
      const docs = await sessionsCol.find({ end: { $gte: nowIso } }).sort({ start: 1 }).limit(200).toArray();
      const events = docs.map(d => ({
        id: String(d._id || ''),
        title: d.title || 'Session',
        school: 'ThinkBigPrep',
        tutorName: 'TBP Coach',
        subject: d.subject || 'General',
        start: d.start,
        end: d.end,
        createdBy: 'system'
      }));
      return res.json({ ok: true, events });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/auth/signup', async (req, res) => {
    try {
      const { fullName, email, password } = req.body || {};
      const e = (email || '').toLowerCase().trim();
      if (!fullName || !e || !password) return res.status(400).json({ error: 'fullName, email, password required' });
      const exist = await students.findOne({ email: e });
      if (exist && exist.password) return res.status(409).json({ error: 'Email already registered' });
      const salt = crypto.randomBytes(16);
      const pwd = await pbkdf2Hash(password, salt);
      const now = new Date().toISOString();
      let insertedId = null;
      if (exist && !exist.password) {
        await students.updateOne({ _id: exist._id }, { $set: { fullName, email: e, password: { algo: 'pbkdf2-sha256', ...pwd }, updatedAt: now }, $setOnInsert: { createdAt: now, groupSessionTokens: 0, privateSessionTokens: 0 } }, { upsert: true });
        insertedId = exist._id;
      } else {
        const ins = await students.insertOne({ email: e, fullName, password: { algo: 'pbkdf2-sha256', ...pwd }, createdAt: now, updatedAt: now, groupSessionTokens: 0, privateSessionTokens: 0 });
        insertedId = ins.insertedId;
      }
      const iat = Math.floor(Date.now()/1000); const exp = iat + 60*60*24*7;
      const token = signJwt({ sub: (insertedId||'').toString(), email: e, iat, exp }, JWT_SECRET);
      res.status(201).json({ ok: true, user: { id: (insertedId||'').toString(), email: e, fullName }, token });
    } catch (e) {
      console.error(e); res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const e = (email || '').toLowerCase().trim();
      if (!e || !password) return res.status(400).json({ error: 'email and password required' });
      const user = await students.findOne({ email: e });
      if (!user || !user.password) return res.status(401).json({ error: 'Invalid credentials' });
      const saltBuf = fromB64url(user.password.salt);
      const derived = await new Promise((resolve, reject) => {
        crypto.pbkdf2(password, saltBuf, user.password.iterations, 32, 'sha256', (err, buf) => err ? reject(err) : resolve(buf));
      });
      const stored = fromB64url(user.password.hash);
      if (!crypto.timingSafeEqual(derived, stored)) return res.status(401).json({ error: 'Invalid credentials' });
      const iat = Math.floor(Date.now()/1000); const exp = iat + 60*60*24*7;
      const token = signJwt({ sub: (user._id||'').toString(), email: user.email, iat, exp }, JWT_SECRET);
      res.json({ ok: true, user: { id: (user._id||'').toString(), email: user.email, fullName: user.fullName || null }, token });
    } catch (e) {
      console.error(e); res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/auth/me', (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.json({ authenticated: false });
    const payload = verifyJwt(token, JWT_SECRET);
    if (!payload) return res.json({ authenticated: false });
    res.json({ authenticated: true, user: { id: payload.sub, email: payload.email } });
  });

  // Proxy iCalendar (.ics) fetch to avoid CORS in browser
  app.get('/auth/ics', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      const payload = verifyJwt(token, JWT_SECRET);
      if (!payload || !payload.email) return res.status(401).json({ error: 'Unauthorized' });

      const src = String(req.query.url || '').trim();
      if (!src) return res.status(400).json({ error: 'url is required' });
      if (!/^https?:\/\//i.test(src)) return res.status(400).json({ error: 'Only http(s) URLs allowed' });

      const r = await fetch(src, {
        headers: {
          'Accept': 'text/calendar, text/plain;q=0.9, */*;q=0.8',
          'User-Agent': 'ThinkBigPrep/1.0 (+https://thinkbigprep.com)'
        }
      });
      if (!r.ok) {
        return res.status(r.status).json({ error: 'Failed to fetch ICS' });
      }
      const text = await r.text();
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      return res.send(text);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // Save or update user profile fields
  app.post('/auth/profile', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      const payload = verifyJwt(token, JWT_SECRET);
      if (!payload || !payload.email) return res.status(401).json({ error: 'Unauthorized' });

      const { fullName, school, grade, phone, icsUrl, email, pronouns, subjects, notes, emergencyContacts } = req.body || {};
      // allow updating email, but normalize
      const nextEmail = (email || payload.email || '').toLowerCase().trim();
      if (!nextEmail) return res.status(400).json({ error: 'email required' });

      const now = new Date().toISOString();
      const update = { email: nextEmail, updatedAt: now };
      if (typeof fullName !== 'undefined') update.fullName = fullName || null;
      if (typeof school !== 'undefined') update.school = school || null;
      if (typeof grade !== 'undefined') update.grade = grade || null;
      if (typeof phone !== 'undefined') update.phone = phone || null;
      if (typeof icsUrl !== 'undefined') update.icsUrl = icsUrl || null;
      if (typeof pronouns !== 'undefined') update.pronouns = pronouns || null;
      if (typeof subjects !== 'undefined') update.subjects = subjects || null;
      if (typeof notes !== 'undefined') update.notes = notes || null;
      if (Array.isArray(emergencyContacts)) {
        const norm = (c) => ({
          name: c && c.name ? String(c.name).trim() : null,
          email: c && c.email ? String(c.email).trim().toLowerCase() : null,
          phone: c && c.phone ? String(c.phone).trim() : null,
          preference: c && c.preference ? String(c.preference).trim() : null
        });
        const p = norm(emergencyContacts[0] || {});
        const s = norm(emergencyContacts[1] || {});
        update.parentguardprimaryname = p.name;
        update.parentguardprimaryemail = p.email;
        update.parentguardprimaryphone = p.phone;
        update.parentguardprimarypreference = p.preference;
        update.parentguardsecondaryname = s.name;
        update.parentguardsecondaryemail = s.email;
        update.parentguardsecondaryphone = s.phone;
        update.parentguardsecondarypreference = s.preference;
      }

      const orConds = [];
      try { if (payload.sub) orConds.push({ _id: new ObjectId(payload.sub) }); } catch {}
      const pEmail = (payload.email || '').toLowerCase().trim();
      if (pEmail) orConds.push({ email: pEmail });
      if (nextEmail) orConds.push({ email: nextEmail });
      const filter = orConds.length ? { $or: orConds } : { email: nextEmail };

      await students.updateOne(
        filter,
        { $set: update, $setOnInsert: { createdAt: now, groupSessionTokens: 0, privateSessionTokens: 0 } },
        { upsert: true }
      );
      let doc = null;
      if (nextEmail) doc = await students.findOne({ email: nextEmail }, { projection: { password: 0 } });
      if (!doc) doc = await students.findOne(filter, { projection: { password: 0 } });
      if (!doc) return res.status(404).json({ error: 'User not found' });
      res.json({ ok: true, profile: { fullName: doc.fullName, email: doc.email, school: doc.school || null, grade: doc.grade || null, phone: doc.phone || null, icsUrl: doc.icsUrl || null } });
    } catch (e) {
      console.error(e); res.status(500).json({ error: 'Internal error' });
    }
  });

  // Fetch current profile
  app.get('/auth/profile', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      const payload = verifyJwt(token, JWT_SECRET);
      if (!payload || !payload.email) return res.status(401).json({ error: 'Unauthorized' });
      const filter = payload.sub ? { _id: new ObjectId(payload.sub) } : { email: (payload.email || '').toLowerCase().trim() };
      const user = await students.findOne(filter, { projection: { password: 0 } });
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ ok: true, profile: {
        fullName: user.fullName || null,
        email: user.email,
        school: user.school || null,
        grade: user.grade || null,
        phone: user.phone || null,
        icsUrl: user.icsUrl || null,
        pronouns: user.pronouns || null,
        subjects: user.subjects || null,
        notes: user.notes || null,
        groupSessionTokens: typeof user.groupSessionTokens === 'number' ? user.groupSessionTokens : 0,
        privateSessionTokens: typeof user.privateSessionTokens === 'number' ? user.privateSessionTokens : 0,
        parentguardprimaryname: user.parentguardprimaryname || null,
        parentguardprimaryemail: user.parentguardprimaryemail || null,
        parentguardprimaryphone: user.parentguardprimaryphone || null,
        parentguardprimarypreference: user.parentguardprimarypreference || null,
        parentguardsecondaryname: user.parentguardsecondaryname || null,
        parentguardsecondaryemail: user.parentguardsecondaryemail || null,
        parentguardsecondaryphone: user.parentguardsecondaryphone || null,
        parentguardsecondarypreference: user.parentguardsecondarypreference || null,
        emergencyContacts: Array.isArray(user.emergencyContacts) ? user.emergencyContacts : null
      } });
    } catch (e) {
      console.error(e); res.status(500).json({ error: 'Internal error' });
    }
  });

  // Save emergency contacts (two rows max) without requiring full profile fields
  app.post('/auth/emergency', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      const payload = verifyJwt(token, JWT_SECRET);
      if (!payload || !payload.email) return res.status(401).json({ error: 'Unauthorized' });

      const list = Array.isArray(req.body && req.body.emergencyContacts) ? req.body.emergencyContacts : [];
      // Normalize and cap to two
      const normalize = (c) => ({
        name: (c && c.name ? String(c.name).trim() : '') || null,
        email: (c && c.email ? String(c.email).trim().toLowerCase() : '') || null,
        phone: (c && c.phone ? String(c.phone).trim() : '') || null,
        preference: (c && c.preference ? String(c.preference).trim() : '') || null,
      });
      const arr = [ normalize(list[0] || {}), normalize(list[1] || {}) ];
      const primary = arr[0];
      if (!primary.name || !primary.email || !primary.phone || !primary.preference) {
        return res.status(400).json({ error: 'Primary contact (row 1) is required' });
      }

      const now = new Date().toISOString();
      const orConds = [];
      try { if (payload.sub) orConds.push({ _id: new ObjectId(payload.sub) }); } catch {}
      const pEmail = (payload.email || '').toLowerCase().trim();
      if (pEmail) orConds.push({ email: pEmail });
      const filter = orConds.length ? { $or: orConds } : { email: pEmail };

      await students.updateOne(filter, { $set: { emergencyContacts: arr, updatedAt: now } });
      return res.json({ ok: true });
    } catch (e) {
      console.error(e); res.status(500).json({ error: 'Internal error' });
    }
  });

  // Gemini proxy to avoid exposing API key in client
  app.post('/ai/generate', async (req, res) => {
    try {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });

      const { model, contents, generationConfig } = req.body || {};
      const useModel = (model && typeof model === 'string' ? model : 'gemini-1.5-pro');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(key)}`;

      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig })
      });
      const text = await upstream.text();
      res.status(upstream.status).type('application/json').send(text);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Proxy error' });
    }
  });

  const port = PORT || 8080;
  app.listen(port, () => console.log(`Auth API listening on ${port}`));
}

bootstrap().catch(err => { console.error('Bootstrap error', err); process.exit(1); });
