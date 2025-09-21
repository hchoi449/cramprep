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

  // ===== Agent pipeline: Question Generation (Agent 1) and Serving (Agent 2) =====
  const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URI;
  const QUESTIONS_DB = 'thinkpod';
  const QUESTIONS_COL = 'questionbank';
  const INGEST_COL = 'textbook_chunks';

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

  function sha256Hex(input){
    return crypto.createHash('sha256').update(input).digest('hex');
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
  "table"?: { "headers"?: string[], "rows": string[][] }
}\n${rules}\nNotes: If the source contains tables or describes data, include a concise table under "table". If a graph is implied or useful (lines, parabolas, plotted points), include a minimal set of Desmos-compatible expressions under "graph.expressions".\nReturn STRICT JSON: { "problems": [ ... ] }`;
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
      // Prefer ingested chunks for the lesson, fall back to model-only
      const chunks = await ing.find({ $or:[ { lessonSlug }, { lessonSlug: null } ] }).limit(500).toArray();
      const contextText = chunks && chunks.length ? chunks.slice(0,40).map(c=> `p.${c.page}: ${c.text}`).join('\n\n') : '';
      while (docs.length < target && attempts < maxAttempts){
        attempts++;
        const need = target - docs.length;
        const batches = Math.min(4, Math.max(1, Math.ceil(need / perBatch)));
        const prompts = new Array(batches).fill(0).map(()=> {
          const base = buildLessonPrompt(lessonTitle, lessonSlug, perBatch);
          return contextText ? `${base}\n\nUse this textbook context (extract key facts, captions, tables, graphs):\n${contextText.substring(0, 8000)}` : base;
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
        docs.push({
          lessonSlug,
          lessonTitle,
          stem, options, correct, solution: explanation,
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
    const n = Math.max(1, Math.min(20, Number(req.query.n || 10)));
    if (!lessonSlug) return res.status(400).json({ error: 'lesson (slug) is required' });
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      // target mix 3 easy, 4 medium, 3 hard
      const target = { easy:3, medium:4, hard:3 };
      const buckets = {};
      for (const [k, size] of Object.entries(target)){
        if (size <= 0) continue;
        const docsK = await col.aggregate([
          { $match: { lessonSlug, difficulty: k } },
          { $sample: { size } }
        ]).toArray();
        buckets[k] = docsK;
      }
      let docs = [...(buckets.easy||[]), ...(buckets.medium||[]), ...(buckets.hard||[])];
      if (docs.length < n){
        const remaining = n - docs.length;
        const extra = await col.aggregate([
          { $match: { lessonSlug, sourceHash: { $nin: docs.map(d=> d.sourceHash) } } },
          { $sample: { size: remaining } }
        ]).toArray();
        docs = docs.concat(extra);
      }
      await client.close();
      return res.json({ ok: true, lesson: lessonSlug, count: docs.length, questions: docs });
    } catch (e){ console.error(e); return res.status(500).json({ error:'retrieve_failed' }); }
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

  // Nightly (3AM EST) refresh loop
  (function scheduleNightlyRefresh(){
    let lastRunDateNY = null;
    async function maybeRun(){
      try {
        const now = new Date();
        const nyStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12:false });
        const [mdy, hms] = nyStr.split(',');
        const hour = parseInt((hms||'').trim().split(':')[0]||'0',10);
        const dateOnly = (mdy||'').trim();
        if (hour === 3 && lastRunDateNY !== dateOnly){
          lastRunDateNY = dateOnly;
          const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
          await client.connect();
          const col = await getQuestionCollection(client);
          const slugs = await col.distinct('lessonSlug');
          await client.close();
          const baseUrl = (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim()) || `http://127.0.0.1:${process.env.PORT||8080}`;
          for (const slug of slugs.slice(0,200)){
            try { await fetch(`${baseUrl}/ai/agent1/generate?lesson=${encodeURIComponent(slug)}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title: slug }) }); } catch {}
          }
        }
      } catch {}
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
            else { okCount++; }
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
