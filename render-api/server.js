const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
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
  const assetsDir = path.resolve(__dirname, '../assets_ingest');
  try { fs.mkdirSync(assetsDir, { recursive: true }); } catch {}

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
      const key = process.env.GEMINI_API_KEY || process.env.gemini_api_key || process.env.GOOGLE_GEMINI_API_KEY;
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

  // ===== Practice session tracking (ensures count reaches 10 server-side) =====
  app.post('/ai/session/start', async (req, res) => {
    try {
      const lessonSlug = String(req.query.lesson || '').trim();
      if (!lessonSlug) return res.status(400).json({ error: 'lesson (slug) is required' });
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const sess = await getSessionCollection(client);
      const now = new Date().toISOString();
      const doc = { lessonSlug, count: 0, used: [], createdAt: now, updatedAt: now };
      const r = await sess.insertOne(doc);
      await client.close();
      return res.status(201).json({ ok: true, sessionId: String(r.insertedId), count: 0, target: 10 });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'session_start_failed' }); }
  });

  app.post('/ai/session/answer', async (req, res) => {
    try {
      const sessionId = String(req.query.session || '').trim();
      if (!sessionId) return res.status(400).json({ error: 'session id is required' });
      const { correct, sourceHash } = req.body || {};
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const sess = await getSessionCollection(client);
      const _id = new ObjectId(sessionId);
      const doc = await sess.findOne({ _id });
      if (!doc){ await client.close(); return res.status(404).json({ error: 'session_not_found' }); }
      const nextCount = Math.min(10, Number(doc.count||0) + 1);
      const used = Array.isArray(doc.used) ? doc.used.slice(0, 200) : [];
      if (sourceHash && typeof sourceHash === 'string' && !used.includes(sourceHash)) used.push(sourceHash);
      await sess.updateOne({ _id }, { $set: { count: nextCount, used, updatedAt: new Date().toISOString() } });
      await client.close();
      return res.json({ ok: true, count: nextCount, finished: nextCount >= 10 });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'session_answer_failed' }); }
  });

  // ===== Agent pipeline: Question Generation (Agent 1) and Serving (Agent 2) =====
  const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URI;
  const QUESTIONS_DB = 'thinkpod';
  const QUESTIONS_COL = 'questionbank';
  const INGEST_COL = 'textbook_chunks';
  const SESSIONS_COL = 'practice_sessions';

  async function getQuestionCollection(client){
    const col = client.db(QUESTIONS_DB).collection(QUESTIONS_COL);
    try {
      await col.createIndex({ lessonSlug: 1, generatedAt: -1 });
      await col.createIndex({ sourceHash: 1 }, { unique: true });
    } catch(err){ /* ignore if exists */ }
    return col;
  }

  async function getIngestCollection(client){
    const col = client.db(QUESTIONS_DB).collection(INGEST_COL);
    try {
      await col.createIndex({ lessonSlug: 1 });
      await col.createIndex({ sourceId: 1 });
    } catch(err){}
    return col;
  }

  async function getSessionCollection(client){
    const col = client.db(QUESTIONS_DB).collection(SESSIONS_COL);
    try {
      await col.createIndex({ lessonSlug: 1, createdAt: -1 });
    } catch(err){}
    return col;
  }

  function sha256Hex(input){
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  // Ingest all local PDFs from /textbooks into textbook_chunks if not already present or if updated
  async function ingestLocalTextbooks(ingCol){
    try {
      const dir = path.resolve(__dirname, '../textbooks');
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter(f => /\.pdf$/i.test(f));
      for (const name of files){
        try {
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          const sig = `file://${full}|${stat.mtimeMs}`;
          const sourceId = sha256Hex(sig);
          const existing = await ingCol.findOne({ sourceId });
          if (existing) continue;
          // Remove older versions of this file by path prefix
          await ingCol.deleteMany({ url: `file://${full}` });
          const buf = fs.readFileSync(full);
          const pdf = await pdfParse(buf);
          const text = String((pdf && pdf.text) || '');
          const lines = text.split(/\n+/).map(s=> s.trim()).filter(Boolean);
          const chunks = [];
          let acc = []; let page = 1; let approxPage = 1; let countChars = 0;
          for (const line of lines){
            acc.push(line);
            countChars += line.length + 1;
            // crude page increment every ~1800 chars if no explicit markers
            if (/^\s*Page\s+\d+\s*$/i.test(line)) {
              const p = parseInt(line.replace(/\D+/g,''),10);
              if (Number.isFinite(p)) approxPage = p;
            }
            if (acc.join(' ').length > 1200){
              chunks.push({ page: approxPage, text: acc.join(' ') });
              acc = [];
              approxPage++;
            }
          }
          if (acc.length) chunks.push({ page: approxPage, text: acc.join(' ') });
          const docs = chunks.map((c)=> ({ sourceId, url: `file://${full}`, page: c.page, text: c.text, lessonSlug: null, lessonTitle: null, createdAt: new Date().toISOString() }));
          if (docs.length) await ingCol.insertMany(docs, { ordered: false });
        } catch {}
      }
    } catch {}
  }

  function normalizeStem(s){
    return String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
  }

  function computeDifficulty(stem, explanation){
    try {
      const s = String(stem||'');
      const ops = (s.match(/[+\-*/()^]/g) || []).length;
      const len = s.length;
      if (ops <= 1 && len < 60) return 'easy';
      if (ops <= 3 && len < 140) return 'medium';
      return 'hard';
    } catch { return 'medium'; }
  }

  function extractCoordinatePairsFromText(text){
    try {
      const s = String(text||'');
      const re = /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g;
      const out = [];
      let m; while ((m = re.exec(s))){
        const x = Number(m[1]); const y = Number(m[2]);
        if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
      }
      return out;
    } catch { return []; }
  }

  // Convert LaTeX-ish option text to a simple plain string for canonical comparisons
  function stripLatexToPlain(text){
    try {
      let t = String(text||'');
      t = t.replace(/\$(.*?)\$/g, '$1');
      t = t.replace(/\\dfrac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)');
      t = t.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)');
      t = t.replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\div/g, '÷');
      t = t.replace(/\\left|\\right/g, '');
      t = t.replace(/\\[a-zA-Z]+/g, '');
      t = t.replace(/[{}]/g, '');
      t = t.replace(/\s+/g, ' ');
      return t.trim();
    } catch { return String(text||''); }
  }

  function normalizePlainServer(s){
    try { return String(stripLatexToPlain(s)||'').toLowerCase().replace(/\s+/g,' ').trim(); } catch { return String(s||''); }
  }

  function parseNumberLooseServer(s){
    try {
      const t = String(stripLatexToPlain(s)||'').replace(/,/g,'');
      const mFrac = t.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
      if (mFrac){ const a=parseFloat(mFrac[1]); const b=parseFloat(mFrac[2]); if (!Number.isNaN(a)&&!Number.isNaN(b)&&b!==0) return a/b; }
      const m = t.match(/-?\d+(?:\.\d+)?/);
      return m ? parseFloat(m[0]) : NaN;
    } catch { return NaN; }
  }

  function mutateDistractorForUniqueness(text, bump){
    try {
      const plain = stripLatexToPlain(text);
      const n = parseNumberLooseServer(plain);
      if (!Number.isNaN(n)){
        const decimals = (String(plain).split('.')[1]||'').length;
        const next = (n + Math.max(1,bump)).toFixed(decimals);
        return next;
      }
      // fraction a/b -> (a+bump)/b
      const mFrac = String(plain).match(/^(\d+)\s*\/\s*(\d+)$/);
      if (mFrac){ const a=parseInt(mFrac[1],10); const b=parseInt(mFrac[2],10); return `${a+Math.max(1,bump)}/${b}`; }
      // coordinate (x,y) -> (x+bump,y)
      const mPt = String(plain).match(/^\(\s*([-\d\.]+)\s*,\s*([-\d\.]+)\s*\)$/);
      if (mPt){ const x=parseFloat(mPt[1]); const y=parseFloat(mPt[2]); if (!Number.isNaN(x)&&!Number.isNaN(y)) return `(${x+Math.max(1,bump)},${y})`; }
      // fallback: append a narrow no-break space + letter to make distinct
      return `${plain}\u202f`; // visually identical but distinct
    } catch { return String(text||''); }
  }

  function dedupeOptions(options, correctIdx){
    const out = options.slice(0,4).map(String);
    const seen = new Set();
    // ensure correct option reserved
    const normCorrect = normalizePlainServer(out[correctIdx]||'');
    seen.add(normCorrect);
    for (let i=0;i<out.length;i++){
      if (i === correctIdx) continue;
      let candidate = out[i];
      let norm = normalizePlainServer(candidate);
      let tries = 0;
      while (seen.has(norm) && tries < 5){
        candidate = mutateDistractorForUniqueness(candidate, i+1+tries);
        norm = normalizePlainServer(candidate);
        tries++;
      }
      out[i] = candidate;
      seen.add(norm);
    }
    // Special case: if stem asks for prime in a range, force distractors to be composite or out-of-range
    try {
      const composite = (n)=>{ n = Number(n); if (!Number.isFinite(n)) return true; if (n<2) return true; if (n%2===0) return n!==2; for(let d=3; d*d<=n; d+=2){ if(n%d===0) return true; } return false; };
      // When we can detect numeric distractors, shift them to nearest composite
      for (let i=0;i<out.length;i++){
        if (i===correctIdx) continue;
        let t = out[i];
        const m = String(stripLatexToPlain(t)||'').match(/-?\d+(?:\.\d+)?/);
        if (!m) continue; let val = parseInt(m[0],10); if (!Number.isFinite(val)) continue;
        let adjust = 0; while (!composite(val+adjust) && adjust < 5) adjust++;
        if (adjust>0) out[i] = String(val+adjust);
      }
    } catch {}
    return { options: out, correctIdx };
  }

  async function callGeminiGenerate(model, prompt){
    const key = process.env.GEMINI_API_KEY || process.env.gemini_api_key || process.env.GOOGLE_GEMINI_API_KEY;
    const useModel = model || 'gemini-1.5-flash-8b';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [ { role: 'user', parts: [ { text: prompt } ] } ],
      generationConfig: { temperature: 0.3, topP: 0.8, candidateCount: 1 }
    };
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const j = await r.json();
    const txt = ((((j||{}).candidates||[])[0]||{}).content||{}).parts?.[0]?.text || '';
    return txt;
  }

  async function callGeminiJSON(model, instruction){
    const txt = await callGeminiGenerate(model, instruction);
    try {
      const m = txt && txt.match(/```json[\s\S]*?```/i);
      const raw = m ? m[0].replace(/```json/i,'').replace(/```/,'').trim() : (txt && txt.trim().startsWith('{')? txt.trim(): null);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function buildLessonPrompt(lessonTitle, lessonSlug, count){
    const nowRnd = Math.floor(Date.now()/1000);
    const seed = `${nowRnd}-${Math.floor(Math.random()*1e9)}`;
    const isWriting = /writing expressions/i.test(String(lessonTitle||''));
    const rules = isWriting
      ? `RULES: Create WORD-PHRASE → EXPRESSION translation items ONLY. Each stem must be a short word phrase (e.g., "three more than twice a number"). The correct option must be an algebraic expression with variables and operations (e.g., 2n+3, (m+5)/2). Do NOT ask to simplify or solve; do NOT produce numeric answers.`
      : `RULES: Stay strictly on lesson scope. Avoid off-topic content.`;
    return `Seed: ${seed}\nLesson: ${lessonTitle} (slug: ${lessonSlug})\nMake ${count} multiple‑choice questions. Each item format:\n{
  "stem": string,
  "options": [string,string,string,string],
  "correct": number, // 0..3
  "explanation": string,
  "graph"?: { "expressions": Array< { "id"?: string, "latex"?: string } | { "type": "point", "x": number, "y": number } > },
  "table"?: { "headers"?: string[], "rows": string[][] },
  "numberLine"?: { "min": number, "max": number, "step"?: number, "points"?: Array<number | { "x": number, "label"?: string, "open"?: boolean }>, "intervals"?: Array<{ "from": number, "to": number, "openLeft"?: boolean, "openRight"?: boolean, "label"?: string }> }
}\n${rules}\nNotes: If the source contains tables or describes data, include a concise table under "table". If a graph is implied or useful (lines, parabolas, plotted points), include a minimal set of Desmos-compatible expressions under "graph.expressions". For integer comparisons, ordering, absolute value, or inequalities on a 1D axis, include a compact number line structure under "numberLine".\nReturn STRICT JSON: { "problems": [ ... ] }`;
  }

  // Ingest textbook PDF (upload by URL) and chunk text
  app.post('/ai/agent1/ingest', async (req, res) => {
    try {
      const { url, lessonSlug, lessonTitle } = req.body || {};
      if (!url) return res.status(400).json({ error: 'url required' });
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getIngestCollection(client);
      const r = await fetch(url);
      if (!r.ok) { await client.close(); return res.status(400).json({ error: 'fetch_failed' }); }
      const buf = Buffer.from(await r.arrayBuffer());
      const pdf = await pdfParse(buf);
      const text = String(pdf && pdf.text || '');
      const lines = text.split(/\n+/).map(s=> s.trim()).filter(Boolean);
      const chunks = [];
      let acc = [];
      let page = 1;
      for (const line of lines){
        acc.push(line);
        if (acc.join(' ').length > 1200){
          chunks.push({ page, text: acc.join(' ') });
          acc = [];
        }
        if (/^\s*Page\s+\d+\s*$/i.test(line)) page = parseInt(line.replace(/\D+/g,''),10)||page;
      }
      if (acc.length) chunks.push({ page, text: acc.join(' ') });
      const sourceId = sha256Hex(url);
      // optional lesson association
      const docs = chunks.map((c,i)=> ({ sourceId, url, page: c.page, text: c.text, lessonSlug: lessonSlug||null, lessonTitle: lessonTitle||null, createdAt: new Date().toISOString() }));
      await col.deleteMany({ sourceId });
      if (docs.length) await col.insertMany(docs, { ordered: false });
      await client.close();
      return res.json({ ok:true, sourceId, chunks: docs.length });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'ingest_failed' }); }
  });

  // Agent 1: Generate and store ≥30 questions for a lesson
  app.post('/ai/agent1/generate', async (req, res) => {
    const lessonSlug = String(req.query.lesson || '').trim();
    const lessonTitle = String(req.body && req.body.title || req.query.title || lessonSlug).trim();
    const book = String((req.query && req.query.book) || (req.body && req.body.book) || '').trim() || null;
    if (!lessonSlug) return res.status(400).json({ error: 'lesson (slug) is required' });
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      const ing = await getIngestCollection(client);

      const perBatch = 12; // small fast batches
      const target = Math.max(30, Number(req.query.target||0) || 30);
      const maxAttempts = 6;
      const seen = new Set();
      const docs = [];
      let attempts = 0;
      const requireVisual = String(req.query.require || '').toLowerCase();
      const visualNote = requireVisual === 'graph'
        ? 'REQUIREMENT: Include a minimal graph under "graph.expressions" relevant to the item.'
        : requireVisual === 'table'
        ? 'REQUIREMENT: Include a concise table under "table" with headers and rows relevant to the item.'
        : requireVisual === 'numberline'
        ? 'REQUIREMENT: Include a compact number line under "numberLine" (min, max, points or intervals) relevant to the item.'
        : '';
      // Prefer ingested chunks for the lesson, fall back to model-only
      try { await ingestLocalTextbooks(ing); } catch {}
      const chunks = await ing.find({ $or:[ { lessonSlug }, { lessonSlug: null } ] }).limit(500).toArray();
      const contextText = chunks && chunks.length ? chunks.slice(0,40).map(c=> `p.${c.page}: ${c.text}`).join('\n\n') : '';
      while (docs.length < target && attempts < maxAttempts){
        attempts++;
        const need = target - docs.length;
        const batches = Math.min(4, Math.max(1, Math.ceil(need / perBatch)));
        const prompts = new Array(batches).fill(0).map(()=> {
          const base = buildLessonPrompt(lessonTitle, lessonSlug, perBatch);
          const withContext = contextText ? `${base}\n\nUse this textbook context (extract key facts, captions, tables, graphs):\n${contextText.substring(0, 8000)}` : base;
          return visualNote ? `${withContext}\n\n${visualNote}` : withContext;
        });
        const results = await Promise.all(prompts.map(p=> callGeminiGenerate('gemini-1.5-flash-8b', p).catch(()=>'')));
        const all = [];
        for (const txt of results){
          try {
            const m = txt.match(/```json[\s\S]*?```/i);
            const raw = m ? m[0].replace(/```json/i,'').replace(/```/,'').trim() : (txt.trim().startsWith('{')? txt.trim(): null);
            if (!raw) continue;
            const j = JSON.parse(raw);
            if (j && Array.isArray(j.problems)) all.push(...j.problems);
          } catch {}
        }
        for (const p of all){
        const stem = String(p && p.stem || '').trim();
        const options = Array.isArray(p && p.options) ? p.options.slice(0,4).map(String) : [];
        const correct = Math.max(0, Math.min(3, Number(p && p.correct || 0)));
        const explanation = String(p && p.explanation || '').trim();
        if (!stem || options.length !== 4) continue;
        const key = normalizeStem(stem);
        if (seen.has(key)) continue; seen.add(key);
        const sourceHash = sha256Hex(lessonSlug + '||' + stem + '||' + options.join('||'));
        const difficulty = computeDifficulty(stem, explanation);
          // optional visuals
          let graph = undefined;
          try {
            if (p && p.graph && Array.isArray(p.graph.expressions)){
              const exprs = p.graph.expressions
                .filter(Boolean)
                .slice(0, 12)
                .map(e => {
                  if (e && typeof e === 'object'){
                    if (typeof e.latex === 'string') return { id: e.id || undefined, latex: e.latex };
                    if (e.type === 'point' && typeof e.x === 'number' && typeof e.y === 'number') return { type: 'point', x: e.x, y: e.y, id: e.id || undefined };
                  }
                  return null;
                })
                .filter(Boolean);
              if (exprs.length) graph = { expressions: exprs };
            }
          } catch {}
          // Synthesize graph from coordinates if missing
          if (!graph || !Array.isArray(graph.expressions) || graph.expressions.length === 0){
            const allText = [stem, ...options].join(' ');
            const coords = extractCoordinatePairsFromText(allText).slice(0, 12);
            if (coords.length){
              const exprs = coords.map((pt, i) => ({ type: 'point', x: pt.x, y: pt.y, id: `pt${i}` }));
              graph = { expressions: exprs };
            }
          }
          let table = undefined;
          try {
            if (p && p.table && Array.isArray(p.table.rows)){
              const headers = Array.isArray(p.table.headers) ? p.table.headers.slice(0,10).map(String) : undefined;
              const rows = p.table.rows.slice(0, 20).map(r => (Array.isArray(r)? r.slice(0,10) : []).map(String));
              if (rows.length) table = { headers, rows };
            }
          } catch {}
          let numberLine = undefined;
          try {
            if (p && p.numberLine && typeof p.numberLine === 'object'){
              const nl = p.numberLine;
              const norm = {
                min: typeof nl.min === 'number' ? nl.min : 0,
                max: typeof nl.max === 'number' ? nl.max : 10,
                step: typeof nl.step === 'number' ? nl.step : undefined,
                points: Array.isArray(nl.points) ? nl.points.slice(0,20).map(pt => {
                  if (typeof pt === 'number') return pt;
                  if (pt && typeof pt.x === 'number') return { x: pt.x, label: pt.label ? String(pt.label) : undefined, open: !!pt.open };
                  return null;
                }).filter(Boolean) : undefined,
                intervals: Array.isArray(nl.intervals) ? nl.intervals.slice(0,10).map(iv => ({
                  from: Number(iv.from), to: Number(iv.to),
                  openLeft: !!iv.openLeft, openRight: !!iv.openRight,
                  label: iv.label ? String(iv.label) : undefined
                })) : undefined
              };
              numberLine = norm;
            }
          } catch {}
        docs.push({
          lessonSlug,
          lessonTitle,
            book,
            stem, options, correct, solution: explanation,
            answer: options[correct] || '',
            answerPlain: stripLatexToPlain(options[correct] || ''),
            graph, table, numberLine,
          citations: [],
          difficulty,
          sourceHash,
          generatedAt: new Date().toISOString(),
          generator: 'agent1'
        });
          if (docs.length >= target) break;
        }
      }
      // Replace old questions for this lesson
      const del = await col.deleteMany({ lessonSlug });
      if (docs.length) {
        await col.insertMany(docs, { ordered: false });
      }
      await client.close();
      return res.json({ ok:true, deleted: del.deletedCount || 0, inserted: docs.length, attempts });
    } catch (e){ console.error(e); return res.status(500).json({ error:'generation_failed' }); }
  });

  // Agent 2: Retrieve random 10 for a lesson
  app.get('/ai/agent2/questions', async (req, res) => {
    const lessonSlug = String(req.query.lesson || '').trim();
    const n = Math.max(1, Math.min(20, Number(req.query.n || 15)));
    const book = String(req.query.book || '').trim();
    if (!lessonSlug) return res.status(400).json({ error: 'lesson (slug) is required' });
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      // target mix ~30% easy, 40% medium, 30% hard (sum to n)
      const calcMix = (total)=>{
        const e = Math.floor(total * 0.3);
        const h = Math.floor(total * 0.3);
        let m = total - e - h;
        // slight bias toward medium if rounding lost
        if (m < 0) m = 0;
        return { easy: e, medium: m, hard: h };
      };
      const target = calcMix(n);
      const buckets = {};
      for (const [k, size] of Object.entries(target)){
        if (size <= 0) continue;
        const docsK = await col.aggregate([
          { $match: (book ? { lessonSlug, difficulty: k, book } : { lessonSlug, difficulty: k }) },
          { $sample: { size } }
        ]).toArray();
        buckets[k] = docsK;
      }
      let docs = [...(buckets.easy||[]), ...(buckets.medium||[]), ...(buckets.hard||[])];
      if (docs.length < n){
        const remaining = n - docs.length;
        const extra = await col.aggregate([
          { $match: (book ? { lessonSlug, sourceHash: { $nin: docs.map(d=> d.sourceHash) }, book } : { lessonSlug, sourceHash: { $nin: docs.map(d=> d.sourceHash) } }) },
          { $sample: { size: remaining } }
        ]).toArray();
        docs = docs.concat(extra);
      }
      await client.close();
      return res.json({ ok: true, lesson: lessonSlug, count: docs.length, questions: docs });
    } catch (e){ console.error(e); return res.status(500).json({ error:'retrieve_failed' }); }
  });

  // Agent 2 (visual enrichment)
  app.post('/ai/agent2/enrich', async (req, res) => {
    const lessonSlug = String(req.query.lesson || '').trim();
    const limit = Math.max(1, Math.min(60, Number(req.query.limit || 30)));
    if (!lessonSlug) return res.status(400).json({ error: 'lesson (slug) is required' });
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      const docs = await col.find({ lessonSlug }).sort({ generatedAt: -1 }).limit(limit).toArray();
      let updated = 0;
      for (const d of docs){
        const hasVisual = (d.graph && Array.isArray((d.graph||{}).expressions) && d.graph.expressions.length) || (d.table && Array.isArray((d.table||{}).rows) && d.table.rows.length) || !!d.numberLine;
        if (hasVisual) continue;
        const instruction = `You are enhancing a math MC item with minimal visuals only when helpful to solve. If the item doesn't need a visual, return {}. Prefer NONE unless the stem or options explicitly reference a graph, number line, table, histogram, box plot, or dot plot. Input:\n${JSON.stringify({ stem: d.stem, options: d.options, correct: d.correct }, null, 2)}\nReturn STRICT JSON with optional fields only as needed: { "graph"?: { "expressions": Array< { "latex"?: string } | { "type":"point","x":number,"y":number } > }, "table"?: { "headers"?: string[], "rows": string[][] }, "numberLine"?: { "min":number, "max":number, "step"?:number, "points"?: Array<number|{ "x":number, "label"?:string, "open"?:boolean }>, "intervals"?: Array<{ "from":number, "to":number, "openLeft"?:boolean, "openRight"?:boolean, "label"?:string }> } }`;
        const j = await callGeminiJSON('gemini-1.5-flash-8b', instruction);
        if (!j) continue;
        const update = {};
        try {
          if (j.graph && Array.isArray(j.graph.expressions)){
            const exprs = j.graph.expressions.filter(Boolean).slice(0,12).map(e=>{
              if (e && typeof e.latex === 'string') return { latex: e.latex };
              if (e && e.type === 'point' && Number.isFinite(e.x) && Number.isFinite(e.y)) return { type:'point', x:Number(e.x), y:Number(e.y) };
              return null;
            }).filter(Boolean);
            if (exprs.length) update.graph = { expressions: exprs };
          }
        } catch{}
        try {
          if (j.table && Array.isArray(j.table.rows)){
            const headers = Array.isArray(j.table.headers) ? j.table.headers.slice(0,10).map(String) : undefined;
            const rows = j.table.rows.slice(0,20).map(r=> (Array.isArray(r)? r.slice(0,10) : []).map(String));
            if (rows.length) update.table = { headers, rows };
          }
        } catch{}
        try {
          if (j.numberLine && typeof j.numberLine === 'object'){
            const nl = j.numberLine;
            update.numberLine = {
              min: Number(nl.min), max: Number(nl.max), step: typeof nl.step === 'number' ? nl.step : undefined,
              points: Array.isArray(nl.points) ? nl.points.slice(0,20).map(pt=> (typeof pt === 'number')? pt : (pt && Number.isFinite(pt.x) ? { x:Number(pt.x), label: pt.label ? String(pt.label) : undefined, open: !!pt.open } : null)).filter(Boolean) : undefined,
              intervals: Array.isArray(nl.intervals) ? nl.intervals.slice(0,10).map(iv=> ({ from: Number(iv.from), to: Number(iv.to), openLeft: !!iv.openLeft, openRight: !!iv.openRight, label: iv.label ? String(iv.label) : undefined })) : undefined
            };
          }
        } catch{}
        if (Object.keys(update).length){
          if (typeof d.correct === 'number' && Array.isArray(d.options)){
            update.answer = d.options[d.correct] || '';
            update.answerPlain = stripLatexToPlain(update.answer);
          }
          update.enrichedAt = new Date().toISOString();
          await col.updateOne({ _id: d._id }, { $set: update });
          updated++;
        }
      }
      await client.close();
      return res.json({ ok:true, lesson: lessonSlug, updated });
    } catch (e){ console.error(e); return res.status(500).json({ error:'enrich_failed' }); }
  });

  // Agent 3: compile (alias to Agent 2 retrieval)
  app.get('/ai/agent3/questions', async (req, res) => {
    req.url = req.url.replace('/ai/agent3/questions', '/ai/agent2/questions');
    app._router.handle(req, res, ()=>{});
  });

  // ===== Agent 4: Verification (determine correct index using LLM) =====
  async function agent4DecideCorrectIndex(stem, options){
    try {
      const sanitized = {
        stem: String(stem||'').slice(0, 2000),
        options: (Array.isArray(options)? options : []).slice(0,4).map(o=> String(o||'').slice(0,500))
      };
      if (sanitized.options.length !== 4) return null;
      const instruction = `You are a strict multiple-choice checker. Given a stem and four options (indices 0..3), return STRICT JSON { "correct": number } with the index of the best correct option. If ambiguous, pick the most mathematically correct or most defensible.\n${JSON.stringify(sanitized, null, 2)}`;
      const j = await callGeminiJSON('gemini-1.5-flash-8b', instruction);
      if (j && typeof j.correct === 'number' && j.correct >= 0 && j.correct <= 3) return j.correct;
      return null;
    } catch { return null; }
  }

  // Single-item verify
  app.post('/ai/agent4/verify', async (req, res) => {
    try {
      const { stem, options, correct } = req.body || {};
      if (!Array.isArray(options) || options.length !== 4) return res.status(400).json({ error: 'options[4] required' });
      const decided = await agent4DecideCorrectIndex(stem, options);
      if (decided === null) return res.json({ ok:true, verified: false, reason: 'undecided' });
      const verified = Number(correct) === decided;
      return res.json({ ok:true, verified, decided, provided: Number(correct) });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'verify_failed' }); }
  });

  // Bulk verify for a lesson
  app.post('/ai/agent4/verify-lesson', async (req, res) => {
    const lessonSlug = String(req.query.lesson || '').trim();
    const limit = Math.max(1, Math.min(60, Number(req.query.limit || 30)));
    if (!lessonSlug) return res.status(400).json({ error: 'lesson (slug) is required' });
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      const docs = await col.find({ lessonSlug }).sort({ generatedAt: -1 }).limit(limit).toArray();
      let verifiedCount = 0; let mismatches = 0; let undecided = 0;
      for (const d of docs){
        const decided = await agent4DecideCorrectIndex(d.stem, d.options);
        if (decided === null){ undecided++; continue; }
        const isMatch = Number(d.correct) === decided;
        const update = { verified: isMatch, verifiedAt: new Date().toISOString(), verifiedBy: 'agent4', decidedCorrect: decided };
        if (!isMatch) mismatches++;
        else verifiedCount++;
        await col.updateOne({ _id: d._id }, { $set: update });
      }
      await client.close();
      return res.json({ ok:true, lesson: lessonSlug, verified: verifiedCount, mismatches, undecided });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'verify_lesson_failed' }); }
  });

  // Apply Agent 4 decided corrections to mismatched items
  app.post('/ai/agent4/apply-corrections', async (req, res) => {
    const lessonSlug = req.query.lesson ? String(req.query.lesson).trim() : null;
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      const filter = lessonSlug ? { lessonSlug, decidedCorrect: { $type: 'number' }, verified: { $in: [false, null] } } : { decidedCorrect: { $type: 'number' }, verified: { $in: [false, null] } };
      const cur = col.find(filter).limit(5000);
      let corrected = 0; let inspected = 0;
      while (await cur.hasNext()){
        const d = await cur.next(); inspected++;
        try {
          const idx = Number(d.decidedCorrect);
          if (!Array.isArray(d.options) || idx < 0 || idx > 3) continue;
          const newAnswer = String(d.options[idx] || '');
          const newAnswerPlain = stripLatexToPlain(newAnswer);
          await col.updateOne({ _id: d._id }, { $set: {
            correct: idx,
            answer: newAnswer,
            answerPlain: newAnswerPlain,
            verified: true,
            verifiedBy: 'agent4-auto',
            correctedAt: new Date().toISOString()
          } });
          corrected++;
        } catch {}
      }
      await client.close();
      return res.json({ ok: true, inspected, corrected, lesson: lessonSlug || null });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'apply_corrections_failed' }); }
  });

  // Agent 1 stats: counts per lesson
  app.get('/ai/agent1/stats', async (req, res) => {
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      const rows = await col.aggregate([
        { $group: { _id: '$lessonSlug', count: { $sum: 1 }, latest: { $max: '$generatedAt' } } },
        { $project: { lessonSlug: '$_id', _id: 0, count: 1, latest: 1 } },
        { $sort: { lessonSlug: 1 } }
      ]).toArray();
      await client.close();
      return res.json({ ok: true, lessons: rows.length, breakdown: rows });
    } catch (e) { console.error(e); return res.status(500).json({ error: 'stats_failed' }); }
  });

  // Daily refresh runner (Agent 1 regenerate → Agent 2 enrich → Agent 4 verify)
  async function runDailyRefresh(limit, offset){
    const startedAt = new Date();
    const startStrNY = startedAt.toLocaleString('en-US', { timeZone: 'America/New_York', hour12:false });
    console.log(`[refresh] start ${startStrNY}`);
    let total = 0, ok = 0, fail = 0;
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      const existingSlugs = await col.distinct('lessonSlug');
      await client.close();
      // Union with lessons discovered from repository so missing lessons are still refreshed/seeded
      const lessonDefs = tryReadLessonsFromRepo();
      const repoSlugs = Array.isArray(lessonDefs) ? lessonDefs.map(l => l.slug).filter(Boolean) : [];
      const allSlugs = Array.from(new Set([...(repoSlugs||[]), ...(existingSlugs||[]) ]));
      const baseUrl = (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim()) || `http://127.0.0.1:${process.env.PORT||8080}`;
      const off = Math.max(0, Number(offset||0) || 0);
      const lim = Math.max(1, Number(limit||0) || (allSlugs.length - off) || 200);
      const slice = allSlugs.slice(off, off + lim);
      total = slice.length;
      console.log(`[refresh] planning ${total} lessons (offset=${off}, limit=${lim})`);
      for (const slug of slice){
        try {
        const book = resolveBookForLessonFromRepo(slug);
        const url1 = `${baseUrl}/ai/agent1/generate?lesson=${encodeURIComponent(slug)}${book?`&book=${encodeURIComponent(book)}`:''}`;
        const r1 = await fetch(url1, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title: slug, book }) });
          if (!r1.ok) throw new Error(`agent1 ${r1.status}`);
          try { await fetch(`${baseUrl}/ai/agent2/enrich?lesson=${encodeURIComponent(slug)}`, { method:'POST' }); } catch {}
          try { await fetch(`${baseUrl}/ai/agent4/verify-lesson?lesson=${encodeURIComponent(slug)}`, { method:'POST' }); } catch {}
          ok++;
        } catch (e){ fail++; console.error(`[refresh] ${slug} failed: ${String(e).slice(0,200)}`); }
      }
    } catch (e){
      console.error('[refresh] fatal', e);
    }
    const endedAt = new Date();
    console.log(`[refresh] end ok=${ok} fail=${fail} total=${total} durationMs=${endedAt - startedAt}`);
    return { ok, fail, total, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() };
  }

  // Expose manual trigger endpoint
  app.post('/ai/refresh-daily', async (req, res) => {
    try {
      const limit = Number(req.query.limit || 0) || undefined;
      const offset = Number(req.query.offset || 0) || 0;
      const result = await runDailyRefresh(limit, offset);
      return res.json({ ok: true, ...result });
    } catch (e){
      console.error(e);
      return res.status(500).json({ error: 'refresh_failed' });
    }
  });

  // Scheduled loop: runs once per NY date at configured hour (default 15 → 3PM)
  (function scheduleDailyRefresh(){
    let lastRunDateNY = null;
    const refreshHour = Math.max(0, Math.min(23, Number(process.env.REFRESH_HOUR_NY || 15)));
    async function maybeRun(){
      try {
        const now = new Date();
        const nyStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12:false });
        const [mdy, hms] = nyStr.split(',');
        const hour = parseInt((hms||'').trim().split(':')[0]||'0',10);
        const dateOnly = (mdy||'').trim();
        if (hour === refreshHour && lastRunDateNY !== dateOnly){
          lastRunDateNY = dateOnly;
          console.log(`[refresh] trigger ${dateOnly} @ ${hour}:00 NY`);
          await runDailyRefresh();
        }
      } catch (e){ console.error('[refresh] maybeRun error', e); }
    }
    setInterval(maybeRun, 10 * 60 * 1000); // every 10 minutes
  })();

  // ===== Lesson extractor and bulk seeding =====
  function tryReadLessonsFromRepo(){
    const candidates = [
      path.resolve(__dirname, '../problem-sets.html'),
      path.resolve(__dirname, '../../problem-sets.html'),
      path.resolve(process.cwd(), 'problem-sets.html')
    ];
    for (const p of candidates){
      try {
        const txt = fs.readFileSync(p, 'utf8');
        // Match objects like { slug:'...', title:'...' }
        const re = /\{\s*slug:\s*'([^']+)'\s*,\s*title:\s*'([^']+)'/g;
        const out = [];
        let m; while ((m = re.exec(txt))){ out.push({ slug: m[1], title: m[2] }); }
        if (out.length) return out;
      } catch {}
    }
    return [];
  }

  // Infer parent course id (book) for a lesson slug by scanning the repository lesson definitions
  function resolveBookForLessonFromRepo(lessonSlug){
    try {
      const candidates = [
        path.resolve(__dirname, '../problem-sets.html'),
        path.resolve(__dirname, '../../problem-sets.html'),
        path.resolve(process.cwd(), 'problem-sets.html')
      ];
      for (const p of candidates){
        try {
          const txt = fs.readFileSync(p, 'utf8');
          const pos = txt.indexOf(`slug:'${lessonSlug}'`);
          if (pos < 0) continue;
          const pre = txt.slice(0, pos);
          // Find the last course block header before this slug
          // Pattern: { id:'<courseId>', title:'...', subtopics:[
          const re = /\{\s*id:\s*'([^']+)'\s*,\s*title:\s*'[^']+'\s*,\s*subtopics\s*:\s*\[/g;
          let m, last = null;
          while ((m = re.exec(pre))) { last = m[1]; }
          if (last) return last;
        } catch {}
      }
    } catch {}
    return null;
  }

  app.get('/ai/lessons', (req, res)=>{
    const lessons = tryReadLessonsFromRepo();
    return res.json({ ok:true, count: lessons.length, lessons });
  });

  app.post('/ai/seed-all', async (req, res)=>{
    try {
      const lessons = tryReadLessonsFromRepo();
      if (!lessons.length) return res.status(404).json({ error:'no_lessons_found' });
      const target = Math.max(30, Number(req.query.target||0) || 30);
      const limit = 4; // concurrency
      let idx = 0, okCount = 0, failCount = 0;
      const baseUrl = (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim()) || `http://127.0.0.1:${process.env.PORT||8080}`;
      const errors = [];
      async function worker(){
        while (idx < lessons.length){
          const i = idx++;
          const { slug, title } = lessons[i];
          try {
            const r = await fetch(`${baseUrl}/ai/agent1/generate?lesson=${encodeURIComponent(slug)}&target=${target}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title }) });
            if (!r.ok) { failCount++; const t = await r.text().catch(()=> ''); errors.push({ slug, status:r.status, body:t.slice(0,200) }); }
            else {
              try { await fetch(`${baseUrl}/ai/agent2/enrich?lesson=${encodeURIComponent(slug)}`, { method:'POST' }); } catch {}
              try { await fetch(`${baseUrl}/ai/agent4/verify-lesson?lesson=${encodeURIComponent(slug)}`, { method:'POST' }); } catch {}
              okCount++;
            }
          } catch (e) { failCount++; errors.push({ slug, error: String(e).slice(0,200) }); }
        }
      }
      await Promise.all(new Array(limit).fill(0).map(worker));
      return res.json({ ok:true, seeded: okCount, failed: failCount, total: lessons.length, baseUrlUsed: baseUrl, errors });
    } catch (e){ console.error(e); return res.status(500).json({ error:'seed_failed' }); }
  });

  const port = PORT || 8080;
  app.listen(port, () => console.log(`Auth API listening on ${port}`));
}

bootstrap().catch(err => { console.error('Bootstrap error', err); process.exit(1); });
