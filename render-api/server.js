const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { createCanvas, loadImage } = require('canvas');
const Tesseract = require('tesseract.js');
const { MongoClient, ObjectId } = require('mongodb');
const FormDataLib = require('form-data');
const FormData = require('form-data');

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
  // Teachers collection helper
  const TEACHERS_COL = process.env.MONGODB_COLLECTION_TEACHERS || 'teachers';
  const SCHOOLS_COL = process.env.MONGODB_COLLECTION_SCHOOLS || 'schools';
  const SCHOOLS_DB = process.env.MONGODB_DATABASE_SCHOOLS || 'school';
  async function getTeachersCollection(mongoClient){ return mongoClient.db(STUD_DB).collection(TEACHERS_COL); }
  async function getSchoolsCollection(mongoClient){ return mongoClient.db(SCHOOLS_DB).collection(SCHOOLS_COL); }
  // Serve preprocessed assets
  app.use('/tmp/uploads', express.static(path.resolve(__dirname, '../tmp_uploads')));

  app.get('/auth/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

  // Search schools by name (q)
  app.get('/ai/schools', async (req, res) => {
    try {
      const q = String(req.query.q||'').trim();
      const limit = Math.max(1, Math.min(50, Number(req.query.limit||50)));
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getSchoolsCollection(client);

      // Coalesce from multiple fields, trim, filter empties, dedupe, sort
      const coalesce = {
        $trim: { input: {
          $ifNull: [
            "$name",
            { $ifNull: [ "$school.schools.name", { $ifNull: [ "$school_name", { $ifNull: [ "$school", "$NAME" ] } ] } ] }
          ]
        } }
      };

      const pipeline = [
        { $addFields: { _coalescedName: coalesce } },
        { $match: { _coalescedName: { $type: "string", $ne: "" } } },
      ];
      if (q) {
        const rx = q.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        pipeline.push({ $match: { _coalescedName: { $regex: rx, $options: 'i' } } });
      }
      pipeline.push(
        { $group: { _id: "$_coalescedName" } },
        { $sort: { _id: 1 } },
        { $limit: limit },
        { $project: { _id: 0, name: "$_id" } }
      );

      const docs = await col.aggregate(pipeline).toArray();
      await client.close();
      return res.json({ ok:true, schools: docs.map(d => d.name) });
    } catch (e){ console.error('[schools] exception', e); return res.status(500).json({ error:'schools_exception' }); }
  });

  // Search teachers by school (and optional query q)
  app.get('/ai/teachers', async (req, res) => {
    try {
      const school = String(req.query.school||'').trim();
      const q = String(req.query.q||'').trim();
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getTeachersCollection(client);
      const filter = {};
      if (school) filter.school = school;
      if (q) filter.name = { $regex: q.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), $options:'i' };
      const names = await col.find(filter).project({ _id:0, name:1 }).limit(50).toArray();
      await client.close();
      return res.json({ ok:true, teachers: names.map(n => n.name) });
    } catch (e){ console.error('[teachers] exception', e); return res.status(500).json({ error:'teachers_exception' }); }
  });

  // AI fallback: suggest teacher names for a school (best-effort; may be inaccurate)
  app.post('/ai/teachers/ai', async (req, res) => {
    try {
      const school = String((req.body && req.body.school) || req.query.school || '').trim();
      const subject = String((req.body && req.body.subject) || req.query.subject || 'math').trim();
      if (!school) return res.status(400).json({ error:'school required' });
      const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;

      // Enrich school with city/state from DB if available
      let schoolForPrompt = school;
      try {
        const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
        await client.connect();
        const col = await getSchoolsCollection(client);
        const coalesceName = { $trim: { input: { $ifNull: [ "$name", { $ifNull: [ "$school.schools.name", { $ifNull: [ "$school_name", { $ifNull: [ "$school", "$NAME" ] } ] } ] } ] } } };
        const coalesceCity = { $trim: { input: { $ifNull: [ "$city", "$CITY" ] } } };
        const coalesceState = { $trim: { input: { $ifNull: [ "$state", "$STATE" ] } } };
        const rx = school.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const doc = await col.aggregate([
          { $addFields: { _name: coalesceName, _city: coalesceCity, _state: coalesceState } },
          { $match: { _name: { $type: 'string', $ne: '' }, _name: { $regex: rx, $options: 'i' } } },
          { $project: { _id:0, name: '$_name', city: '$_city', state: '$_state' } },
          { $limit: 1 }
        ]).toArray();
        if (doc && doc[0]){
          const d = doc[0];
          const parts = [d.name, d.city || null, d.state || null].filter(Boolean);
          if (parts.length) schoolForPrompt = parts.join(', ');
        }
        await client.close();
      } catch {}

      // 1) Try web lookup + scrape for a faculty directory and extract Math/Science names
      async function httpGet(url){
        try{
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (ThinkBigPrep)' } });
          if (!r.ok) return '';
          return await r.text();
        } catch { return ''; }
      }
      function stripTags(html){ return String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&[^;]+;/g,' ').replace(/\s+/g,' ').trim(); }
      function extractTeachersFromText(text){
        const t = String(text||'').toLowerCase();
        const keep = /(math|algebra|geometry|calculus|stem|science|biology|chemistry|physics)/i;
        const out = new Set();
        // Scan for lines around keywords and pull Title Case names nearby
        const words = text.split(/\s+/);
        for (let i=0;i<words.length;i++){
          const w = words[i];
          if (keep.test(w)){
            // search window around keyword for Title Case names (2-3 tokens)
            for (let j=Math.max(0,i-12); j<Math.min(words.length,i+12); j++){
              const n1 = words[j], n2 = words[j+1], n3 = words[j+2];
              const title = (s)=> /^[A-Z][a-z]+$/.test(s||'');
              if (title(n1) && title(n2)){
                const name = [n1,n2, (title(n3)? n3: null)].filter(Boolean).join(' ');
                if (name.length>=5) out.add(name);
              }
            }
          }
        }
        // Deduplicate similar names by lowercase
        return Array.from(out).slice(0,10);
      }
      async function searchDirectoryUrls(q){
        const enc = encodeURIComponent(q + ' faculty staff directory');
        const html = await httpGet('https://duckduckgo.com/html/?q='+enc);
        const links = [];
        html.replace(/<a[^>]+href=\"(https?:[^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi, (m,href)=>{
          try{
            const u = new URL(href);
            const h = u.hostname.toLowerCase();
            const p = u.pathname.toLowerCase();
            if ((/faculty|staff|directory|departments/.test(p) || /faculty|staff|schools/.test(h)) && !/duckduckgo|google|bing/.test(h)){
              links.push(href);
            }
          }catch{}
          return m;
        });
        // Keep a few unique domains
        const seen = new Set(); const uniq=[];
        for (const u of links){ const host = (new URL(u)).hostname; if (!seen.has(host)){ seen.add(host); uniq.push(u); } }
        return uniq.slice(0,4);
      }

      let scraped = [];
      try{
        const cands = await searchDirectoryUrls(schoolForPrompt);
        for (const url of cands){
          const html = await httpGet(url);
          const txt = stripTags(html);
          const names = extractTeachersFromText(txt);
          if (names && names.length){ scraped = names; break; }
        }
      }catch{}
      if (scraped.length){ return res.json({ ok:true, teachers: scraped, source:'web', school: schoolForPrompt }); }

      // 2) Fall back to OpenAI JSON-only extraction
      if (!openaiKey) return res.status(500).json({ error:'missing_OPENAI_API_KEY' });
      const OpenAI = require('openai');
      const oai = new OpenAI({ apiKey: openaiKey });
      const sys = 'Return ONLY strict JSON matching this schema: {"teachers": ["string"]}. No prose, no markdown, no code fences. If uncertain, return {"teachers": []}. Output at most 10 unique names. Use title case full names. Exclude departments, roles, administrators, and non-teachers.';
      const subjectForPrompt = 'math or science';
      const user = `Use the fed school name and look up the official faculty/staff directory for: "${schoolForPrompt}". Extract ${subjectForPrompt} teachers' names (first and last). Return ONLY: {"teachers": ["Name 1","Name 2",...]}.`;

      let out = { teachers: [] };
      try {
        const rsp = await oai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [ { role:'system', content: sys }, { role:'user', content: user } ],
          temperature: 0,
          max_tokens: 300,
          response_format: { type: 'json_object' }
        });
        const text = rsp && rsp.choices && rsp.choices[0] && rsp.choices[0].message && rsp.choices[0].message.content || '';
        try { out = JSON.parse(text); } catch {}
      } catch (e) {
        console.error('[teachers-ai] openai', e && e.message || e);
      }
      const arr = Array.isArray(out && out.teachers) ? out.teachers.filter(Boolean).map(String).slice(0,10) : [];
      return res.json({ ok:true, teachers: arr, source:'ai', school: schoolForPrompt });
    } catch (e){ console.error('[teachers-ai] exception', e); return res.status(500).json({ error:'teachers_ai_exception' }); }
  });

  // Preprocess endpoint: accept a PDF or image URL, produce cleaned PNG(s)
  app.post('/ai/worksheet/preprocess', async (req, res) => {
    try {
      const { url, dpi } = req.body || {};
      if (!url) return res.status(400).json({ error:'url required' });
      const workDir = path.resolve(__dirname, `../tmp_pre_${Date.now()}`);
      fs.mkdirSync(workDir, { recursive: true });
      const r = await fetch(url);
      if (!r.ok) return res.status(400).json({ error:'fetch_failed' });
      const ab = await r.arrayBuffer();
      const buf = Buffer.from(ab);
      const isPdf = /\.pdf($|\?|#)/i.test(url) || (buf[0]===0x25 && buf[1]===0x50 && buf[2]===0x44 && buf[3]===0x46);
      const outPngs = [];
      if (isPdf){
        const pdfPath = path.join(workDir, 'input.pdf');
        fs.writeFileSync(pdfPath, buf);
        const { spawnSync } = require('child_process');
        const resP = spawnSync('pdftoppm', ['-png', '-r', String(dpi||300), pdfPath, path.join(workDir, 'page')], { encoding:'utf8' });
        if (resP.status === 0){
          for (const f of fs.readdirSync(workDir)) if (/page-?\d+\.png$/i.test(f)) outPngs.push(path.join(workDir, f));
          outPngs.sort();
        }
      } else {
        const imgPath = path.join(workDir, 'input');
        fs.writeFileSync(imgPath, buf);
        outPngs.push(imgPath);
      }
      // Clean each image (deskew/normalize) best-effort with ImageMagick
      const publicDir = path.resolve(__dirname, '../tmp_uploads');
      try { fs.mkdirSync(publicDir, { recursive:true }); } catch{}
      const urls = [];
      for (const p of outPngs){
        try {
          const base = path.basename(p).replace(/\.[^.]+$/, '') + '.png';
          const out = path.join(publicDir, `${Date.now()}_${base}`);
          const { spawnSync } = require('child_process');
          spawnSync('convert', [p, '-deskew', '40%', '-strip', '-colorspace', 'Gray', '-normalize', out]);
          const baseUrl = (req.headers['x-forwarded-proto'] ? `${req.headers['x-forwarded-proto']}` : 'https') + '://' + (req.headers['x-forwarded-host'] || req.headers.host);
          urls.push(`${baseUrl}/tmp/uploads/${path.basename(out)}`);
        } catch {}
      }
      return res.json({ ok:true, images: urls });
    } catch(e){ console.error('[preprocess] exception', e); return res.status(500).json({ error:'preprocess_exception', detail:String(e && e.message || e) }); }
  });

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

  // AI proxy to avoid exposing API keys in client (supports Gemini and OpenAI)
  app.post('/ai/generate', async (req, res) => {
    try {
      const { model, contents, generationConfig } = req.body || {};
      const defaultModel = (process.env.TBP_DEFAULT_MODEL || '').trim() || 'gemini-1.5-pro';
      const useModel = (model && typeof model === 'string' ? model : defaultModel);

      // OpenAI branch: model like "openai:gpt-4o-mini"
      if (String(useModel).toLowerCase().startsWith('openai:')) {
        const openaiModel = String(useModel).split(':', 2)[1] || 'gpt-4o-mini';
        const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
        if (!openaiKey) return res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });

        // Map Gemini-like contents → OpenAI chat messages
        const messages = Array.isArray(contents) ? contents.map((m) => {
          const role = (m && m.role === 'user') ? 'user' : 'assistant'; // treat 'model' as 'assistant'
          const parts = Array.isArray(m && m.parts) ? m.parts : [];
          const text = parts.map((p) => (p && typeof p.text === 'string') ? p.text : '').filter(Boolean).join('\n\n');
          return text ? { role, content: text } : null;
        }).filter(Boolean) : [];

        const temperature = (generationConfig && typeof generationConfig.temperature === 'number') ? generationConfig.temperature : 0.3;
        const top_p = (generationConfig && typeof generationConfig.topP === 'number') ? generationConfig.topP : 0.8;

        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`
          },
          body: JSON.stringify({
            model: openaiModel,
            messages,
            temperature,
            top_p,
            n: 1
          })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = (j && j.error && (j.error.message || j.error)) || 'upstream_error';
          return res.status(r.status || 500).json({ error: String(msg) });
        }
        const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        // Normalize to Gemini-like response shape expected by the clients
        return res.json({ candidates: [ { content: { parts: [ { text } ] } } ] });
      }

      // Gemini branch (default)
      const geminiKey = process.env.GEMINI_API_KEY || process.env.gemini_api_key || process.env.GOOGLE_GEMINI_API_KEY;
      if (!geminiKey) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
      const gemModel = useModel || 'gemini-1.5-pro';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gemModel)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig })
      });
      const text = await upstream.text();
      return res.status(upstream.status).type('application/json').send(text);
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
      const pMediumEnv = Number(process.env.TBP_ADAPT_START_MEDIUM_PCT);
      const pMedium = Number.isFinite(pMediumEnv) ? Math.max(0, Math.min(1, pMediumEnv)) : (Number.isFinite(Number(req.query.p_medium)) ? Math.max(0, Math.min(1, Number(req.query.p_medium))) : 0.7);
      const startBand = (Math.random() < pMedium) ? 'medium' : 'easy';
      const doc = { lessonSlug, count: 0, used: [], createdAt: now, updatedAt: now, currentBand: startBand, countCorrect: 0, countTotal: 0 };
      const r = await sess.insertOne(doc);
      await client.close();
      return res.status(201).json({ ok: true, sessionId: String(r.insertedId), count: 0, target: 10, current_band: startBand, count_correct: 0, count_total: 0 });
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
      const total = Number(doc.countTotal || 0) + 1;
      const correctCt = Number(doc.countCorrect || 0) + (correct ? 1 : 0);
      await sess.updateOne({ _id }, { $set: { count: nextCount, used, updatedAt: new Date().toISOString(), countTotal: total, countCorrect: correctCt } });
      await client.close();
      return res.json({ ok: true, count: nextCount, finished: nextCount >= 10, count_total: total, count_correct: correctCt });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'session_answer_failed' }); }
  });

  // Get current session state
  app.get('/ai/session/state', async (req, res) => {
    try {
      const sessionId = String(req.query.session || '').trim();
      if (!sessionId) return res.status(400).json({ error: 'session id is required' });
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const sess = await getSessionCollection(client);
      const _id = new ObjectId(sessionId);
      const doc = await sess.findOne({ _id });
      await client.close();
      if (!doc) return res.status(404).json({ error: 'session_not_found' });
      // sanitize internal fields if any
      const { countCorrect, countTotal, currentBand } = doc || {};
      return res.json({ ok: true, session: { id: String(doc._id), ...doc, _id: undefined, count_correct: countCorrect||0, count_total: countTotal||0, current_band: currentBand||'medium' } });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'session_state_failed' }); }
  });

  // Adaptive next question with banding and no repeats
  app.post('/ai/session/next', async (req, res) => {
    try {
      const sessionId = String(req.query.session || '').trim();
      const lessonSlug = String(req.query.lesson || '').trim();
      const book = String(req.query.book || '').trim();
      if (!sessionId && !lessonSlug) return res.status(400).json({ error: 'session or lesson is required' });
      const payload = req.body || {};
      const last = payload.last || null; // { questionId, sourceHash, is_correct }
      const nowIso = new Date().toISOString();

      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const sessCol = await getSessionCollection(client);
      let sessDoc = null; let sessIdObj = null;
      if (sessionId){
        try { sessIdObj = new ObjectId(sessionId); } catch {}
        if (sessIdObj) sessDoc = await sessCol.findOne({ _id: sessIdObj });
      }
      // If no session found, create a transient one if lesson provided
      if (!sessDoc){
        if (!lessonSlug) { await client.close(); return res.status(404).json({ error: 'session_not_found' }); }
        const pMediumEnv = Number(process.env.TBP_ADAPT_START_MEDIUM_PCT);
        const pMedium = Number.isFinite(pMediumEnv) ? Math.max(0, Math.min(1, pMediumEnv)) : (Number.isFinite(Number(req.query.p_medium)) ? Math.max(0, Math.min(1, Number(req.query.p_medium))) : 0.7);
        const startBand = (Math.random() < pMedium) ? 'medium' : 'easy';
        const init = { lessonSlug, currentBand: startBand, mastery: 0.0, servedIds: [], servedHashes: [], history: [], createdAt: nowIso, updatedAt: nowIso, countCorrect: 0, countTotal: 0 };
        const r = await sessCol.insertOne(init);
        sessIdObj = r.insertedId;
        sessDoc = { _id: r.insertedId, ...init };
      }

      const lesson = lessonSlug || String(sessDoc.lessonSlug || '');
      if (!lesson) { await client.close(); return res.status(400).json({ error: 'lesson (slug) is required' }); }

      // Update session from last answer if provided
      let currentBand = String(sessDoc.currentBand || 'medium');
      let mastery = Number(sessDoc.mastery || 0);
      const servedIds = Array.isArray(sessDoc.servedIds) ? sessDoc.servedIds.map(String).slice(0, 500) : [];
      const servedHashes = Array.isArray(sessDoc.servedHashes) ? sessDoc.servedHashes.map(String).slice(0, 500) : [];
      const history = Array.isArray(sessDoc.history) ? sessDoc.history.slice(0, 500) : [];

      if (last && typeof last === 'object'){
        const isCorrect = !!last.is_correct;
        // mastery update
        mastery = Math.max(-1, Math.min(1, mastery + (isCorrect ? 0.1 : -0.1)));
        // band transition
        const up = { easy: 'medium', medium: 'hard', hard: 'hard' };
        const down = { hard: 'medium', medium: 'easy', easy: 'easy' };
        currentBand = isCorrect ? (up[currentBand] || currentBand) : (down[currentBand] || currentBand);
        // track served
        if (last.questionId){
          const qid = String(last.questionId);
          if (!servedIds.includes(qid)) servedIds.push(qid);
        }
        if (last.sourceHash){
          const sh = String(last.sourceHash);
          if (!servedHashes.includes(sh)) servedHashes.push(sh);
        }
        history.push({ questionId: last.questionId ? String(last.questionId) : undefined, sourceHash: last.sourceHash ? String(last.sourceHash) : undefined, is_correct: isCorrect, band_at_serve: String(sessDoc.currentBand || 'medium'), answered_at: nowIso });
      }

      const qCol = await getQuestionCollection(client);
      const excludeIds = servedIds.filter(Boolean).map(id=>{ try { return new ObjectId(id); } catch { return null; } }).filter(Boolean);
      const excludeHashes = servedHashes.filter(Boolean);

      async function sampleOne(filter){
        const pipeline = [ { $match: filter }, { $sample: { size: 1 } } ];
        const arr = await qCol.aggregate(pipeline).toArray();
        return arr && arr[0] ? arr[0] : null;
      }

      // primary band then fallbacks
      const bands = currentBand === 'hard' ? ['hard','medium','easy'] : (currentBand === 'easy' ? ['easy','medium','hard'] : ['medium','easy','hard']);
      let picked = null;
      for (const b of bands){
        const filter = book ? { lessonSlug: lesson, difficulty: b, book, _id: { $nin: excludeIds }, sourceHash: { $nin: excludeHashes } } : { lessonSlug: lesson, difficulty: b, _id: { $nin: excludeIds }, sourceHash: { $nin: excludeHashes } };
        picked = await sampleOne(filter);
        if (picked) { currentBand = b; break; }
      }
      // if none, try any not served
      if (!picked){
        const filter = book ? { lessonSlug: lesson, book, _id: { $nin: excludeIds }, sourceHash: { $nin: excludeHashes } } : { lessonSlug: lesson, _id: { $nin: excludeIds }, sourceHash: { $nin: excludeHashes } };
        picked = await sampleOne(filter);
      }
      // last resort: any
      if (!picked){
        const filter = book ? { lessonSlug: lesson, book } : { lessonSlug: lesson };
        picked = await sampleOne(filter);
      }

      if (!picked){ await client.close(); return res.status(404).json({ error: 'no_questions_available' }); }

      // update served
      const pickedId = String(picked._id);
      if (!servedIds.includes(pickedId)) servedIds.push(pickedId);
      if (picked.sourceHash && !servedHashes.includes(picked.sourceHash)) servedHashes.push(picked.sourceHash);

      await sessCol.updateOne({ _id: sessIdObj }, { $set: {
        lessonSlug: lesson,
        currentBand,
        mastery,
        servedIds,
        servedHashes,
        lastServedQuestionId: pickedId,
        updatedAt: nowIso,
        history
      } });

      await client.close();
      return res.json({ ok: true, session: String(sessIdObj), band: currentBand, mastery, question: picked });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'session_next_failed' }); }
  });

  // ===== Agent pipeline: Question Generation (Agent 1) and Serving (Agent 2) =====
  const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URI;
  const QUESTIONS_DB = 'thinkpod';
  const QUESTIONS_COL = 'questionbank';
  const INGEST_COL = 'textbook_chunks';
  const SESSIONS_COL = 'practice_sessions';
  const QSOURCES_COL = 'qsources';

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

  async function getLessonStoresCollection(client){
    const col = client.db(QUESTIONS_DB).collection('lesson_vectorstores');
    try {
      await col.createIndex({ lessonSlug: 1 }, { unique: true });
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

  async function getQSourcesCollection(client){
    const col = client.db(QUESTIONS_DB).collection(QSOURCES_COL);
    try {
      await col.createIndex({ lessonSlug: 1, createdAt: -1 });
      await col.createIndex({ sourceHash: 1 }, { unique: false });
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

  // Strict LaTeX sanitizer for rendering (server-side formatting pass)
  function toInlineLatex(text){
    try {
      let s = String(text||'');
      // Replace common Unicode math to LaTeX
      s = s.replace(/[×✕✖]/g, '\\times').replace(/√/g, '\\sqrt').replace(/−/g, '-');
      // If already wrapped (\\( ... \\) or \\[ ... \\]), keep
      if (/^\s*\\\(.*\\\)\s*$/.test(s) || /^\s*\\\[.*\\\]\s*$/.test(s)) return s.trim();
      // If looks non-math, wrap as text
      const looksMath = /[=^_\\]|\d/.test(s);
      const body = looksMath ? s : `\\text{${s.replace(/([{}])/g, '\\$1')}}`;
      return `\\(${body}\\)`;
    } catch { return String(text||''); }
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

  // ---- Canonicalization helpers for options ----
  function gcdInt(a, b){ a = Math.abs(a|0); b = Math.abs(b|0); while (b){ const t = a % b; a = b; b = t; } return a || 1; }
  function parseFractionFromPlain(text){
    try {
      const s = String(text||'').trim();
      // match a/b where a, b are integers, with optional parentheses and spaces
      const m = s.match(/^\(?\s*([+-]?\d+)\s*\)?\s*\/\s*\(?\s*([+-]?\d+)\s*\)?$/);
      if (!m) return null;
      let n = parseInt(m[1],10); let d = parseInt(m[2],10);
      if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
      // normalize sign to numerator only
      if (d < 0) { n = -n; d = -d; }
      // reduce
      const g = gcdInt(n, d);
      n = n / g; d = d / g;
      return { n, d };
    } catch { return null; }
  }
  function canonicalNumberOrFraction(text){
    try {
      const plain = stripLatexToPlain(text);
      const f = parseFractionFromPlain(plain);
      if (f) return { key: `frac:${f.n}/${f.d}`, display: { type:'frac', n:f.n, d:f.d } };
      // try pure number
      const num = parseFloat(plain.replace(/,/g,''));
      if (!Number.isNaN(num)){
        // normalize to string without trailing zeros
        let s = num.toFixed(12);
        s = s.replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1');
        return { key: `num:${s}`, display: { type:'num', s } };
      }
      return { key: `expr:${normalizePlainServer(plain)}`, display: { type:'expr' } };
    } catch { return { key: `expr:${normalizePlainServer(text)}`, display: { type:'expr' } }; }
  }
  function prettyFractionForDisplay(original, n, d){
    try {
      const orig = String(original||'');
      const prefersLatex = /\\(?:d?frac)\s*\{/i.test(orig) || /\$/.test(orig);
      if (prefersLatex) return `\\frac{${n}}{${d}}`;
      return `${n}/${d}`;
    } catch { return `${n}/${d}`; }
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

  function detectRoundingMagnitudeFromStem(stem){
    try {
      const t = String(stem||'').toLowerCase();
      if (!/round/.test(t)) return null;
      if (/nearest\s+thousand/.test(t)) return 1000;
      if (/nearest\s+hundred/.test(t)) return 100;
      if (/nearest\s+ten/.test(t)) return 10;
      return null;
    } catch { return null; }
  }

  function formatNumberWithCommas(n){
    try { return Number(n).toLocaleString('en-US'); } catch { return String(n); }
  }

  function adjustOptionsForRounding(stem, options){
    try {
      const mag = detectRoundingMagnitudeFromStem(stem);
      if (!mag) return options;
      const out = options.slice(0,4).map(String);
      for (let i=0;i<out.length;i++){
        const plain = stripLatexToPlain(out[i]);
        const num = parseNumberLooseServer(plain);
        if (!Number.isNaN(num)){
          const absn = Math.abs(num);
          // Heuristic: tiny single/two-digit numbers in rounding tasks are often malformed distractors – scale them up
          if (absn < 10){
            const scaled = num * mag;
            out[i] = formatNumberWithCommas(Math.round(scaled));
          }
        }
      }
      return out;
    } catch { return options; }
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
      // algebraic expression: bump the last integer constant found (e.g., 2x+3 -> 2x+4)
      {
        const s = String(plain);
        const re = /(-?\d+)/g; let m, last=null; while ((m = re.exec(s))) last = { idx: m.index, val: m[0] };
        if (last && typeof last.idx === 'number'){
          const before = s.slice(0, last.idx);
          const after = s.slice(last.idx + String(last.val).length);
          const nextVal = String(parseInt(last.val,10) + Math.max(1, bump));
          return before + nextVal + after;
        }
      }
      // fallback: append a narrow no-break space + letter to make distinct
      return `${plain}′`; // add prime mark to make visibly distinct
    } catch { return String(text||''); }
  }

  function dedupeOptions(options, correctIdx){
    const out = options.slice(0,4).map(String);
    // First pass: reduce fractions to lowest terms and sign-normalize
    for (let i=0;i<out.length;i++){
      const orig = out[i];
      const plain = stripLatexToPlain(orig);
      const f = parseFractionFromPlain(plain);
      if (f){ out[i] = prettyFractionForDisplay(orig, f.n, f.d); }
    }
    // Ensure uniqueness by canonical equivalence (fraction reduced, sign-normalized; numbers normalized)
    const seen = new Set();
    const makeKey = (s)=> canonicalNumberOrFraction(s).key;
    const reserveKey = makeKey(out[correctIdx]||'');
    seen.add(reserveKey);
    for (let i=0;i<out.length;i++){
      if (i === correctIdx) continue;
      let candidate = out[i];
      // Further normalize rounding-style distractors so small integers like "4" become scaled values
      candidate = adjustOptionsForRounding('', [candidate])[0];
      let key = makeKey(candidate);
      let tries = 0;
      while (seen.has(key) && tries < 12){
        candidate = mutateDistractorForUniqueness(candidate, i+1+tries);
        // if mutation yields a fraction, simplify and sign-normalize again
        const f = parseFractionFromPlain(stripLatexToPlain(candidate));
        if (f) candidate = prettyFractionForDisplay(candidate, f.n, f.d);
        key = makeKey(candidate);
        tries++;
      }
      out[i] = candidate;
      seen.add(key);
    }
    // Final guard: if still not unique by canonical form, force numeric bump on duplicates
    const counts = {};
    const keys = out.map(s=> makeKey(s));
    for (const k of keys){ counts[k] = (counts[k]||0)+1; }
    if (Object.values(counts).some(c=> c>1)){
      for (let i=0;i<out.length;i++){
        if (i===correctIdx) continue;
        const k0 = keys[i];
        if (counts[k0] > 1){
          let cand = out[i];
          let kk = k0; let bump = 2; let guard = 0;
          while (seen.has(kk) && guard < 6){
            cand = mutateDistractorForUniqueness(cand, bump++);
            const f = parseFractionFromPlain(stripLatexToPlain(cand));
            if (f) cand = prettyFractionForDisplay(cand, f.n, f.d);
            // rounding-oriented scaling as last resort
            cand = adjustOptionsForRounding('', [cand])[0];
            kk = makeKey(cand); guard++;
          }
          out[i] = cand; counts[k0]--; counts[kk] = (counts[kk]||0)+1; seen.add(kk);
        }
      }
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
    // Force OpenAI only; do not fallback to Gemini.
    const defaultModel = process.env.TBP_GENERATE_MODEL || process.env.TBP_DEFAULT_MODEL || 'openai:gpt-4o-mini';
    let useModel = model || defaultModel;
    if (!String(useModel).toLowerCase().startsWith('openai:')){
      const def = String(defaultModel).toLowerCase().startsWith('openai:') ? String(defaultModel).split(':',2)[1] : 'gpt-4o-mini';
      useModel = `openai:${def}`;
    }
    const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
    if (!openaiKey) throw new Error('missing_OPENAI_API_KEY');
    const openaiModel = String(useModel).split(':',2)[1] || 'gpt-4o-mini';
    const wantsJson = /return\s+strict\s+json|return\s+json/i.test(String(prompt||''));
    const messages = wantsJson
      ? [
          { role: 'system', content: 'You are a precise JSON generator. Respond with a single JSON object only, no code fences, no prose.' },
          { role: 'user', content: String(prompt||'') }
        ]
      : [ { role:'user', content: String(prompt||'') } ];
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: openaiModel,
        messages,
        temperature: 0.3,
        top_p: 0.8,
        n: 1,
        response_format: wantsJson ? { type: 'json_object' } : undefined
      })
    });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error((j && j.error && (j.error.message||j.error)) || 'openai_upstream_error');
    return (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
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
  // Prefer the specific lesson title; if it's generic (course-level) or empty, fall back to the slug
  const isGenericCourse = (t)=> /^(algebra\s*ii|algebra|pre\s*-?algebra|geometry|pre\s*-?calculus|calculus|chemistry)$/i.test(String(t||'').trim());
  const pickedTitle = (!lessonTitle || isGenericCourse(lessonTitle)) ? String(lessonSlug||'') : String(lessonTitle).trim();
  const selectedTopic = pickedTitle || String(lessonSlug||'');
  // System + schema + explicit topic anchor
  return [
      `Seed: ${seed}`,
      `You are ChatGPT, a large language model trained by OpenAI.`,
      `Follow these rules:`,
      `PRINCIPLES`,
      `1) Be helpful, accurate, and concise.`,
      `2) Always include clear reasoning steps in dedicated fields (not prose outside JSON).`,
      `3) Use LaTeX for ALL math. Inline: \\( ... \\). Display: \\[ ... \\\].`,
    `SELECTED_TOPIC`,
    `- id: ${String(lessonSlug||'')}`,
    `- name: ${selectedTopic}`,
    `CONSTRAINTS`,
    `- Stay strictly on SELECTED_TOPIC; do not drift to general course themes.`,
    `- If textbook context is thin or absent, still generate items ONLY for SELECTED_TOPIC.`,
      `4) Before finalizing, simulate a regex check to ensure:`,
      `   - All math is wrapped in \\( ... \\) or \\[ ... \\\].`,
      `   - No raw LaTeX appears outside those delimiters.`,
      `   - Inline regex: \\\\(.*?\\\\)  |  Display regex: \\\\[.*?\\\\]`,
      `   If invalid, correct internally, then output the final JSON only.`,
      `TASK`,
      `- Generate EXACTLY 20 multiple-choice questions grounded ONLY in the provided TEXTBOOK CONTEXT and SELECTED_TOPIC objectives.`,
      `- Difficulty order: first 7 = "easy", next 8 = "medium", last 5 = "hard".`,
      `- Difficulty calibration: Top high-school level (honors/AP pre-calc/algebra). Avoid college-only techniques.`,
      `- Each question must cite ≥1 source tag from the context (e.g., "TBK-12#p.143").`,
      `OUTPUT FORMAT (MANDATORY)`,
      `- Output VALID JSON ONLY (no extra prose, no markdown).`,
      `- Conform exactly to the JSON schema provided later.`,
      `LATEX ENFORCEMENT (MANDATORY)`,
      `- All math strings MUST be LaTeX wrapped: \\( ... \\) for inline, \\[ ... \\\] for display.`,
      `- No $...$ fences; no Unicode math symbols (√, ×, −, ², …). Use \\sqrt, \\times, -, ^{2}, etc.`,
      `- Balanced braces; canonical commands (\\frac, \\cdot, \\sqrt, \\left ... \\right, etc.).`,
      `- If an option is textual, still wrap it: \\( \\text{...} \\).`,
      `OPTIONS — COHESIVE BUT VARIANT`,
      `- Produce EXACTLY 4 answer options (A, B, C, D), all in LaTeX (inline).`,
      `- Exactly ONE option is correct; the other three are on-topic, plausible distractors.`,
      `- "Related" = each distractor differs from the correct answer by a small but meaningful step (sign flip, ±1 coefficient/constant, swapped order, boundary slip, typical algebraic slip).`,
      `- "Different" = not cosmetic duplicates; each reflects a distinct misconception.`,
      `- Keep answer type natural to the prompt (scalar, pair, interval, expression).`,
      `REASONING & METADATA`,
      `- Provide both rationale_text (concise English) and rationale_latex (display math with steps).`,
      `- Include option_meta for each choice: is_correct, why_plausible, misconception_tag.`,
      `- Include answer_plain: the correct option in plain ASCII (e.g., "(5a+4)/3").`,
      `CONSISTENCY`,
      `- The option at answer_index MUST be the single is_correct:true and must match answer_plain (same math content).`,
      `- LaTeX must compile and pass the simulated regex check before you output JSON.`,
      `SCHEMA (RETURN JSON THAT MATCHES THIS EXACTLY)`,
      `{
  "lesson_id": "string",
  "lesson_title": "string",
  "topic_id": "string",
  "distribution": { "easy": 7, "medium": 8, "hard": 5 },
  "questions": [
    {
      "id": "string",
      "difficulty": "easy" | "medium" | "hard",
      "stimulus_text": "string",
      "stimulus_latex": "string",
      "stimulus_render": "inline" | "display",
      "answer_type": "scalar" | "pair" | "set" | "interval" | "expression" | "vector" | "matrix",
      "options_latex": ["string","string","string","string"],
      "answer_index": 0 | 1 | 2 | 3,
      "answer_plain": "string",
      "rationale_text": "string",
      "rationale_latex": "string",
      "option_meta": [
        {"index":0,"is_correct":true|false,"why_plausible":"string","misconception_tag":"string"},
        {"index":1,"is_correct":true|false,"why_plausible":"string","misconception_tag":"string"},
        {"index":2,"is_correct":true|false,"why_plausible":"string","misconception_tag":"string"},
        {"index":3,"is_correct":true|false,"why_plausible":"string","misconception_tag":"string"}
      ],
      "sources": ["string"]
    }
  ]
}`,
      `Return JSON only.`
    ].join('\n');
  }

  // One-line fixer prompt (for optional repair flows)
  const FIXER_PROMPT = `You produced items that violate LaTeX/option rules. Repair ONLY the failing items so that: - ALL math is wrapped \\( ... \\) or \\[ ... \\\] (no $...$, no Unicode symbols), - EXACTLY 4 options in LaTeX inline; one correct; three plausible, distinct distractors, - answer_index aligns with is_correct:true AND answer_plain. Return JSON for the corrected items only, in the same schema.`;

  // Ingest textbook PDF (upload by URL) and chunk text
  app.post('/ai/agent1/ingest', async (req, res) => {
    try {
      const { url, lessonSlug, lessonTitle } = req.body || {};
      const q = req.query || {};
      const ocrPagesReq = Number((req.body && req.body.ocrPages) || q.ocrPages || 0) || 0;
      const ocrStartReq = Number((req.body && req.body.ocrStart) || q.ocrStart || 1) || 1;
      const ocrPagesMax = Math.max(1, Math.min(60, ocrPagesReq || 15));
      const ocrStart = Math.max(1, ocrStartReq);
      if (!url) return res.status(400).json({ error: 'url required' });
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getIngestCollection(client);
      const r = await fetch(url);
      if (!r.ok) { await client.close(); return res.status(400).json({ error: 'fetch_failed' }); }
      const buf = Buffer.from(await r.arrayBuffer());
      // Try pdf-parse text first; if empty/short, attempt OCR via tesseract per page image
      const pdf = await pdfParse(buf);
      let text = String((pdf && pdf.text) || '');
      if (!text || text.trim().length < 200) {
        // Fallback OCR: render first N pages to PNG via pdfjs-dist and run Tesseract
        try {
          const pdfjsLib = require('pdfjs-dist');
          const loadingTask = pdfjsLib.getDocument({ data: buf });
          const pdfDoc = await loadingTask.promise;
          const maxPages = Math.min(pdfDoc.numPages || 1, ocrStart + ocrPagesMax - 1);
          let ocrText = '';
          for (let p=ocrStart; p<=maxPages; p++){
            const page = await pdfDoc.getPage(p);
            const viewport = page.getViewport({ scale: 2.0 });
            const canvas = createCanvas(viewport.width, viewport.height);
            const ctx = canvas.getContext('2d');
            const renderContext = { canvasContext: ctx, viewport };
            await page.render(renderContext).promise;
            const png = canvas.toBuffer('image/png');
            const ocr = await Tesseract.recognize(png, 'eng', { logger:()=>{} });
            const pageText = (ocr && ocr.data && ocr.data.text) ? ocr.data.text : '';
            if (pageText) ocrText += `\n\nPage ${p}:\n` + pageText;
            if (ocrText.length > 20000) break; // early stop when enough context gathered
          }
          if (ocrText.trim().length > text.trim().length) text = ocrText;
        } catch {}
      }
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

  // Vector store: upload a file to OpenAI and attach to lesson store (uses backend OPENAI_API_KEY)
  app.post('/ai/files/upload', async (req, res) => {
    try {
      const { url, lessonSlug } = req.body || {};
      if (!url) return res.status(400).json({ error:'url required' });
      const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
      if (!openaiKey) return res.status(500).json({ error:'missing_OPENAI_API_KEY' });
      const rf = await fetch(url);
      if (!rf.ok) return res.status(400).json({ error:'fetch_failed' });
      const buf = Buffer.from(await rf.arrayBuffer());
      const fd = new FormDataLib();
      fd.append('file', buf, { filename: 'lesson.pdf', contentType: 'application/pdf' });
      fd.append('purpose', 'assistants');
      const up = await fetch('https://api.openai.com/v1/files', { method:'POST', headers: { ...fd.getHeaders(), 'Authorization': `Bearer ${openaiKey}` }, body: fd });
      const uj = await up.json().catch(()=>({}));
      if (!up.ok) return res.status(500).json({ error:'upload_failed', detail: uj });

      let vector_store_id = null;
      if (lessonSlug){
        const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        await client.connect();
        const vs = await getLessonStoresCollection(client);
        const rec = await vs.findOne({ lessonSlug });
        const headers = { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' };
        if (rec && rec.vector_store_id){
          vector_store_id = rec.vector_store_id;
        } else {
          const crt = await fetch('https://api.openai.com/v1/vector_stores', { method:'POST', headers, body: JSON.stringify({ name: `lesson:${lessonSlug}` }) });
          const cj = await crt.json().catch(()=>({}));
          if (!crt.ok) { await client.close(); return res.status(500).json({ error:'vector_store_create_failed', detail:cj }); }
          vector_store_id = cj.id;
          await vs.updateOne({ lessonSlug }, { $set: { lessonSlug, vector_store_id, files: [], updatedAt: new Date().toISOString() } }, { upsert: true });
        }
        // attach file
        await fetch(`https://api.openai.com/v1/vector_stores/${vector_store_id}/files`, { method:'POST', headers, body: JSON.stringify({ file_id: uj.id }) });
        await vs.updateOne({ lessonSlug }, { $addToSet: { files: uj.id }, $set:{ updatedAt: new Date().toISOString() } });
        await client.close();
      }
      return res.json({ ok:true, file_id: uj.id, vector_store_id });
    } catch (e){ console.error(e); return res.status(500).json({ error:'upload_exception' }); }
  });

  // Upload a worksheet PDF (multipart), save to tmp, and optionally kick off OCR process to qsources
  app.post('/ai/worksheet/upload', async (req, res) => {
    try {
      const Busboy = require('busboy');
      const busboy = Busboy({ headers: req.headers });
      const tmpDir = path.resolve(__dirname, '../tmp_uploads');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch{}
      let lessonSlug = '';
      let storedPath = '';
      let filename = '';
      await new Promise((resolve, reject) => {
        busboy.on('file', (name, file, info) => {
          filename = info && info.filename ? String(info.filename) : `upload_${Date.now()}.pdf`;
          const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
          storedPath = path.join(tmpDir, safeName);
          const ws = fs.createWriteStream(storedPath);
          file.pipe(ws);
          ws.on('error', reject);
          ws.on('finish', ()=>{});
        });
        busboy.on('field', (name, val) => {
          if (name === 'lessonSlug') lessonSlug = String(val||'').trim();
        });
        busboy.on('error', reject);
        busboy.on('finish', resolve);
        req.pipe(busboy);
      });
      if (!storedPath || !fs.existsSync(storedPath)) return res.status(400).json({ error:'no_file_received' });
      if (!lessonSlug) return res.status(400).json({ error:'lessonSlug required' });
      // Build a local file URL served by tmp route
      const baseUrl = (req.headers['x-forwarded-proto'] ? `${req.headers['x-forwarded-proto']}` : 'https') + '://' + (req.headers['x-forwarded-host'] || req.headers.host);
      const fileUrl = `${baseUrl}/tmp/uploads/${path.basename(storedPath)}`;
      // Optionally: kick off OCR process pipeline now
      return res.json({ ok:true, path: storedPath, url: fileUrl, lessonSlug });
    } catch(e){ console.error('[worksheet-upload] exception', e); return res.status(500).json({ error:'worksheet_upload_exception', detail:String(e && e.message || e) }); }
  });

  // Serve uploaded files from tmp (read-only). Use only for subsequent OCR processing.
  app.get('/tmp/uploads/:name', async (req, res) => {
    try {
      const name = String(req.params.name||'').replace(/[^A-Za-z0-9._-]/g, '_');
      const p = path.resolve(__dirname, '../tmp_uploads', name);
      if (!p.startsWith(path.resolve(__dirname, '../tmp_uploads'))) return res.status(400).end();
      if (!fs.existsSync(p)) return res.status(404).end();
      res.setHeader('Content-Type', 'application/pdf');
      fs.createReadStream(p).pipe(res);
    } catch { return res.status(500).end(); }
  });

  // Vector store (URL-based): fetch URL server-side, upload as multipart to OpenAI, attach to lesson store
  app.post('/ai/files/upload-url', async (req, res) => {
    try {
      const { url, lessonSlug } = req.body || {};
      if (!url) return res.status(400).json({ error:'url required' });
      const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
      if (!openaiKey) return res.status(500).json({ error:'missing_OPENAI_API_KEY' });
      // Download to temp file and stream via form-data (curl-style multipart)
      const rf = await fetch(url);
      if (!rf.ok) return res.status(400).json({ error:'fetch_failed' });
      const arrayBuf = await rf.arrayBuffer();
      const tmpDir = path.resolve(__dirname, '../tmp_uploads');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
      const tmpPath = path.join(tmpDir, `upload_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));

      const FormDataLib = require('form-data');
      const form = new FormDataLib();
      form.append('purpose', 'assistants');
      form.append('file', fs.createReadStream(tmpPath), { filename: 'lesson.pdf', contentType: 'application/pdf' });
      let headers = { ...form.getHeaders(), 'Authorization': `Bearer ${openaiKey}` };
      try { const len = form.getLengthSync(); if (Number.isFinite(len)) headers['Content-Length'] = len; } catch {}
      const up = await fetch('https://api.openai.com/v1/files', { method:'POST', headers, body: form });
      const uj = await up.json().catch(()=>({}));
      if (!up.ok) return res.status(500).json({ error:'upload_failed', detail: uj });

      let vector_store_id = null;
      if (lessonSlug){
        const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        await client.connect();
        const vs = await getLessonStoresCollection(client);
        const rec = await vs.findOne({ lessonSlug });
        const headers = { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' };
        if (rec && rec.vector_store_id){
          vector_store_id = rec.vector_store_id;
        } else {
          const crt = await fetch('https://api.openai.com/v1/vector_stores', { method:'POST', headers, body: JSON.stringify({ name: `lesson:${lessonSlug}` }) });
          const cj = await crt.json().catch(()=>({}));
          if (!crt.ok) { await client.close(); return res.status(500).json({ error:'vector_store_create_failed', detail:cj }); }
          vector_store_id = cj.id;
          await vs.updateOne({ lessonSlug }, { $set: { lessonSlug, vector_store_id, files: [], updatedAt: new Date().toISOString() } }, { upsert: true });
        }
        // attach file to vector store
        await fetch(`https://api.openai.com/v1/vector_stores/${vector_store_id}/files`, { method:'POST', headers, body: JSON.stringify({ file_id: uj.id }) });
        await vs.updateOne({ lessonSlug }, { $addToSet: { files: uj.id }, $set:{ updatedAt: new Date().toISOString() } });
        await client.close();
      }
      return res.json({ ok:true, file_id: uj.id, vector_store_id });
    } catch (e){ console.error('[upload-url] exception', e); return res.status(500).json({ error:'upload_url_exception', detail: String(e && e.message || e) }); }
  });

  // Fallback: use server-side curl to upload file to OpenAI (most reliable multipart)
  app.post('/ai/files/upload-url-curl', async (req, res) => {
    try {
      const { url, lessonSlug } = req.body || {};
      if (!url) return res.status(400).json({ error:'url required' });
      const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
      if (!openaiKey) return res.status(500).json({ error:'missing_OPENAI_API_KEY' });
      const rf = await fetch(url);
      if (!rf.ok) return res.status(400).json({ error:'fetch_failed' });
      const buf = Buffer.from(await rf.arrayBuffer());
      const tmpDir = path.resolve(__dirname, '../tmp_uploads');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
      const tmpPath = path.join(tmpDir, `upload_${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, buf);
      // Use curl
      const { spawnSync } = require('child_process');
      const curlArgs = ['-s', '-X', 'POST', 'https://api.openai.com/v1/files', '-H', `Authorization: Bearer ${openaiKey}`, '-H', 'Content-Type: multipart/form-data', '-F', 'purpose=assistants', '-F', `file=@${tmpPath}`];
      const pr = spawnSync('curl', curlArgs, { encoding: 'utf8' });
      if (pr.status !== 0){
        return res.status(500).json({ error:'curl_failed', detail: pr.stderr || pr.stdout || '' });
      }
      let uj = {}; try { uj = JSON.parse(pr.stdout); } catch { return res.status(500).json({ error:'curl_invalid_json', body: pr.stdout }); }
      if (!uj || !uj.id) return res.status(500).json({ error:'upload_failed', detail: uj });

      let vector_store_id = null;
      if (lessonSlug){
        const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        await client.connect();
        const vs = await getLessonStoresCollection(client);
        const rec = await vs.findOne({ lessonSlug });
        const headers = { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' };
        if (rec && rec.vector_store_id){
          vector_store_id = rec.vector_store_id;
        } else {
          const crt = await fetch('https://api.openai.com/v1/vector_stores', { method:'POST', headers, body: JSON.stringify({ name: `lesson:${lessonSlug}` }) });
          const cj = await crt.json().catch(()=>({}));
          if (!crt.ok) { await client.close(); return res.status(500).json({ error:'vector_store_create_failed', detail:cj }); }
          vector_store_id = cj.id;
          await vs.updateOne({ lessonSlug }, { $set: { lessonSlug, vector_store_id, files: [], updatedAt: new Date().toISOString() } }, { upsert: true });
        }
        await fetch(`https://api.openai.com/v1/vector_stores/${vector_store_id}/files`, { method:'POST', headers, body: JSON.stringify({ file_id: uj.id }) });
        await vs.updateOne({ lessonSlug }, { $addToSet: { files: uj.id }, $set:{ updatedAt: new Date().toISOString() } });
        await client.close();
      }
      return res.json({ ok:true, file_id: uj.id, vector_store_id });
    } catch (e){ console.error('[upload-url-curl] exception', e); return res.status(500).json({ error:'upload_url_curl_exception', detail: String(e && e.message || e) }); }
  });

  // Generate via OpenAI Responses API with file_search tool using the lesson vector store
  app.post('/ai/agent1/generate-assist', async (req, res) => {
    try {
      const lessonSlug = String(req.query.lesson||'').trim();
      const lessonTitle = String((req.body && req.body.title) || req.query.title || lessonSlug).trim();
      if (!lessonSlug) return res.status(400).json({ error:'lesson required' });
      const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
      if (!openaiKey) return res.status(500).json({ error:'missing_OPENAI_API_KEY' });
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const vs = await getLessonStoresCollection(client);
      const rec = await vs.findOne({ lessonSlug });
      await client.close();
      if (!rec || !rec.vector_store_id) return res.status(400).json({ error:'no_vector_store_for_lesson' });
      const files = Array.isArray(rec.files) ? rec.files : [];
      if (!files.length) return res.status(400).json({ error:'no_files_attached_to_vector_store' });
      const file_id = files[files.length - 1];

      const system = 'You are an expert assessment writer. Use file_search to retrieve ONLY relevant passages for the lesson. Return one JSON object only.';
      const user = [
        'SELECTED_TOPIC',
        `- id: ${lessonSlug}`,
        `- name: ${lessonTitle || lessonSlug}`,
        'TASK',
        '- Generate EXACTLY 20 MCQs, each with 4 options in LaTeX (\\( ... \\)). One correct, three plausible near-miss distractors.',
        '- Order: 7 easy, 8 medium, 5 hard.',
        '- Top high-school level.',
        'SCHEMA',
        '{"questions":[{"stimulus_text":"string","stimulus_latex":"string","options_latex":["string","string","string","string"],"answer_index":0,"answer_plain":"string","rationale_text":"string","rationale_latex":"string","sources":["string"]}]}'
      ].join('\n');

      const rsp = await fetch('https://api.openai.com/v1/responses', {
        method:'POST',
        headers:{ 'Authorization': `Bearer ${openaiKey}`, 'Content-Type':'application/json' },
        body: JSON.stringify({
          model:'gpt-4o',
          tools:[{ type:'file_search' }],
          input:[
            { role:'system', content: system },
            { role:'user', content:[ { type:'input_text', text: user }, { type:'file_reference', file_id } ] }
          ]
        })
      });
      const j = await rsp.json().catch(()=>({}));
      if (!rsp.ok) return res.status(500).json({ error:'assist_failed', detail:j });
      const text = j.output_text || '';
      return res.json({ ok:true, preview: text.slice(0,4000) });
    } catch (e){ console.error(e); return res.status(500).json({ error:'assist_exception' }); }
  });

  // Assistants v2: Generate using file_search on the lesson's vector store
  app.post('/ai/agent1/generate-assist-v2', async (req, res) => {
    try {
      const lessonSlug = String(req.query.lesson||'').trim();
      const lessonTitle = String((req.body && req.body.title) || req.query.title || lessonSlug).trim();
      if (!lessonSlug) return res.status(400).json({ error:'lesson required' });
      const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
      if (!openaiKey) return res.status(500).json({ error:'missing_OPENAI_API_KEY' });

      // Fetch lesson vector store + files
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const vsCol = await getLessonStoresCollection(client);
      const rec = await vsCol.findOne({ lessonSlug });
      await client.close();
      if (!rec || !rec.vector_store_id) return res.status(400).json({ error:'no_vector_store_for_lesson' });

      const system = 'You are an expert assessment writer. Use file_search to retrieve ONLY relevant passages for the lesson. Return one JSON object only.';
      const user = [
        'SELECTED_TOPIC',
        `- id: ${lessonSlug}`,
        `- name: ${lessonTitle || lessonSlug}`,
        'TASK',
        '- Generate EXACTLY 20 MCQs, each with 4 options in LaTeX (\\( ... \\)). One correct, three plausible near-miss distractors.',
        '- Order: 7 easy, 8 medium, 5 hard.',
        '- Top high-school level.',
        'SCHEMA',
        '{"questions":[{"stimulus_text":"string","stimulus_latex":"string","options_latex":["string","string","string","string"],"answer_index":0,"answer_plain":"string","rationale_text":"string","rationale_latex":"string","sources":["string"]}]}'
      ].join('\n');

      // Create assistant (or reuse saved one)
      const OpenAI = require('openai');
      const oai = new OpenAI({ apiKey: openaiKey });
      let assistantId = rec.assistant_id || null;
      if (!assistantId){
        const a = await oai.beta.assistants.create({
          name: `lesson:${lessonSlug}`,
          model: 'gpt-4o',
          tools: [ { type:'file_search' } ]
        });
        assistantId = a.id;
        const client2 = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        await client2.connect();
        await (await getLessonStoresCollection(client2)).updateOne({ lessonSlug }, { $set: { assistant_id: assistantId, updatedAt: new Date().toISOString() } });
        await client2.close();
      }

      // Create thread and messages
      const thread = await oai.beta.threads.create({ messages: [
        { role:'system', content: system },
        { role:'user', content: user }
      ]});
      // Run with assistant, attach vector store to file_search at run-time
      const run = await oai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
        tool_resources: { file_search: { vector_store_ids: [ rec.vector_store_id ] } }
      });
      // Poll run status
      let status = run.status; let tries = 0; let last = run;
      while (!['completed','failed','cancelled','expired'].includes(status) && tries < 90){
        await new Promise(r => setTimeout(r, 1000));
        last = await oai.beta.threads.runs.retrieve(thread.id, run.id);
        status = last.status; tries++;
      }
      if (status !== 'completed'){
        return res.status(500).json({ error:'assist_run_failed', status, run: last });
      }
      const msgs = await oai.beta.threads.messages.list(thread.id, { order:'desc', limit: 10 });
      const first = (msgs.data||[]).find(m => m.role==='assistant') || (msgs.data||[])[0];
      let preview = '';
      if (first && Array.isArray(first.content)){
        const textPart = first.content.find(p => p.type==='text');
        if (textPart && textPart.text && textPart.text.value) preview = textPart.text.value;
      }
      return res.json({ ok:true, status, preview: String(preview||'').slice(0, 4000) });
    } catch (e){ console.error('[assist-v2] exception', e); return res.status(500).json({ error:'assist_v2_exception', detail: String(e && e.message || e) }); }
  });

  // Worksheet pipeline: PDF -> high-DPI PNGs -> preprocess -> OCR -> simple visual tags -> JSON -> (optionally) GPT-4o -> MongoDB
  app.post('/ai/worksheet/process', async (req, res) => {
    try {
      const { url, lessonSlug, lessonTitle } = req.body || {};
      if (!url || !lessonSlug) return res.status(400).json({ error:'url and lessonSlug required' });
      // Prepare temp workspace
      const jobId = `ws_${Date.now()}`;
      const DPI = 400;
      const baseTmp = String(process.env.TBP_OCR_TMP_DIR || '/tmp/worksheet');
      try { fs.mkdirSync(baseTmp, { recursive: true }); } catch{}
      const workDir = path.resolve(baseTmp, jobId);
      fs.mkdirSync(workDir, { recursive: true });
      // Download PDF
      const pdfResp = await fetch(url);
      if (!pdfResp.ok) return res.status(400).json({ error:'fetch_failed' });
      const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
      const pdfPath = path.join(workDir, 'ws.pdf');
      fs.writeFileSync(pdfPath, pdfBuf);

      const { spawnSync } = require('child_process');
      function runCmd(cmd, args, opts){
        const r = spawnSync(cmd, args, { encoding:'utf8', ...opts });
        return { code:r.status, stdout:r.stdout||'', stderr:r.stderr||'' };
      }

      // Convert PDF pages to PNGs at ~300 DPI using pdftoppm (Poppler) if available
      let images = [];
      const pdftoppm = runCmd('pdftoppm', ['-v']).code === 0;
      if (pdftoppm){
        const out = runCmd('pdftoppm', ['-png', '-r', String(DPI), pdfPath, path.join(workDir, 'page')]);
        if (out.code !== 0){ console.error('[pdftoppm]', out.stderr); }
        images = fs.readdirSync(workDir).filter(f => /page-?\d+\.png$/i.test(f)).map(f => path.join(workDir, f)).sort();
      }
      // Fallback: render with pdfjs + canvas at scale 3.0 (approx 300 DPI on typical 96dpi base)
      if (!images.length){
        try {
          const pdfjsLib = require('pdfjs-dist');
          const loadingTask = pdfjsLib.getDocument({ data: pdfBuf });
          const pdfDoc = await loadingTask.promise;
          const pageCount = Math.min(pdfDoc.numPages || 1, 40);
          for (let p=1; p<=pageCount; p++){
            const page = await pdfDoc.getPage(p);
            const viewport = page.getViewport({ scale: 4.0 });
            const canvas = createCanvas(viewport.width, viewport.height);
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport }).promise;
            const imgPath = path.join(workDir, `page-${p}.png`);
            fs.writeFileSync(imgPath, canvas.toBuffer('image/png'));
            images.push(imgPath);
          }
        } catch(e){ console.error('[pdfjs render]', e); }
      }

      // Preprocess with ImageMagick if available (deskew, denoise, binarize, contrast)
      const hasMagick = runCmd('magick', ['-version']).code === 0 || runCmd('convert', ['-version']).code === 0;
      if (hasMagick){
        for (const img of images){
          const softPath = img.replace(/\.png$/i, '.soft.png');
          const hardPath = img.replace(/\.png$/i, '.hard.png');
          // Soft preprocessing: preserve fine math details
          let r1 = runCmd('magick', [img, '-colorspace', 'Gray', '-deskew', '30%', '-contrast-stretch', '1%x1%', softPath]);
          if (r1.code !== 0){ r1 = runCmd('convert', [img, '-colorspace', 'Gray', '-deskew', '30%', '-contrast-stretch', '1%x1%', softPath]); }
          // Hard preprocessing: aggressive binarization for text
          let r2 = runCmd('magick', [img, '-colorspace', 'Gray', '-deskew', '40%', '-contrast-stretch', '2%x2%', '-sharpen', '0x1', '-adaptive-threshold', '15x15+10', hardPath]);
          if (r2.code !== 0){ r2 = runCmd('convert', [img, '-colorspace', 'Gray', '-deskew', '40%', '-contrast-stretch', '2%x2%', '-sharpen', '0x1', '-adaptive-threshold', '15x15+10', hardPath]); }
          // Keep original + soft + hard for dual-pass OCR
        }
      }

      // OCR each image: use tesseract CLI if present; otherwise Tesseract.js
      const ENABLE_TESSERACT = String(process.env.WORKSHEET_ENABLE_TESSERACT || '').trim() === '1';
      const hasTessCli = ENABLE_TESSERACT && runCmd('tesseract', ['-v']).code === 0;
      // Flag to preserve glyphs (skip text normalization)
      const preserveGlyphsFlag = (String((req.query && req.query.preserveGlyphs) || (req.body && req.body.preserveGlyphs) || '').trim() === '1');
      const problems = [];
      let pid = 1;
      if (!ENABLE_TESSERACT){
        console.log('[worksheet-process] Tesseract disabled via WORKSHEET_ENABLE_TESSERACT; skipping OCR segmentation.');
      } else {
      function normalizeOcrText(input){
        if (preserveGlyphsFlag) return String(input||'');
        try {
          let s = String(input || '');
          // Normalize common unicode dashes and symbols
          s = s.replace(/[\u2012\u2013\u2014\u2212]/g, '-'); // various dashes and minus
          s = s.replace(/×/g, 'x');
          // sqrt forms: "√x" or "sqrt(x)" -> "\\sqrt{x}"
          s = s.replace(/√\s*\(\s*([^()]+)\s*\)/g, '\\sqrt{$1}');
          s = s.replace(/√\s*([A-Za-z0-9]+)/g, '\\sqrt{$1}');
          s = s.replace(/sqrt\s*\(\s*([^()]+)\s*\)/gi, '\\sqrt{$1}');
          return s;
        } catch { return String(input||''); }
      }
      // Parse Tesseract TSV into line-level records with bounding boxes
      function parseTsvToLines(tsv){
        const rows = String(tsv||'').split(/\n+/);
        const header = rows.shift();
        const cols = (header||'').split('\t');
        const idx = {
          level: cols.indexOf('level'), page_num: cols.indexOf('page_num'), block_num: cols.indexOf('block_num'),
          par_num: cols.indexOf('par_num'), line_num: cols.indexOf('line_num'), word_num: cols.indexOf('word_num'),
          left: cols.indexOf('left'), top: cols.indexOf('top'), width: cols.indexOf('width'), height: cols.indexOf('height'),
          text: cols.indexOf('text')
        };
        const byLine = new Map();
        for (const r of rows){
          if (!r) continue;
          const a = r.split('\t');
          if (a.length < 12) continue;
          const lineKey = `${a[idx.page_num]||'1'}:${a[idx.block_num]||'0'}:${a[idx.par_num]||'0'}:${a[idx.line_num]||'0'}`;
          const left = Number(a[idx.left]||'0');
          const top = Number(a[idx.top]||'0');
          const width = Number(a[idx.width]||'0');
          const height = Number(a[idx.height]||'0');
          const text = a[idx.text]||'';
          if (!text) continue;
          const rec = byLine.get(lineKey) || { id: lineKey, words: [], left: Infinity, top: Infinity, right: 0, bottom: 0 };
          rec.words.push({ text, left, top, width, height });
          rec.left = Math.min(rec.left, left);
          rec.top = Math.min(rec.top, top);
          rec.right = Math.max(rec.right, left + width);
          rec.bottom = Math.max(rec.bottom, top + height);
          byLine.set(lineKey, rec);
        }
        const lines = Array.from(byLine.values()).map(l => ({
          id: l.id,
          text: normalizeOcrText(l.words.map(w=> w.text).join(' ').replace(/\s{2,}/g,' ').trim()),
          left: l.left,
          top: l.top,
          width: Math.max(0, l.right - l.left),
          height: Math.max(0, l.bottom - l.top)
        })).filter(li => li.text && li.height > 0);
        lines.sort((a,b)=> a.top - b.top || a.left - b.left);
        return lines;
      }
      function horizOverlapFrac(a, b){
        const ax0 = a.left, ax1 = a.left + a.width;
        const bx0 = b.left, bx1 = b.left + b.width;
        const inter = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
        const denom = Math.max(1, Math.min(a.width, b.width));
        return inter / denom;
      }
      // Tiny vision pass: detect numeric anchors (1., 2., ...) positions on a page image
      async function detectAnchorsWithVision(imgPath){
        try {
          const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
          const visionFlag = String(req.query.vision || '').trim();
          const enable = (visionFlag === '1' || /true|yes/i.test(visionFlag));
          if (!openaiKey || !enable) return [];
          const b64 = fs.readFileSync(imgPath).toString('base64');
          const rsp = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'gpt-4o',
              response_format: { type: 'json_object' },
              input: [
                { role: 'system', content: 'Detect positions of numbered problem anchors like 1., 2., 3., 4. Return STRICT JSON only: {"anchors":[{"n":1,"x":int,"y":int,"w":int,"h":int}, ...]}. No extra text.' },
                { role: 'user', content: [
                  { type: 'input_text', text: 'Return anchors sorted by n. Coordinates are in the PNG pixel space.' },
                  { type: 'input_image', image_url: { url: `data:image/png;base64,${b64}` } }
                ] }
              ]
            })
          });
          const j = await rsp.json().catch(()=>({}));
          const txt = String(j.output_text || '').trim();
          let anchors = [];
          try { anchors = JSON.parse(txt).anchors || []; } catch {}
          if (!Array.isArray(anchors)) return [];
          return anchors.map((a, i) => ({
            id: `A${i+1}`,
            n: Number(a && a.n) || (i+1),
            left: Number(a && a.x) || 0,
            top: Number(a && a.y) || 0,
            width: Number(a && a.w) || 1,
            height: Number(a && a.h) || 1
          })).sort((a,b)=> (a.top - b.top) || (a.left - b.left));
        } catch { return []; }
      }
      function buildProblemsFromLines(lines){
        const out = [];
        if (!lines || !lines.length) return out;
        const avgH = lines.reduce((s,l)=> s + (l.height||0), 0) / Math.max(1, lines.length);
        // Tolerate minor noise after number (., ), :, -, _)
        const anchorRe = /^\s*\(?\d+\)?\s*(?:[\.:)_\-]|=)?\s+/;
        const answerRe1 = /(domain|range|x-?intercept|y-?intercept|zeros|interval)\s*:\s*[_\-]{4,}/i;
        const answerRe2 = /^[_\-]{6,}$/;
        // collect anchor indices
        const anchors = [];
        for (let i=0;i<lines.length;i++){
          if (anchorRe.test(lines[i].text)) anchors.push(i);
        }
        if (!anchors.length){
          // fallback by gap
          let acc = [];
          for (let i=0;i<lines.length;i++){
            const prev = acc.length ? acc[acc.length-1] : null;
            if (prev && (lines[i].top - prev.top) > 1.75 * avgH){
              out.push({ id: pid++, prompt: acc.map(x=> x.text).join(' '), answer_fields: [], visual: 'none' });
              acc = [lines[i]];
            } else acc.push(lines[i]);
          }
          if (acc.length) out.push({ id: pid++, prompt: acc.map(x=> x.text).join(' '), answer_fields: [], visual: 'none' });
          return out;
        }
        anchors.push(lines.length);
        function bboxFromGroup(group){
          try {
            const x1 = Math.min(...group.map(g=> g.left));
            const y1 = Math.min(...group.map(g=> g.top));
            const x2 = Math.max(...group.map(g=> g.left + g.width));
            const y2 = Math.max(...group.map(g=> g.top + g.height));
            return { x: Math.max(0, Math.floor(x1)), y: Math.max(0, Math.floor(y1)), w: Math.max(1, Math.floor(x2 - x1)), h: Math.max(1, Math.floor(y2 - y1)) };
          } catch { return null; }
        }
        for (let ai=0; ai<anchors.length-1; ai++){
          const startIdx = anchors[ai];
          const endIdx = anchors[ai+1];
          const colRef = lines[startIdx];
          const group = [colRef];
          for (let j=startIdx+1; j<endIdx; j++){
            const ln = lines[j];
            const gap = ln.top - group[group.length-1].top;
            const sameCol = horizOverlapFrac(colRef, ln) >= 0.3;
            if (gap > 1.75 * avgH) break;
            if (!sameCol) continue;
            group.push(ln);
          }
          // answer fields near anchor within 1.5x problem height
          const problemTop = group[0].top;
          const problemBottom = group[group.length-1].top + group[group.length-1].height;
          const problemHeight = Math.max(avgH, problemBottom - problemTop);
          const maxAttachY = problemTop + 1.5 * problemHeight;
          const answerFields = [];
          for (let j=endIdx; j<lines.length && lines[j].top <= maxAttachY; j++){
            const t = lines[j].text;
            if (answerRe1.test(t)){
              const m = t.match(/(domain|range|x-?intercept|y-?intercept|zeros|interval)/i);
              if (m && !answerFields.includes(m[1])) answerFields.push(m[1]);
            } else if (answerRe2.test(t)){
              if (!answerFields.includes('blank')) answerFields.push('blank');
            }
          }
          const prompt = group.map(g=> g.text).join(' ').replace(anchorRe, '').trim();
          const bbox = bboxFromGroup(group);
          out.push({ id: pid++, prompt: prompt.slice(0, 800), answer_fields: answerFields, visual: 'none', bbox });
        }
        return out;
      }
  // Heuristic column splitter using line left positions; returns [ [lines col1], [lines col2], ... ]
  function splitLinesIntoColumns(lines){
    try {
      if (!Array.isArray(lines) || lines.length < 8) return [lines];
      const rightMost = lines.reduce((m,l)=> Math.max(m, l.left + l.width), 0) || 1;
      const centers = Array.from(new Set(lines.map(l=> l.left + l.width/2))).sort((a,b)=> a-b);
      let best = { gap: 0, at: null };
      for (let i=1; i<centers.length; i++){
        const gap = centers[i] - centers[i-1];
        if (gap > best.gap) best = { gap, at: (centers[i] + centers[i-1]) / 2 };
      }
      if (!best.at || best.gap < 0.12 * rightMost) return [lines];
      const mid = best.at;
      const col1 = lines.filter(l => (l.left + l.width/2) < mid).sort((a,b)=> a.top - b.top || a.left - b.left);
      const col2 = lines.filter(l => (l.left + l.width/2) >= mid).sort((a,b)=> a.top - b.top || a.left - b.left);
      if (col1.length < 3 || col2.length < 3) return [lines];
      return [col1, col2];
    } catch { return [lines]; }
  }
      function buildProblemsFromVision(lines, anchors){
        try {
          const out = [];
          if (!Array.isArray(lines) || !lines.length || !Array.isArray(anchors) || !anchors.length) return out;
          const sortedA = anchors.slice().sort((a,b)=> a.top - b.top);
          for (let i=0; i<sortedA.length; i++){
            const a = sortedA[i];
            const nextTop = (sortedA[i+1] && sortedA[i+1].top) || Infinity;
            const group = [];
            for (const ln of lines){
              if (ln.top >= a.top - 2 && ln.top < nextTop - 2) group.push(ln);
            }
            if (!group.length) continue;
            const prompt = group.map(g=> g.text).join(' ').trim();
            const x1 = Math.min(...group.map(g=> g.left));
            const y1 = Math.min(...group.map(g=> g.top));
            const x2 = Math.max(...group.map(g=> g.left + g.width));
            const y2 = Math.max(...group.map(g=> g.top + g.height));
            const bbox = { x: Math.max(0, Math.floor(x1)), y: Math.max(0, Math.floor(y1)), w: Math.max(1, Math.floor(x2 - x1)), h: Math.max(1, Math.floor(y2 - y1)) };
            out.push({ id: pid++, prompt: prompt.slice(0,800), answer_fields: [], visual: 'none', anchor: { left:a.left, top:a.top, width: Math.max(1,a.width), height: Math.max(1,a.height) }, bbox });
          }
          return out;
        } catch { return []; }
      }
      function detectSectionLines(lines){
        const out = [];
        const secRe = /(use the graph of the function|answer the following questions using the graph)/i;
        for (const ln of lines){ if (secRe.test(ln.text)) out.push(ln); }
        return out;
      }
      function assignVisualsToProblems(pageHeight, visuals, problemsPage, lines){
        function horizOverlap(a, b){ return horizOverlapFrac(a, b); }
        const attachmentsById = new Map();
        for (const pr of problemsPage) attachmentsById.set(pr.id, new Set());
        // Shared visuals via section anchors
        const sections = detectSectionLines(lines || []);
        if (visuals && visuals.length && sections && sections.length){
          const visSorted = visuals.slice().sort((a,b)=> a.top - b.top);
          for (const sec of sections){
            const below = visSorted.filter(v => v.top > sec.top);
            if (!below.length) continue;
            const shared = below[0];
            const nextSecTop = (sections.find(s => s.top > sec.top) || { top: pageHeight }).top;
            const nextVisTop = (visSorted.find(v => v.top > shared.top) || { top: pageHeight }).top;
            const scopeEnd = Math.min(nextSecTop, nextVisTop, pageHeight);
            for (const pr of problemsPage){
              const at = pr.anchor || { top:0, left:0, width:0, height:0 };
              if (at.top > sec.top && at.top < scopeEnd){ attachmentsById.get(pr.id).add(shared.id); }
            }
          }
        }
        // Single-problem visuals via scoring
        if (visuals && visuals.length){
          for (const pr of problemsPage){
            const at = pr.anchor || { top:0, left:0, width:0, height:0 };
            const candidates = visuals.filter(v => v.top > at.top);
            let best = null; let bestScore = Infinity;
            for (const v of candidates){
              const vDist = v.top - at.top;
              const overlap = horizOverlap(at, v);
              const sameColBonus = overlap >= 0.3 ? 1 : 0;
              const score = vDist - 0.6 * overlap - 0.2 * sameColBonus;
              const withinRadius = vDist <= (pageHeight / 3);
              const overlapOk = overlap >= 0.25;
              if (withinRadius && overlapOk && score < bestScore){ bestScore = score; best = v; }
            }
            if (best){ attachmentsById.get(pr.id).add(best.id); }
          }
        }
        const out = new Map();
        for (const pr of problemsPage){ out.set(pr.id, Array.from(attachmentsById.get(pr.id) || new Set())); }
        return out;
      }
      function isInstructionLine(ln){
        try {
          const s = String(ln||'').trim();
          if (!s) return false;
          if (/^(\(?\d+\)?[.)]|[A-D][.)])\s+/.test(s)) return false; // looks like numbered or lettered item
          const longEnough = s.length >= 40;
          const hasKeyword = /(find|determine|solve|instructions|for the following|for each|calculate|evaluate|given|use|identify|compute|round|graph|sketch|simplify|factor|domain|range|intercept|show|prove)/i.test(s);
          return longEnough && hasKeyword;
        } catch { return false; }
      }
      function extractInstructions(lines){
        const out = [];
        try {
          for (const ln of lines){ if (isInstructionLine(ln)) out.push(ln); }
        } catch {}
        return out.slice(0, 8);
      }
      // If OCR merged multiple problems into one line like "1. ... 2. ...",
      // split that line into multiple logical lines using mid-line anchors
      function expandLinesByInternalAnchors(lines){
        const out = [];
        const midAnchor = /(\s|^)\d+\s*[\.\):_\-]?\s+/g; // matches in-line noisy anchors like " 2." or " 4_ "
        const funcAnchor = /\b([a-zA-Z])\(x\)\s*=/g; // split on f(x)=, g(x)=, etc.
        for (const li of (lines||[])){
          const t = String(li.text||'');
          let indices = [];
          let m;
          // find all anchor starts (excluding very first at index 0 to keep as-is)
          while ((m = midAnchor.exec(t)) !== null){
            const start = m.index + m[1].length; // after leading space if any
            if (start === 0) continue; // start-of-line anchor handled naturally
            indices.push(start);
          }
          // also split before occurrences of letter(x)=
          while ((m = funcAnchor.exec(t)) !== null){
            const start = m.index; if (start>0) indices.push(start);
          }
          if (!indices.length){ out.push(li); continue; }
          // build segments
          const cuts = [0, ...Array.from(new Set(indices))].sort((a,b)=>a-b);
          for (let i=0;i<cuts.length;i++){
            const a = cuts[i];
            const b = i+1<cuts.length ? cuts[i+1] : t.length;
            const seg = t.slice(a, b).trim();
            if (!seg) continue;
            out.push({ ...li, text: seg });
          }
        }
        // keep original ordering by top then left
        out.sort((a,b)=> (a.top - b.top) || (a.left - b.left));
        return out;
      }
      function isInstructionText(txt){
        try {
          const s = String(txt||'').trim();
          if (!s) return false;
          if (isInstructionLine(s)) return true;
          if (/(use the graph of the function|answer the following questions using the graph)/i.test(s)) return true;
          return false;
        } catch { return false; }
      }
      const allInstructionLines = new Set();
      const allLinesPool = [];
      let pageNum = 0;
      if (!ENABLE_TESSERACT){
        console.log('[worksheet-process] Tesseract disabled; skipping local OCR segmentation.');
      }
      for (const img of images){
        pageNum++;
        if (!ENABLE_TESSERACT){
          continue;
        }
        let text = '';
        let linesWithBbox = [];
        if (hasTessCli){
          // Attempt OCR on original + dual preprocessed variants and union lines
          const variants = [img, img.replace(/\.png$/i, '.soft.png'), img.replace(/\.png$/i, '.hard.png')].filter(p=> fs.existsSync(p));
          const union = new Map();
          for (const v of variants){
            for (const psm of ['6','3']){
              const r = runCmd('tesseract', [v, 'stdout', '-l', 'eng', '--psm', psm, '-c', 'preserve_interword_spaces=1', 'tsv']);
              if (r.code === 0){
                const ls = parseTsvToLines(r.stdout);
                for (const li of ls){ union.set(`${li.top}:${li.left}:${li.text}`, li); }
              } else { console.error('[tesseract cli]', r.stderr); }
            }
          }
          linesWithBbox = Array.from(union.values()).sort((a,b)=> a.top - b.top || a.left - b.left);
          text = linesWithBbox.map(l=> l.text).join('\n');
        } else if (ENABLE_TESSERACT){
          try {
            const o = await Tesseract.recognize(fs.readFileSync(img), 'eng', { logger:()=>{} });
            text = (o && o.data && o.data.text) || '';
            // Optional: attempt line boxes from Tesseract.js result if available
            try {
              const linesJs = Array.isArray(o?.data?.lines) ? o.data.lines : [];
              linesWithBbox = linesJs.map(li => ({
                id: `${li.block_num||0}:${li.par_num||0}:${li.line_num||0}`,
                text: normalizeOcrText(String(li.text||'')),
                left: Number(li.bbox?.x0 ?? 0),
                top: Number(li.bbox?.y0 ?? 0),
                width: Number((li.bbox ? (li.bbox.x1 - li.bbox.x0) : 0)),
                height: Number((li.bbox ? (li.bbox.y1 - li.bbox.y0) : 0))
              })).filter(li => li.text);
            } catch {}
          } catch(e){ console.error('[tesseract.js]', e); }
        }
        // Post-OCR normalization to improve math fidelity (e.g., square roots)
        text = normalizeOcrText(text);
        // Build line list (prefer bbox lines)
        let lines = (linesWithBbox && linesWithBbox.length)
          ? linesWithBbox
          : String(text||'').split(/\n+/).map(s=> ({ text: s.trim(), left:0, top:0, width:0, height:0 })).filter(li => li.text);
        // Expand mid-line anchors for both bbox and fallback lines
        try { if (linesWithBbox && linesWithBbox.length) linesWithBbox = expandLinesByInternalAnchors(linesWithBbox); } catch {}
        // Expand mid-line anchors (e.g., "... 2. ...") to separate logical lines
        try { lines = expandLinesByInternalAnchors(lines); } catch {}
        try { allLinesPool.push(...(Array.isArray(lines) ? lines.map(li=> li.text) : [])); } catch {}
        try { for (const l of extractInstructions(lines.map(li=> li.text))) allInstructionLines.add(l); } catch {}
        // Per-page visuals placeholder (detection TBD)
        const pageHeight = lines.reduce((m,li)=> Math.max(m, li.top + li.height), 0) || 1000;
        const visuals = [];
        // simple visual tag heuristics (placeholder)
        function tagVisual(txt){
          const s = txt.toLowerCase();
          if (/coordinate|axis|axes|plot|graph|slope|y\s*=|x\s*=/.test(s)) return 'graph';
          if (/number\s*line|interval|inequality|open\s*dot|closed\s*dot/.test(s)) return 'number_line';
          if (/table|row|column|cells|\|\s*\|/.test(s)) return 'table';
          return 'none';
        }
      // Build problems using anchor-based grouping; supports optional vision anchors and column splits
      let built = [];
      let visionAnchors = [];
      try { visionAnchors = await detectAnchorsWithVision(img); } catch {}
      if (linesWithBbox && linesWithBbox.length){
        const cols = splitLinesIntoColumns(linesWithBbox);
        for (const col of cols){
          let added = false;
          if (visionAnchors && visionAnchors.length){
            const minX = Math.min(...col.map(l=> l.left));
            const maxX = Math.max(...col.map(l=> l.left + l.width));
            const anchorsInCol = visionAnchors.filter(a => (a.left >= minX - 8) && (a.left <= maxX + 8));
            if (anchorsInCol.length){
              built = built.concat(buildProblemsFromVision(col, anchorsInCol));
              added = true;
            }
          }
          if (!added){
            built = built.concat(buildProblemsFromLines(col));
          }
        }
      } else {
        const flat = lines.map(li=> li.text);
        const chunks = [];
        let acc = [];
        for (const ln of flat){
          if (/^(\(?\d+\)?[.)]|[A-Z][.)])\s+/.test(ln) && acc.length){ chunks.push(acc.join(' ')); acc = [ln]; }
          else acc.push(ln);
        }
        if (acc.length) chunks.push(acc.join(' '));
        built = chunks.map(c => ({ id: pid++, prompt: c.slice(0, 800), answer_fields: [], visual: 'none' }));
      }
        // Filter out instruction-only blocks
        built = built.filter(pr => !isInstructionText(pr.prompt));
        // Assign visuals per scoring and section rules
        const attachMap = assignVisualsToProblems(pageHeight, visuals, built, (linesWithBbox && linesWithBbox.length ? linesWithBbox : []));
        for (const pr of built){
          problems.push({ id: pr.id, prompt: pr.prompt, answer_fields: pr.answer_fields||[], visual: pr.visual || tagVisual(pr.prompt), attachments: attachMap.get(pr.id) || [], bbox: pr.bbox || null });
        }
      }

      }
      // Store minimally to Mongo (raw extraction), keyed to lessonSlug
      const client3 = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client3.connect();
      const col = await getQuestionCollection(client3);
      const qsrc = await getQSourcesCollection(client3);
      const nowIso = new Date().toISOString();
      // Optional wipe of previous OCR docs for this lesson
      try {
        const wipeFlag = (req.query && (req.query.wipe==='1' || /true|yes/i.test(String(req.query.wipe)))) || (!!req.body && (req.body.wipe===true));
        if (wipeFlag){
          await col.deleteMany({ lessonSlug, generator: 'worksheet-ocr' });
        }
      } catch {}
      // Derive worksheet source name
      let sourceName = '';
      try {
        const u = new URL(url);
        const last = (u.pathname || '').split('/').filter(Boolean).pop() || '';
        sourceName = last && /\.pdf$/i.test(last) ? last : `${lessonTitle||lessonSlug}.pdf`;
      } catch { sourceName = `${lessonTitle||lessonSlug}.pdf`; }
      let worksheetInstruction = Array.from(allInstructionLines).join(' ').slice(0, 1200);
      if (!worksheetInstruction){
        try {
          const candidates = Array.from(new Set(allLinesPool.filter(l=> l && !/^(\(?\d+\)?[.)]|[A-D][.)])\s+/.test(l))))
            .sort((a,b)=> b.length - a.length);
          const best = candidates.find(s=> s.length >= 50) || candidates[0] || '';
          worksheetInstruction = String(best||'').slice(0, 1200);
        } catch {}
      }
      // Backfill/update instruction on existing OCR docs for this lesson
      try { if (worksheetInstruction) await col.updateMany({ lessonSlug, generator:'worksheet-ocr' }, { $set: { worksheetInstruction } }); } catch {}
      let inserted = 0;
      const storedProblems = [];
      // Re-scan images to map problems to pages by simple heuristic (first page for this single-page worksheet)
      const perPage = pageNum || 1;
      let runningPage = 1;
      for (const p of problems.slice(0, 50)){ // cap for safety
        try {
          const pngPath = images[Math.min(images.length-1, runningPage-1)] || images[0];
          let imageB64 = '';
          try { imageB64 = fs.readFileSync(pngPath).toString('base64'); } catch {}
          // Persist a copy to public tmp uploads and store a public URL as fallback
          let pngUrl = '';
          try {
            const publicTmp = path.resolve(__dirname, '../tmp_uploads');
            try { fs.mkdirSync(publicTmp, { recursive: true }); } catch{}
            const outName = `ws_${jobId}_p${runningPage}.png`;
            const outPath = path.join(publicTmp, outName);
            try { fs.copyFileSync(pngPath, outPath); } catch{}
            const baseUrl = (req.headers['x-forwarded-proto'] ? `${req.headers['x-forwarded-proto']}` : 'https') + '://' + (req.headers['x-forwarded-host'] || req.headers.host);
            pngUrl = `${baseUrl}/tmp/uploads/${outName}`;
          } catch {}
          // Do NOT insert into questionbank; store only in qsources
          storedProblems.push({ id: p.id, prompt: p.prompt, answer_fields: Array.isArray(p.answer_fields)? p.answer_fields: [], visual: p.visual||'none', page: runningPage, pngPath, dpi: DPI, pngUrl, bbox: (p.bbox||null) });
          // Also insert a per-item record into thinkpod.qsources
          try {
            await qsrc.insertOne({
              lessonSlug,
              lessonTitle: lessonTitle || lessonSlug,
              sourceUrl: url,
              sourceName,
              page: runningPage,
              problemId: p.id,
              prompt: p.prompt,
              answer_fields: Array.isArray(p.answer_fields)? p.answer_fields: [],
              visual: p.visual || 'none',
              createdAt: nowIso,
              sourceType: 'worksheet-ocr',
              jobId,
              pngPath,
              pngUrl,
              dpi: DPI,
              imageB64,
              bbox: (p.bbox||null)
            });
            inserted++;
          } catch {}
          runningPage = Math.min(perPage, runningPage + 1);
        } catch(e){}
      }
      // Record provenance in qsources
      try {
        const imgs = images.map((p,i)=>({ page:i+1, pngPath:p }));
        await qsrc.insertOne({ lessonSlug, lessonTitle: lessonTitle||lessonSlug, sourceUrl: url, sourceName, pages: images.length, dpi: DPI, jobId, images: imgs, problems: storedProblems, createdAt: nowIso, sourceType:'worksheet-ocr' });
      } catch {}
      await client3.close();

      // Keep PNGs for vision-clean to consume later (cleanup handled by ops)

      // Return a minimal structured view for OCR output consumers
      const structured = problems.map(p => ({ id: p.id, prompt: p.prompt, answer_fields: Array.isArray(p.answer_fields)? p.answer_fields: [], visual: p.visual || 'none' }));
      const preview = structured.slice(0, 10);
      return res.json({ ok:true, pages: images.length, extracted: problems.length, inserted, structured: structured.slice(0, 50), preview });
    } catch (e){ console.error('[worksheet-process] exception', e); return res.status(500).json({ error:'worksheet_process_exception', detail: String(e && e.message || e) }); }
  });

  // Vision-based math transcription to clean OCR stems into LaTeX
  // Mount a GET alias for health checks/tools
  app.all('/api/vision-clean', async (req, res) => {
    return res.json({ ok:true, route:'/api/vision-clean', status:'ready' });
  });

  // Layout detect route removed (no external detector in Native runtime)
  app.post('/ai/layout/detect', async (req, res) => {
    return res.status(410).json({ error:'layout_detector_removed' });
  });

  // Mathpix OCR proxy: transcribe one image (optionally already cropped)
  app.post('/ai/ocr/mathpix', async (req, res) => {
    try {
      const appId = process.env.MATHPIX_APP_ID || process.env.mathpix_app_id;
      const appKey = process.env.MATHPIX_APP_KEY || process.env.mathpix_app_key;
      if (!appId || !appKey) return res.status(400).json({ error:'missing_MATHPIX_keys' });
      const { imagePath, imageB64 } = req.body || {};
      let b64 = String(imageB64||'').trim();
      if (!b64 && imagePath && fs.existsSync(String(imagePath))){
        try { b64 = fs.readFileSync(String(imagePath)).toString('base64'); } catch{}
      }
      if (!b64) return res.status(400).json({ error:'image required' });
      const rsp = await fetch('https://api.mathpix.com/v3/text', {
        method:'POST', headers:{ 'Content-Type':'application/json', 'app_id': String(appId), 'app_key': String(appKey) },
        body: JSON.stringify({ src: `data:image/png;base64,${b64}`, formats:['latex_styled','text'], include_latex_style:true })
      });
      const j = await rsp.json().catch(()=>({}));
      return res.json({ ok:true, result:j });
    } catch(e){ console.error('[mathpix] exception', e); return res.status(500).json({ error:'mathpix_exception', detail:String(e && e.message || e) }); }
  });

  app.post('/ai/worksheet/vision-clean', async (req, res) => {
    try {
      const mathpixAppId = process.env.MATHPIX_APP_ID || process.env.mathpix_app_id;
      const mathpixAppKey = process.env.MATHPIX_APP_KEY || process.env.mathpix_app_key;
      const mathpixParam = String(req.query.mathpix||'').toLowerCase();
      // Default to Mathpix when keys exist; allow disabling via mathpix=0/false/no
      const useMathpix = !!(mathpixAppId && mathpixAppKey) && !(mathpixParam==='0' || /false|no/i.test(mathpixParam));
      const useDetector = false; // detector disabled
      const { url, lessonSlug, limit } = req.body || {};
      if (!lessonSlug) return res.status(400).json({ error:'lessonSlug required' });
      const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
      if (!openaiKey && !useMathpix) return res.status(500).json({ error:'missing_OPENAI_API_KEY_or_Mathpix' });

      // Optionally download PDF if a URL is provided; otherwise rely on stored imageB64/pngPath
      const workDir = path.resolve(__dirname, `../tmp_vis_${Date.now()}`);
      fs.mkdirSync(workDir, { recursive: true });
      const images = [];
      if (url){
        const pdfResp = await fetch(url);
        if (!pdfResp.ok) return res.status(400).json({ error:'fetch_failed' });
        const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
        const pdfPath = path.join(workDir, 'ws.pdf');
        fs.writeFileSync(pdfPath, pdfBuf);
        const { spawnSync } = require('child_process');
        // Try pdftoppm first
        const havePdftoppm = spawnSync('pdftoppm', ['-v'], { encoding:'utf8' }).status === 0;
        if (havePdftoppm){
          const r = spawnSync('pdftoppm', ['-png', '-r', '400', pdfPath, path.join(workDir, 'page')], { encoding:'utf8' });
          if (r.status === 0){
            for (const f of fs.readdirSync(workDir)) if (/page-?\d+\.png$/i.test(f)) images.push(path.join(workDir, f));
            images.sort();
          }
        }
        // Fallback to pdfjs if pdftoppm failed
        if (!images.length){
          try {
            const pdfjsLib = require('pdfjs-dist');
            const loadingTask = pdfjsLib.getDocument({ data: pdfBuf });
            const pdfDoc = await loadingTask.promise;
            const page = await pdfDoc.getPage(1);
            const viewport = page.getViewport({ scale: 4.0 });
            const canvas = createCanvas(viewport.width, viewport.height);
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport }).promise;
            const imgPath = path.join(workDir, `page-1.png`);
            fs.writeFileSync(imgPath, canvas.toBuffer('image/png'));
            images.push(imgPath);
          } catch(e){ try { fs.rmSync(workDir, { recursive:true, force:true }); } catch{}; return res.status(500).json({ error:'render_failed' }); }
        }
      }

      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const qsrc = await getQSourcesCollection(client);
      const maxN = Math.max(1, Math.min(50, Number(limit)||20));
      // Discover latest OCR jobId for this lesson
      const latestJobArr = await qsrc.find({ lessonSlug, sourceType:'worksheet-ocr', jobId: { $exists:true } }).project({ jobId:1, createdAt:1 }).sort({ createdAt:-1 }).limit(1).toArray();
      const latestJobId = latestJobArr && latestJobArr[0] && latestJobArr[0].jobId;
      // Prefer items from latest job that are missing promptLatex; otherwise take recent
      // Only process per-problem records (exclude summary docs)
      let queryBase = latestJobId ? { lessonSlug, sourceType:'worksheet-ocr', jobId: latestJobId, problemId: { $exists:true } } : { lessonSlug, sourceType:'worksheet-ocr', problemId: { $exists:true } };
      let docs = await qsrc.find({ ...queryBase, $or:[ { promptLatex: { $exists:false } }, { promptLatex: '' } ] }).sort({ createdAt: -1 }).limit(maxN).toArray();
      if (!docs.length){
        docs = await qsrc.find(queryBase).sort({ createdAt: -1 }).limit(maxN).toArray();
      }

      let OpenAI, oai;
      try { if (openaiKey) { OpenAI = require('openai'); oai = new OpenAI({ apiKey: openaiKey }); } } catch{}

      async function transcribeOne(noisy){
        // Acquire an image for this record
        let imgB64 = String(noisy && noisy.imageB64 || '').trim();
        let pngPath = String(noisy && noisy.pngPath || '').trim();
        if (!imgB64 && pngPath && fs.existsSync(pngPath)){
          try { imgB64 = fs.readFileSync(pngPath).toString('base64'); } catch{}
        }
        if (!imgB64){
          const pngUrl = String(noisy && noisy.pngUrl || '').trim();
          if (pngUrl){
            try { const pr = await fetch(pngUrl); if (pr.ok){ const ab = await pr.arrayBuffer(); imgB64 = Buffer.from(ab).toString('base64'); } } catch{}
          }
        }
        if (!imgB64 && images && images[0]){
          try { imgB64 = fs.readFileSync(images[0]).toString('base64'); } catch{}
        }
        if (!imgB64) return null;

        // Optional: run detector to crop math regions and pick the most confident crop
        let crops = [];
        // detector disabled

        // Prefer stored bbox from qsources if present
        try {
          if ((!crops || !crops.length) && noisy && noisy.bbox && Number(noisy.bbox.w)>0 && Number(noisy.bbox.h)>0){
            crops = [ { x:Number(noisy.bbox.x)||0, y:Number(noisy.bbox.y)||0, w:Number(noisy.bbox.w)||0, h:Number(noisy.bbox.h)||0, score:1 } ];
          }
        } catch{}
        const useCrops = crops && crops.length ? crops : [{ x:0, y:0, w:0, h:0, score:1 }];

        async function callMathpix(b64, crop){
          try {
            // If crop specified, generate cropped b64
            let payloadB64 = b64;
            if (crop && crop.w > 0 && crop.h > 0 && pngPath && fs.existsSync(pngPath)){
              try {
                const tmpOut = pngPath.replace(/\.png$/i, `.mx_${crop.x}_${crop.y}_${crop.w}x${crop.h}.png`);
                const r = runCmd('magick', [pngPath, '-crop', `${crop.w}x${crop.h}+${crop.x}+${crop.y}`, '+repage', tmpOut]);
                if (r.code === 0 && fs.existsSync(tmpOut)){
                  payloadB64 = fs.readFileSync(tmpOut).toString('base64');
                }
              } catch{}
            }
            const rsp = await fetch('https://api.mathpix.com/v3/text', {
              method:'POST',
              headers:{ 'Content-Type':'application/json', 'app_id': String(mathpixAppId), 'app_key': String(mathpixAppKey) },
              body: JSON.stringify({ src: `data:image/png;base64,${payloadB64}`, formats:['latex_styled','latex_simplified','text','data'], include_latex_style: true })
            });
            const j = await rsp.json().catch(()=>({}));
            let latex = String(j && (j.latex_styled || j.latex || '') || '').trim();
            if (!latex && j && Array.isArray(j.data)){
              try {
                const firstLatex = j.data.find(it => String(it && it.type).toLowerCase().includes('latex') && it.value);
                if (firstLatex && firstLatex.value) latex = String(firstLatex.value).trim();
              } catch {}
            }
            if (!latex && j && typeof j.text === 'string'){
              const t = j.text.trim();
              if (/[=^_\\]/.test(t) || /\d/.test(t)) latex = t;
            }
            if (latex) return /^\\\(|\\\[/.test(latex) ? latex : `\\(${latex}\\)`;
          } catch{}
          return '';
        }

        async function callOAI(b64){
          const instruction = 'You are a math vision transcriber. Task: Transcribe exactly the math expression(s) visible for ONE problem from the provided worksheet image. Return STRICT JSON ONLY: {"latex":"..."}. Rules: 1) Prefer canonical LaTeX (\\frac, \\sqrt, ^, _). 2) Return a single-line LaTeX string; wrap inline with \\( ... \\). 3) Do NOT include prose or markdown. 4) If multiple tiny expressions appear, pick the one that matches the hint. 5) If unsure, output best guess as LaTeX.';
          const user = [
            noisy && noisy.stem ? `Noisy OCR hint: ${String(noisy.stem).slice(0,200)}` : 'Noisy OCR hint: (none)',
            'Return STRICT JSON: {"latex":"..."}.'
          ].join('\n');
          try {
            const rsp = await fetch('https://api.openai.com/v1/responses', {
              method:'POST', headers:{ 'Authorization': `Bearer ${openaiKey}`, 'Content-Type':'application/json' },
              body: JSON.stringify({
                model:'gpt-4o', response_format:{ type:'json_object' }, temperature: 0,
                input:[
                  { role:'system', content: instruction },
                  { role:'user', content:[ { type:'input_text', text: user }, { type:'input_image', image_url:{ url:`data:image/png;base64,${b64}` } } ] }
                ]
              })
            });
            const j = await rsp.json().catch(()=>({}));
            let txt = '';
            try { txt = String(j.output_text||'').trim(); } catch { txt = ''; }
            if (!txt || txt === '[object Object]'){
              try { txt = JSON.stringify(j); } catch { txt = ''; }
            }
            let out = { latex:'' }; try { out = JSON.parse(txt); } catch{}
            let latex = String(out && out.latex || '').trim();
            if (!latex){
              const mBr = txt.match(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/);
              if (mBr){ latex = mBr[0]; }
              if (!latex){
                const mJson = txt.match(/"latex"\s*:\s*"([\s\S]*?)"/);
                if (mJson){ latex = mJson[1]; }
              }
              if (!latex){
                const mDollar = txt.match(/\$\$?([\s\S]*?)\$\$?/);
                if (mDollar){ latex = `\\(${mDollar[1]}\\)`; }
              }
            }
            if (latex && !/^\\\(|\\\[/.test(latex)) latex = `\\(${latex}\\)`;
            return latex || '';
          } catch{}
          return '';
        }

        // Try crops in order with Mathpix if enabled, else fall back to OAI
        if (useMathpix){
          for (const c of useCrops){
            const la = await callMathpix(imgB64, c);
            if (la) return la;
          }
        }
        // Fall back to OAI on full image or best crop
        if (openaiKey){
          if (useCrops.length && useCrops[0] && useCrops[0].w>0){
            // If we have a crop, try cropped first
            if (pngPath && fs.existsSync(pngPath)){
              try {
                const c = useCrops[0];
                const tmpOut = pngPath.replace(/\.png$/i, `.oai_${c.x}_${c.y}_${c.w}x${c.h}.png`);
                const r = runCmd('magick', [pngPath, '-crop', `${c.w}x${c.h}+${c.x}+${c.y}`, '+repage', tmpOut]);
                if (r.code === 0 && fs.existsSync(tmpOut)){
                  const croppedB64 = fs.readFileSync(tmpOut).toString('base64');
                  const la = await callOAI(croppedB64);
                  if (la) return la;
                }
              } catch{}
            }
          }
          return await callOAI(imgB64);
        }
        return null;
      }

      let updated = 0; const results = []; let attempted = 0; let missingPng = 0; let failures = 0;
      for (const d of docs){
        attempted++;
        if (!d || !d.pngPath || !fs.existsSync(String(d.pngPath))) { missingPng++; }
        const latex = await transcribeOne(d);
        if (latex){
          await qsrc.updateOne({ _id: d._id }, { $set: { promptLatex: latex, updatedAt: new Date().toISOString() } });
          updated++;
          results.push({ id: String(d._id), promptLatex: latex });
        } else {
          failures++;
        }
      }
      await client.close();
      try { fs.rmSync(workDir, { recursive:true, force:true }); } catch{}
      return res.json({ ok:true, updated, attempted, missingPng, failures, results });
    } catch (e){ console.error('[worksheet-vision-clean] exception', e); return res.status(500).json({ error:'worksheet_vision_clean_exception', detail: String(e && e.message || e) }); }
  });

  // Manual fix helper: set promptLatex for a qsources item by lesson and problemId
  app.post('/ai/worksheet/qsources/set-latex', async (req, res) => {
    try {
      const { lessonSlug, problemId, latex } = req.body || {};
      if (!lessonSlug || !problemId || !latex) return res.status(400).json({ error:'lessonSlug, problemId, latex required' });
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const qsrc = await getQSourcesCollection(client);
      const r = await qsrc.updateOne({ lessonSlug, sourceType:'worksheet-ocr', problemId: Number(problemId) }, { $set: { promptLatex: String(latex), updatedAt: new Date().toISOString() } });
      await client.close();
      return res.json({ ok:true, matched: r.matchedCount||0, modified: r.modifiedCount||0 });
    } catch(e){ console.error('[qsources-set-latex] exception', e); return res.status(500).json({ error:'qsources_set_latex_exception', detail:String(e && e.message || e) }); }
  });

  // Agent 1: Generate from OCR qsources (seeded by prompt/promptLatex and optional image)
  app.post('/ai/agent1/generate-from-qsources', async (req, res) => {
    try {
      const lessonSlug = String(req.query.lesson||'').trim();
      const lessonTitle = String((req.body && req.body.title) || req.query.title || lessonSlug).trim();
      const useImages = String(req.query.useImages||'').toLowerCase();
      const withImages = useImages==='1' || /true|yes/i.test(useImages);
      const n = Math.max(1, Math.min(50, Number(req.query.n || req.body && req.body.n || 10)));
      if (!lessonSlug) return res.status(400).json({ error:'lesson required' });
      const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
      if (!openaiKey) return res.status(500).json({ error:'missing_OPENAI_API_KEY' });

      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const qsrc = await getQSourcesCollection(client);
      const col = await getQuestionCollection(client);
      const seeds = await qsrc.find({ lessonSlug, sourceType:'worksheet-ocr' }).sort({ createdAt: -1 }).limit(n).toArray();

      const system = [
        'You are ChatGPT, a large language model trained by OpenAI.',
        'Follow these rules:',
        '1. Be helpful, accurate, and concise.',
        '2. Always show clear reasoning steps for problem-solving (math, logic, coding).',
        '3. Use LaTeX for all math expressions:',
        '   - Inline math: \\( ... \\)',
        '   - Display math: \\[ ... \\]',
        '4. Before finalizing an answer, simulate a regex check to ensure:',
        '   - All math expressions are wrapped in \\( ... \\) or \\[ ... \\].',
        '   - No raw LaTeX symbols appear outside those delimiters.',
        '   - Regex for inline math: `\\\\\\(.*?\\\\\\)`',
        '   - Regex for display math: `\\\\\\[.*?\\\\\\]`',
        '5. LaTeX code generated by Agent 1 must always be rendered properly for the user—no raw code should ever be shown.',
        '6. Agent 2 is responsible for retrieving questions from Agent 1 and ensuring formatting is preserved.',
        '7. (Optional) Agent 3 may be used for verification—checking correctness of answers, duplicates in options, and formatting integrity.',
        '',
        'Generate one high-quality MCQ based strictly on the provided SEED (LaTeX or text) and optional image. Return STRICT JSON ONLY (no prose).'
      ].join('\n');
      const schema = {
        type: 'object',
        properties: {
          question: {
            type: 'object',
            properties: {
              stimulus_text: { type:'string' },
              stimulus_latex: { type:'string' },
              stimulus_mathjson: { type:'object' },
              options_latex: { type:'array', items:{ type:'string' } },
              options_mathjson: { type:'array', items:{ type:'object' } },
              answer_index: { type:'number' },
              answer_plain: { type:'string' },
              answer_mathjson: { type:'object' },
              rationale_text: { type:'string' },
              rationale_latex: { type:'string' },
              difficulty: { type:'string' }
            },
            required:['stimulus_latex','options_latex','answer_index','answer_plain','difficulty']
          }
        }, required:['question']
      };

      function normalizeSeedText(input){
        try {
          let s = String(input || '');
          s = s.replace(/[\u2012\u2013\u2014\u2212]/g, '-'); // dashes/minus
          s = s.replace(/×/g, 'x');
          s = s.replace(/÷/g, '/');
          s = s.replace(/ﬂ/g, 'fl');
          s = s.replace(/ﬁ/g, 'fi');
          s = s.replace(/°/g, '');
          s = s.replace(/√/g, 'sqrt');
          s = s.replace(/[\u00A0\u2000-\u200D]/g, ' '); // various spaces
          s = s.replace(/[^\x20-\x7E\n]/g, ''); // strip non-ASCII
          s = s.replace(/\s+/g, ' ').trim();
          return s;
        } catch { return String(input||'').trim(); }
      }

      async function callOne(seed){
        const rawSeed = String(seed.promptLatex || seed.prompt || '').trim();
        const seedText = rawSeed.slice(0, 800);
        const seedClean = normalizeSeedText(seedText);
        let seedVerbatim = '';
        try {
          const copy = { ...seed };
          if (copy && copy.imageB64) delete copy.imageB64;
          seedVerbatim = JSON.stringify(copy, null, 2).slice(0, 6000);
        } catch {}
        const userParts = [
          'SEED (raw, use only this content):',
          seedText || '(none)',
          'SEED (normalized for readability):',
          seedClean || '(none)',
          'OCR JSON (verbatim):',
          seedVerbatim || '(none)',
          'JSON SCHEMA: {"question":{"stimulus_text":"string","stimulus_latex":"string","stimulus_mathjson":{},"options_latex":["string","string","string","string"],"options_mathjson":[{},{},{},{}],"answer_index":0,"answer_plain":"string","answer_mathjson":{},"rationale_text":"string","rationale_latex":"string","difficulty":"easy|medium|hard"}}',
          'Constraints: 4 options only; exactly one correct; difficulty must be easy|medium|hard; all math in LaTeX \\( ... \\); include MathJSON for stimulus, each option, and the correct answer.'
        ].join('\n');
        const headers = { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type':'application/json' };
        const input = [{ role:'system', content: system }];
        const userContent = [{ type:'input_text', text: userParts }];
        try {
          if (withImages){
            if (seed && seed.imageB64){
              userContent.push({ type:'input_image', image_url:{ url:`data:image/png;base64,${seed.imageB64}` } });
            } else if (seed && seed.pngPath && fs.existsSync(String(seed.pngPath))){
              const b64 = fs.readFileSync(seed.pngPath).toString('base64');
              userContent.push({ type:'input_image', image_url:{ url:`data:image/png;base64,${b64}` } });
            }
          }
        } catch{}
        input.push({ role:'user', content: userContent });
        const body = { model:'gpt-4o', response_format:{ type:'json_object' }, input, temperature: 0 };
        const rsp = await fetch('https://api.openai.com/v1/responses', { method:'POST', headers, body: JSON.stringify(body) });
        const j = await rsp.json().catch(()=>({}));
        let txt = '';
        try { txt = String(j.output_text||'').trim(); } catch { txt = ''; }
        if (!txt || txt === '[object Object]'){
          try { txt = JSON.stringify(j); } catch { /* ignore */ }
        }
        let out = {}; try { out = JSON.parse(txt); } catch{}
        let q = out && out.question || {};
        let valid = q && Array.isArray(q.options_latex) && q.options_latex.length === 4 && Number.isFinite(Number(q.answer_index));
        if (valid) return q;
        // Fixer: coerce to strict schema
        const fixerSystem = [
          'You produced output that must be corrected to match this JSON schema exactly:',
          '{"question":{"stimulus_text":"string","stimulus_latex":"string","stimulus_mathjson":{},"options_latex":["string","string","string","string"],"options_mathjson":[{},{},{},{}],"answer_index":0,"answer_plain":"string","answer_mathjson":{},"rationale_text":"string","rationale_latex":"string","difficulty":"easy|medium|hard"}}',
          'Return STRICT JSON ONLY. Ensure options_latex has exactly 4 entries and answer_index is 0..3. Include MathJSON fields.'
        ].join(' ');
        const fixBody = { model:'gpt-4o', response_format:{ type:'json_object' }, temperature: 0, input:[ { role:'system', content: fixerSystem }, { role:'user', content:[ { type:'input_text', text: (txt || '(empty)') } ] } ] };
        const fixRsp = await fetch('https://api.openai.com/v1/responses', { method:'POST', headers, body: JSON.stringify(fixBody) });
        const fj = await fixRsp.json().catch(()=>({}));
        let ftxt = ''; try { ftxt = String(fj.output_text||'').trim(); } catch { ftxt = ''; }
        let fout = {}; try { fout = JSON.parse(ftxt); } catch{}
        q = fout && fout.question || {};
        valid = q && Array.isArray(q.options_latex) && q.options_latex.length === 4 && Number.isFinite(Number(q.answer_index));
        if (valid) return q;
        // Fallback: generate from lesson topic if seed is too noisy
        try {
          const fallbackSystem = 'You are an expert Algebra II assessment writer. Generate ONE high-quality MCQ for the given lesson. Return STRICT JSON only matching the schema.';
          const fallbackUser = [
            `LESSON: ${lessonTitle||lessonSlug}`,
            'Topic focus: Mixed Domain Applications (functions: domain/range under transformations).',
            'JSON SCHEMA: {"question":{"stimulus_text":"string","stimulus_latex":"string","stimulus_mathjson":{},"options_latex":["string","string","string","string"],"options_mathjson":[{},{},{},{}],"answer_index":0,"answer_plain":"string","answer_mathjson":{},"rationale_text":"string","rationale_latex":"string","difficulty":"easy|medium|hard"}}',
            'Constraints: 4 options; exactly one correct; difficulty medium; all math LaTeX in \\(...\\); include MathJSON for all math fields.'
          ].join('\n');
          const fbBody = { model:'gpt-4o', response_format:{ type:'json_object' }, input:[ { role:'system', content: fallbackSystem }, { role:'user', content: fallbackUser } ], temperature: 0 };
          const fbRsp = await fetch('https://api.openai.com/v1/responses', { method:'POST', headers, body: JSON.stringify(fbBody) });
          const fbJ = await fbRsp.json().catch(()=>({}));
          let fbTxt = ''; try { fbTxt = String(fbJ.output_text||'').trim(); } catch { fbTxt = ''; }
          if (!fbTxt || fbTxt === '[object Object]'){
            try { fbTxt = JSON.stringify(fbJ); } catch {}
          }
          let fbOut = {}; try { fbOut = JSON.parse(fbTxt); } catch{}
          const fbQ = fbOut && fbOut.question || {};
          const ok = fbQ && Array.isArray(fbQ.options_latex) && fbQ.options_latex.length === 4 && Number.isFinite(Number(fbQ.answer_index));
          if (ok) return fbQ;
        } catch{}
        return null;
      }

      function toInlineMath(s){
        const t = String(s||'').trim();
        if (!t) return '';
        if (/^\\\(|\\\[/.test(t)) return t;
        return `\\(${t}\\)`;
      }
      function dedupeOptionsSimple(opts){
        const seen = new Set();
        const out = [];
        for (const o of opts){
          const k = String(o||'').replace(/\s+/g,'').toLowerCase();
          if (seen.has(k)) { out.push(toInlineMath(`${o}~`)); }
          else { seen.add(k); out.push(toInlineMath(o)); }
        }
        return out.slice(0,4);
      }

      const inserted = [];
      const nowIso = new Date().toISOString();
      for (const seed of seeds){
        const q = await callOne(seed);
        if (!q) continue;
        const options = dedupeOptionsSimple(q.options_latex||[]);
        const answerIdx = Math.max(0, Math.min(3, Number(q.answer_index)||0));
        const answer = options[answerIdx] || options[0];
        const doc = {
          lessonSlug,
          lessonTitle: lessonTitle||lessonSlug,
          book: resolveBookForLessonFromRepo(lessonSlug) || null,
          stem: String(q.stimulus_latex||q.stimulus_text||seed.promptLatex||seed.prompt||'').slice(0, 1000),
          options,
          correct: answerIdx,
          solution: String(q.rationale_latex||q.rationale_text||'').slice(0, 2000),
          answer: toInlineMath(answer||''),
          answerPlain: String(q.answer_plain||'').slice(0, 200),
          citations: [],
          difficulty: (/easy|medium|hard/i.test(String(q.difficulty||'')) ? String(q.difficulty).toLowerCase() : 'medium'),
          sourceHash: sha256Hex(lessonSlug+'|'+(q.stimulus_latex||q.stimulus_text||'')+'|'+options.join('|')),
          generatedAt: nowIso,
          generator: 'agent1-qsources'
        };
        try { await col.insertOne(doc); inserted.push({ stem: doc.stem, difficulty: doc.difficulty }); } catch{}
      }
      await client.close();
      return res.json({ ok:true, seeds: seeds.length, inserted: inserted.length, sample: inserted.slice(0,5) });
    } catch (e){ console.error('[agent1-from-qsources] exception', e); return res.status(500).json({ error:'agent1_from_qsources_exception', detail: String(e && e.message || e) }); }
  });

  // Promote qsources OCR prompts directly into questionbank as readable items (non-LaTeX OK)
  app.post('/ai/agent1/promote-qsources', async (req, res) => {
    try {
      const lessonSlug = String(req.query.lesson||'').trim();
      const lessonTitle = String((req.body && req.body.title) || req.query.title || lessonSlug).trim();
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || req.body && req.body.limit || 20)));
      if (!lessonSlug) return res.status(400).json({ error:'lesson required' });
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const qsrc = await getQSourcesCollection(client);
      const col = await getQuestionCollection(client);
      // Pull latest qsources items for this lesson
      const seeds = await qsrc.find({ lessonSlug, sourceType:'worksheet-ocr' }).sort({ createdAt: -1 }).limit(limit).toArray();
      const nowIso = new Date().toISOString();
      let inserted = 0; const sample = [];
      for (const s of seeds){
        const stemText = String(s.promptLatex || s.prompt || '').trim();
        if (!stemText) continue;
        const options = ['(A)','(B)','(C)','(D)'];
        const doc = {
          lessonSlug,
          lessonTitle: lessonTitle || lessonSlug,
          book: resolveBookForLessonFromRepo(lessonSlug) || null,
          stem: stemText,
          options,
          correct: 0,
          solution: '',
          answer: options[0],
          answerPlain: 'A',
          citations: [],
          difficulty: 'medium',
          sourceHash: sha256Hex(lessonSlug+'|'+stemText),
          generatedAt: nowIso,
          generator: 'qsources-promote'
        };
        try {
          await col.insertOne(doc);
          inserted++;
          if (sample.length < 5) sample.push({ stem: doc.stem, difficulty: doc.difficulty });
        } catch {}
      }
      await client.close();
      return res.json({ ok:true, promoted: inserted, sample });
    } catch (e){ console.error('[promote-qsources] exception', e); return res.status(500).json({ error:'promote_qsources_exception', detail: String(e && e.message || e) }); }
  });

  // Agent 1: Generate and store ≥30 questions for a lesson
  app.post('/ai/agent1/generate', async (req, res) => {
    const lessonSlug = String(req.query.lesson || '').trim();
    const lessonTitle = String(req.body && req.body.title || req.query.title || lessonSlug).trim();
    let book = String((req.query && req.query.book) || (req.body && req.body.book) || '').trim() || null;
    const targetParam = Number(req.query.target || req.body && req.body.target || 0);
    const targetEnv = Number(process.env.TBP_AGENT1_TARGET || 0);
    const targetDesired = Math.max(1, Math.min(40, Number.isFinite(targetParam) && targetParam>0 ? targetParam : (Number.isFinite(targetEnv) && targetEnv>0 ? targetEnv : 15)));
    const debug = String(req.query.debug || '').toLowerCase() === '1' || String(req.query.debug || '').toLowerCase() === 'true';
    const trace = [];
    const t0 = Date.now();
    const addTrace = (step, meta) => { try { trace.push({ step, tMs: Date.now() - t0, ...(meta||{}) }); } catch {} };
    if (!lessonSlug) return res.status(400).json({ error: 'lesson (slug) is required' });
    try {
      addTrace('start', { lessonSlug, lessonTitle, book, targetDesired });
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect(); addTrace('db_connected');
      const col = await getQuestionCollection(client);
      const ing = await getIngestCollection(client);

      // Resolve book automatically if not provided
      if (!book) { try { book = resolveBookForLessonFromRepo(lessonSlug); } catch {} }
      addTrace('book_resolved', { book });

      // Global pause: skip all Agent1 generation when toggled via env
      try {
        const pauseAllFlag = String(process.env.TBP_PAUSE_AGENT1 || process.env.TBP_PAUSE_ALL || '').toLowerCase();
        const pauseAll = pauseAllFlag === '1' || pauseAllFlag === 'true' || pauseAllFlag === 'yes';
        if (pauseAll){
          addTrace('paused_all');
          await client.close();
          const out = { ok:true, paused:true, reason:'agent1_paused', book, lesson: lessonSlug, inserted: 0, attempts: 0 };
          if (debug) Object.assign(out, { trace });
          return res.json(out);
        }
      } catch {}

      // Temporary pause: skip Chemistry generation when toggled via env
      try {
        const pauseFlag = String(process.env.TBP_PAUSE_CHEMISTRY || process.env.TBP_PAUSE_CHEM || '').toLowerCase();
        const pauseChemistry = pauseFlag === '1' || pauseFlag === 'true' || pauseFlag === 'yes';
        const isChemistry = (book && /chemistry/i.test(String(book))) || /chemistry/i.test(String(lessonTitle));
        if (pauseChemistry && isChemistry){
          addTrace('paused_chemistry');
          await client.close();
          const out = { ok:true, paused:true, reason:'chemistry_paused', book, lesson: lessonSlug, inserted: 0, attempts: 0 };
          if (debug) Object.assign(out, { trace });
          return res.json(out);
        }
      } catch {}

      // Cap per-request generation size to avoid provider/edge timeouts; allow override via ?batch=
      const perBatch = Math.max(1, Math.min(Number(req.query.batch || 10), targetDesired));
      const target = targetDesired; // exact target per lesson
      const maxAttempts = 12; // give more tries to reach exact target
      const seen = new Set();
      const docs = [];
      let deletedCount = 0;
      let attempts = 0;
      addTrace('config', { perBatch, target, maxAttempts });
      const requireVisual = String(req.query.require || '').toLowerCase();
      let visualNote = requireVisual === 'graph'
        ? 'REQUIREMENT: Include a minimal graph under "graph.expressions" relevant to the item.'
        : requireVisual === 'table'
        ? 'REQUIREMENT: Include a concise table under "table" with headers and rows relevant to the item.'
        : requireVisual === 'numberline'
        ? 'REQUIREMENT: Include a compact number line under "numberLine" (min, max, points or intervals) relevant to the item.'
        : '';
      // Science courses (e.g., Chemistry): forbid graphs and number lines; allow small tables only when necessary
      if ((book && /chemistry/i.test(String(book))) || /chemistry/i.test(String(lessonTitle))){
        visualNote = 'STRICT: Do NOT include any "graph" or "numberLine" structures. Include a small "table" only if truly necessary to solve the item.';
      }
      // Prefer ingested chunks for the lesson, fall back to model-only
      try { await ingestLocalTextbooks(ing); addTrace('ingest_local_done'); } catch { addTrace('ingest_local_skip'); }
      const chunks = await ing.find({ $or:[ { lessonSlug }, { lessonSlug: null } ] }).limit(500).toArray();
      addTrace('context_loaded', { chunks: chunks.length });
      const contextText = chunks && chunks.length ? chunks.slice(0,40).map(c=> `p.${c.page}: ${c.text}`).join('\n\n') : '';
      function looksOffTopicForChemistry(stem, options){
        try {
          const s = String(stem||'').toLowerCase();
          const joined = [s, ...(Array.isArray(options)? options : [])].join(' ').toLowerCase();
          const hasChemWord = /(atom|isotope|electron|proton|neutron|atomic|mass|mole|gas|pressure|volume|temperature|acid|base|ph|bond|ionic|covalent|vsepr|polarity|metallic|solution|concentration|rate|equilibrium|enthalpy|entropy|energy|redox|nuclear|radioactive|half\-life|periodic|table|reaction|stoich|stoichiometry)/.test(joined);
          const hasMathDirectives = /(simplify|evaluate|solve|expression|factor|expand)/.test(s);
          const hasAlgebraLike = /\$?\s*[0-9]*\s*[a-df-z](?:\s*[+\-*/^]\s*[0-9a-z()]+)+/i.test(joined);
          return (!hasChemWord) || hasMathDirectives || hasAlgebraLike;
        } catch { return false; }
      }
      while (docs.length < target && attempts < maxAttempts){
        attempts++;
        const need = target - docs.length;
        const batchSize = Math.min(perBatch, need);
        const prompts = [(()=>{
          const base = buildLessonPrompt(lessonTitle, lessonSlug, batchSize);
          const withContext = contextText ? `${base}\n\nUse this textbook context (extract key facts, captions, tables, graphs):\n${contextText.substring(0, 8000)}` : base;
          return visualNote ? `${withContext}\n\n${visualNote}` : withContext;
        })()];
        const genModel = process.env.TBP_GENERATE_MODEL || process.env.TBP_DEFAULT_MODEL || 'gemini-1.5-flash';
        const tCall0 = Date.now();
        const txt = await callGeminiGenerate(genModel, prompts[0]).catch(()=> '');
        addTrace('llm_return', { attempt: attempts, ms: Date.now()-tCall0, model: genModel, size: (txt||'').length });
        const all = [];
        {
          try {
            const m = txt.match(/```json[\s\S]*?```/i);
            const raw = m ? m[0].replace(/```json/i,'').replace(/```/,'').trim() : (txt.trim().startsWith('{')? txt.trim(): null);
            if (!raw) continue;
            const j = JSON.parse(raw);
            // Legacy shape: { problems: [{ stem, options, correct, explanation }] }
            if (j && Array.isArray(j.problems)) all.push(...j.problems);
            // New schema shape: { questions: [ { stimulus_text, stimulus_latex, options_latex[4], answer_index, rationale_text, rationale_latex } ] }
            if (j && Array.isArray(j.questions)) {
              for (const q of j.questions){
                const stem = String(q.stimulus_latex || q.stimulus_text || '').trim();
                const options = Array.isArray(q.options_latex) ? q.options_latex.slice(0,4).map(String) : [];
                const correct = Math.max(0, Math.min(3, Number(q.answer_index||0)));
                const explanation = String(q.rationale_text || q.rationale_latex || '').trim();
                all.push({ stem, options, correct, explanation });
              }
            }
            addTrace('llm_parse', { attempt: attempts, parsed: all.length });
          } catch {}
        }
        for (const p of all){
        const stem = String(p && p.stem || '').trim();
        let options = Array.isArray(p && p.options) ? p.options.slice(0,4).map(String) : [];
        // Pre-normalize rounding-style distractors
        options = adjustOptionsForRounding(stem, options);
        let correct = Math.max(0, Math.min(3, Number(p && p.correct || 0)));
        const explanation = String(p && p.explanation || '').trim();
        if (!stem || options.length !== 4) continue;
        if (book && /chemistry/i.test(String(book))){
          if (looksOffTopicForChemistry(stem, options)) continue;
        }
        // Ensure all four options are distinct (by plain-text semantics) and keep correct index stable
        try { const dedup = dedupeOptions(options, correct); options = dedup.options; correct = dedup.correctIdx; } catch{}
        const key = normalizeStem(stem);
        if (seen.has(key)) continue; seen.add(key);
        const sourceHash = sha256Hex(lessonSlug + '||' + stem + '||' + options.join('||'));
        const difficulty = computeDifficulty(stem, explanation);
          // optional visuals (omit unless provided and minimal)
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
          // Do not auto-synthesize graphs; only keep if author provided
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
      // Only replace existing questions if we achieved the full target
      if (docs.length >= target){
        try { const del = await col.deleteMany({ lessonSlug }); deletedCount = del.deletedCount || 0; addTrace('db_deleted_old', { deletedCount }); } catch { addTrace('db_delete_failed'); }
        if (docs.length){ try { await col.insertMany(docs, { ordered: false }); addTrace('db_inserted_new', { inserted: docs.length }); } catch { addTrace('db_insert_failed'); } }
        // Post-insert safety: trigger fixer to canonicalize and dedupe options for this lesson
        try {
          const baseUrl = (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim()) || `http://127.0.0.1:${process.env.PORT||8080}`;
          // Fire-and-forget to avoid extending this request duration (prevents render 502 timeouts)
          setTimeout(() => {
            fetch(`${baseUrl}/ai/fix-duplicates?lesson=${encodeURIComponent(lessonSlug)}`, { method:'POST' }).catch(()=>{});
            // Agent 3: sample review/repair of ~10% of newly inserted items
            fetch(`${baseUrl}/ai/agent3/review-lesson?lesson=${encodeURIComponent(lessonSlug)}&pct=10`, { method:'POST' }).catch(()=>{});
          }, 0);
          addTrace('post_insert_kicked');
        } catch {}
      }
      await client.close();
      const out = { ok:true, deleted: deletedCount, inserted: docs.length, attempts };
      if (debug) Object.assign(out, { trace });
      return res.json(out);
    } catch (e){ console.error(e); return res.status(500).json({ error:'generation_failed' }); }
  });

  // Agent 2: Retrieve random 10 for a lesson
  app.get('/ai/agent2/questions', async (req, res) => {
    const lessonSlug = String(req.query.lesson || '').trim();
    const n = Math.max(1, Math.min(60, Number(req.query.n || 15)));
    const book = String(req.query.book || '').trim();
    const ordered = String(req.query.ordered || '').trim();
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
      // Final top-up: if still short, allow repeats to guarantee n items (with replacement)
      if (docs.length < n){
        const remaining = n - docs.length;
        const extra2 = await col.aggregate([
          { $match: (book ? { lessonSlug, book } : { lessonSlug }) },
          { $sample: { size: remaining } }
        ]).toArray();
        docs = docs.concat(extra2);
      }
      // optional ordering easy->medium->hard
      if (ordered === '1' || /true|yes/i.test(ordered)){
        const byBand = { easy: [], medium: [], hard: [] };
        for (const d of docs){
          if (d && typeof d.difficulty === 'string' && byBand[d.difficulty]) byBand[d.difficulty].push(d);
          else byBand.medium.push(d);
        }
        docs = [...byBand.easy, ...byBand.medium, ...byBand.hard];
      }

      // Strict formatting pass: ensure LaTeX-wrapped options and stimulus consistency
      try {
        docs = docs.map(d => {
          try {
            const out = { ...d };
            if (Array.isArray(out.options)) out.options = out.options.map(toInlineLatex);
            if (typeof out.answer === 'string') out.answer = toInlineLatex(out.answer);
            if (typeof out.stem === 'string') out.stem = out.stem; // stems rendered client-side; keep as-is
            return out;
          } catch { return d; }
        });
      } catch {}
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
        const enrichModel = process.env.TBP_ENRICH_MODEL || process.env.TBP_DEFAULT_MODEL || 'gemini-1.5-flash';
        const j = await callGeminiJSON(enrichModel, instruction);
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

  // ===== Agent 3: Verifier/Editor (sample review/repair of Agent 1 output) =====
  const AGENT3_SYSTEM = [
    'You are Agent 3, the Verifier/Editor for math MCQs.',
    'OBJECTIVE',
    '- Review or repair MCQ items generated by Agent 1 to ensure quality, coherence, and pedagogical soundness while preserving mathematical truth.',
    'NON-NEGOTIABLE RULES',
    '1) Do NOT change the correct mathematics or the answer_index.',
    '2) LaTeX must be clean:',
    '   - Inline math: \\( ... \\)',
    '   - Display math: \\[ ... \\\]',
    '   - No $...$, no Unicode math symbols (√, ×, −, …), balanced braces.',
    '3) Options:',
    '   - Exactly N options (given in policy.require_options), all LaTeX inline.',
    '   - Exactly one correct; others are plausible, distinct, on-topic distractors.',
    '   - "Related but different": distractors are near-miss variants; no cosmetic duplicates.',
    '4) Rationale:',
    '   - Short tutor-level explanation in plain text + optional worked steps in LaTeX.',
    '   - Must align with the correct solution and reference the same method.',
    '5) Citations: If provided, keep relevant to the concept.',
    '6) Difficulty: Judge reasonableness only; do not inflate difficulty.',
    'MODES',
    '- repair: Modify ONLY problematic fields (options and/or rationale) to comply, WITHOUT changing the correct result or answer_index.',
    'POLICY',
    '- require_options=4, inline_regex=\\(.*?\\), display_regex=\\[.*?\\]'
  ].join('\n');

  async function agent3RepairOne(model, doc){
    try {
      const payload = {
        mode: 'repair',
        policy: { require_options: 4, inline_regex: "\\\\(.*?\\\\)", display_regex: "\\\\[.*?\\\\]" },
        item: {
          stem: String(doc.stem||''),
          options_latex: Array.isArray(doc.options)? doc.options.slice(0,4).map(String) : [],
          answer_index: Number(doc.correct||0),
          rationale_text: String(doc.solution||doc.explanation||''),
          rationale_latex: '',
          sources: Array.isArray(doc.citations)? doc.citations : [],
          difficulty: String(doc.difficulty||'medium')
        }
      };
      const instruction = `${AGENT3_SYSTEM}\nReturn STRICT JSON for the repaired item only. Input:\n${JSON.stringify(payload, null, 2)}`;
      const j = await callGeminiJSON(model, instruction);
      if (!j || typeof j !== 'object') return null;
      const out = { ...doc };
      try {
        if (Array.isArray(j.options_latex) && j.options_latex.length === 4){
          // keep correct index
          const idx = Number(j.answer_index);
          if (Number.isFinite(idx) && idx>=0 && idx<=3){ out.correct = idx; }
          out.options = j.options_latex.map(toInlineLatex);
          // dedupe deterministically and keep correct index stable
          try { const d = dedupeOptions(out.options, out.correct); out.options = d.options; out.correct = d.correctIdx; } catch{}
          out.answer = out.options[out.correct] || '';
          out.answerPlain = stripLatexToPlain(out.answer);
        }
      } catch {}
      try { if (typeof j.rationale_text === 'string') out.solution = j.rationale_text; } catch{}
      try { if (Array.isArray(j.sources)) out.citations = j.sources; } catch{}
      return out;
    } catch { return null; }
  }

  app.post('/ai/agent3/review-lesson', async (req, res) => {
    const lessonSlug = String(req.query.lesson || '').trim();
    const pct = Math.max(1, Math.min(100, Number(req.query.pct || 10)));
    if (!lessonSlug) return res.status(400).json({ error: 'lesson (slug) is required' });
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      const total = await col.countDocuments({ lessonSlug });
      const sampleSize = Math.max(1, Math.floor(total * (pct/100)));
      const docs = await col.aggregate([
        { $match: { lessonSlug } },
        { $sample: { size: sampleSize } }
      ]).toArray();
      const model = process.env.TBP_VERIFY_MODEL || process.env.TBP_DEFAULT_MODEL || 'gemini-1.5-flash';
      let reviewed = 0, repaired = 0, marked = 0;
      for (const d of docs){
        reviewed++;
        const fixed = await agent3RepairOne(model, d);
        if (fixed){
          // Final duplicate check
          const plainSet = new Set((fixed.options||[]).map(stripLatexToPlain));
          const hasDup = plainSet.size < (fixed.options||[]).length;
          if (hasDup){
            // try one more dedupe pass
            try { const d2 = dedupeOptions(fixed.options, fixed.correct); fixed.options = d2.options; fixed.correct = d2.correctIdx; fixed.answer = fixed.options[fixed.correct]||''; fixed.answerPlain = stripLatexToPlain(fixed.answer); } catch{}
          }
          const hasDup2 = new Set((fixed.options||[]).map(stripLatexToPlain)).size < (fixed.options||[]).length;
          if (hasDup2){
            await col.updateOne({ _id: d._id }, { $set: { needsReplacement: true, reviewedBy: 'agent3', reviewedAt: new Date().toISOString() } });
            marked++;
          } else {
            await col.updateOne({ _id: d._id }, { $set: {
              options: fixed.options,
              correct: fixed.correct,
              answer: fixed.answer,
              answerPlain: fixed.answerPlain,
              solution: fixed.solution || fixed.explanation || '',
              citations: fixed.citations || d.citations || [],
              reviewedBy: 'agent3', reviewedAt: new Date().toISOString()
            } });
            repaired++;
          }
        }
      }
      await client.close();
      return res.json({ ok:true, lesson: lessonSlug, sampled: sampleSize, reviewed, repaired, marked_for_replacement: marked });
    } catch (e){ console.error(e); return res.status(500).json({ error: 'agent3_failed' }); }
  });

  // ===== Agent 4: Verification (determine correct index using LLM) =====
  // Agent 4 removed: stub returns null and endpoints return 410
  async function agent4DecideCorrectIndex(){ return null; }

  // Single-item verify
  app.post('/ai/agent4/verify', async (req, res) => {
    return res.status(410).json({ error: 'gone', message: 'Agent 4 has been removed. Verification is handled inline.' });
  });

  // Bulk verify for a lesson
  app.post('/ai/agent4/verify-lesson', async (req, res) => {
    return res.status(410).json({ error: 'gone', message: 'Agent 4 has been removed. Use inline consistency checks.' });
  });

  // Apply Agent 4 decided corrections to mismatched items
  app.post('/ai/agent4/apply-corrections', async (req, res) => {
    return res.status(410).json({ error: 'gone', message: 'Agent 4 has been removed. Corrections are applied at insert time.' });
  });

  // Verify and correct a single question by _id
  app.post('/ai/agent4/verify-one', async (req, res) => {
    return res.status(410).json({ error: 'gone', message: 'Agent 4 has been removed. Use /ai/fix-duplicates or regenerate.' });
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
  async function runDailyRefresh(limit, offset, wipe, target){
    const startedAt = new Date();
    const startStrNY = startedAt.toLocaleString('en-US', { timeZone: 'America/New_York', hour12:false });
    console.log(`[refresh] start ${startStrNY}`);
    let total = 0, ok = 0, fail = 0;
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      if (wipe){
        try { const delAll = await col.deleteMany({}); console.log(`[refresh] wiped all: ${delAll.deletedCount||0}`); } catch(e){ console.error('[refresh] wipe failed', e); }
      }
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
        const url1 = `${baseUrl}/ai/agent1/generate?lesson=${encodeURIComponent(slug)}${book?`&book=${encodeURIComponent(book)}`:''}${target?`&target=${encodeURIComponent(target)}`:''}`;
        const r1 = await fetch(url1, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title: slug, book }) });
          if (!r1.ok) throw new Error(`agent1 ${r1.status}`);
          try { await fetch(`${baseUrl}/ai/agent2/enrich?lesson=${encodeURIComponent(slug)}`, { method:'POST' }); } catch {}
          // Agent 4 removed: no verify call
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
      const wipe = String(req.query.wipe||'').toLowerCase() === '1' || String(req.query.wipe||'').toLowerCase() === 'true';
      const target = Number(req.query.target || 0) || undefined;
      const result = await runDailyRefresh(limit, offset, wipe, target);
      return res.json({ ok: true, ...result });
    } catch (e){
      console.error(e);
      return res.status(500).json({ error: 'refresh_failed' });
    }
  });

  // Scheduled loop (DISABLED by default). Enable only if REFRESH_ENABLED=1 (or TBP_REFRESH_ENABLED=true)
  (function scheduleDailyRefresh(){
    const enabledStr = String(process.env.REFRESH_ENABLED || process.env.TBP_REFRESH_ENABLED || '').toLowerCase();
    const enabled = (enabledStr === '1' || enabledStr === 'true');
    if (!enabled){
      console.log('[refresh] auto daily refresh disabled');
      return;
    }
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
      const target = Math.max(15, Number(req.query.target||0) || 15);
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
              // Agent 4 removed: no verify call
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

  // One-time fixer: scan existing questions and ensure unique options by canonical form
  app.post('/ai/fix-duplicates', async (req, res) => {
    try {
      const { lesson, id } = req.query || {};
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      let filter = lesson ? { lessonSlug: String(lesson).trim() } : {};
      if (id) {
        try { filter = { _id: new ObjectId(String(id)) }; } catch {}
      }
      const cur = col.find(filter).limit(20000);
      let inspected = 0, updated = 0;
      while (await cur.hasNext()){
        const d = await cur.next(); inspected++;
        try {
          if (!Array.isArray(d.options) || d.options.length !== 4) continue;
          const correct = Math.max(0, Math.min(3, Number(d.correct||0)));
          const beforeKeys = d.options.map(o => canonicalNumberOrFraction(o).key);
          const uniqueBefore = new Set(beforeKeys);
          if (uniqueBefore.size === 4){
            // still reduce/normalize fractions for consistency
            const normalized = dedupeOptions(d.options, correct);
            if (normalized.options.join('||') !== d.options.join('||')){
              await col.updateOne({ _id: d._id }, { $set: {
                options: normalized.options,
                correct: normalized.correctIdx,
                answer: normalized.options[normalized.correctIdx] || '',
                answerPlain: stripLatexToPlain(normalized.options[normalized.correctIdx] || ''),
                fixedAt: new Date().toISOString(), fixedBy: 'fix-duplicates'
              } });
              updated++;
            }
            continue;
          }
          const normalized = dedupeOptions(d.options, correct);
          const afterKeys = normalized.options.map(o => canonicalNumberOrFraction(o).key);
          if (new Set(afterKeys).size === 4){
            await col.updateOne({ _id: d._id }, { $set: {
              options: normalized.options,
              correct: normalized.correctIdx,
              answer: normalized.options[normalized.correctIdx] || '',
              answerPlain: stripLatexToPlain(normalized.options[normalized.correctIdx] || ''),
              fixedAt: new Date().toISOString(), fixedBy: 'fix-duplicates'
            } });
            updated++;
          }
        } catch {}
      }
      await client.close();
      return res.json({ ok:true, inspected, updated });
    } catch (e){ console.error(e); return res.status(500).json({ error:'fix_duplicates_failed' }); }
  });

  // Admin: delete questions by book or lesson
  app.post('/ai/delete-questions', async (req, res) => {
    try {
      const { book, lesson, lessonRegex } = Object(req.query || {});
      if (!book && !lesson && !lessonRegex) return res.status(400).json({ error:'specify book or lesson or lessonRegex' });
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      const filter = {};
      if (book) filter.book = String(book).trim();
      if (lesson) filter.lessonSlug = String(lesson).trim();
      if (lessonRegex) filter.lessonSlug = { $regex: String(lessonRegex) };
      const r = await col.deleteMany(filter);
      await client.close();
      return res.json({ ok:true, deleted: r && r.deletedCount || 0, filter });
    } catch (e){ console.error(e); return res.status(500).json({ error:'delete_failed' }); }
  });

  // Extract structured problems from PNG URLs using GPT-4o (Vision) and store in questionbank
  app.post('/ai/worksheet/extract', async (req, res) => {
    try {
      const { lessonSlug, title, school, teacher, worksheetType, images, studentFullName, studentEmail, examTitle, examDate } = req.body || {};
      if (!lessonSlug) return res.status(400).json({ error:'lessonSlug required' });
      const urls = Array.isArray(images) ? images.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)) : [];
      if (!urls.length) return res.status(400).json({ error:'images (PNG URLs) required' });

      const openaiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
      if (!openaiKey) return res.status(500).json({ error:'missing_OPENAI_API_KEY' });
      const OpenAI = require('openai');
      const oai = new OpenAI({ apiKey: openaiKey });

      const normalizedStudentName = (studentFullName || '').toString().trim();
      const normalizedStudentEmail = (studentEmail || '').toString().trim();
      const normalizedExamTitle = (examTitle || '').toString().trim();
      const normalizedExamDate = (examDate || '').toString().trim();

      // Utility: LLM second-pass to pick the correct option index strictly
      async function secondPassPickIndex(stem, options){
        const sys = 'Return ONLY JSON {"answer_index": <0-5 integer>} for the correct option index (zero-based). No prose.';
        const user = {
          role:'user',
          content:[
            { type:'text', text: [
              'Problem:', stem,
              '\nOptions (0-based):',
              options.map((o,i)=>`${i}: ${o}`).join('\n'),
              '\nTask: Return ONLY JSON of the form {"answer_index": N} with the zero-based correct index.'
            ].join('\n') }
          ]
        };
        try {
          const r = await oai.chat.completions.create({
            model:'gpt-4o', temperature:0, response_format:{ type:'json_object' },
            messages:[ { role:'system', content: sys }, user ]
          });
          const txt = r?.choices?.[0]?.message?.content || '';
          const obj = JSON.parse(txt);
          const idx = Number(obj?.answer_index);
          if (Number.isInteger(idx) && idx >= 0 && idx <= 5) return idx;
        } catch(_e){ /* ignore */ }
        return null;
      }

      // Utility: LLM generator to create MC options (4-5) and the correct index
      async function generateOptionsForProblem(stem){
        const sys = [
          'Return ONLY JSON {"options":[TexField...],"answer_index":0-5}. ',
          'First SOLVE the problem to obtain the correct answer. ',
          'Then generate 3–4 plausible, systematic distractors based on common mistakes (e.g., sign errors, rounding, unit conversion, misapplied identities). ',
          'Produce 4 or 5 total options with EXACTLY ONE correct choice. Prefer LaTeX for math.'
        ].join('');
        const schema = { type:'object', additionalProperties:false, properties:{ options:{ type:'array', minItems:4, maxItems:6, items:{ $ref:'#/$defs/TexField' } }, answer_index:{ type:'integer', minimum:0, maximum:5 } }, required:['options','answer_index'] };
        const user = { role:'user', content:[ { type:'text', text: [
          'Task: Solve the problem, then generate multiple-choice options (4 or 5). Exactly one is correct; others are systematic distractors. ',
          'Prefer LaTeX in TexField.latex; use TexField.text if LaTeX not applicable. Return ONLY JSON.',
          '\nProblem:', stem
        ].join('\n') } ] };
        try {
          const r = await oai.chat.completions.create({
            model:'gpt-4o', temperature:0, response_format:{ type:'json_object' },
            messages:[ { role:'system', content: sys + ' Schema: ' + JSON.stringify(schema) }, user ]
          });
          const txt = r?.choices?.[0]?.message?.content || '';
          const obj = JSON.parse(txt);
          if (obj && Array.isArray(obj.options) && obj.options.length >= 4 && Number.isInteger(obj.answer_index)){
            return obj;
          }
        } catch(_e){ /* ignore */ }
        return null;
      }

      // Utility: very simple numeric evaluation – tries to find a numeric result and match an option
      function tryNumericSolve(stem, options){
        try {
          // naive extraction: last line with basic math tokens
          const m = (stem.match(/[0-9][0-9\s\.+\-*/^()]+/g) || []).pop();
          if (!m) return null;
          const value = math.evaluate(m);
          const num = Number(value);
          if (!isFinite(num)) return null;
          // compare with options parsed as numbers (strip LaTeX if present)
          const parsed = options.map(o => {
            const s = String(o||'').replace(/\\\(|\\\)|\$\$?|\\\[|\\\]/g,'').trim();
            const n = Number(s.replace(/[^0-9.+\-eE]/g,''));
            return isFinite(n) ? n : NaN;
          });
          let bestIdx = null; let bestDelta = Infinity;
          parsed.forEach((n,i)=>{
            if (!isNaN(n)){
              const d = Math.abs(n - num);
              if (d < bestDelta){ bestDelta = d; bestIdx = i; }
            }
          });
          if (bestIdx !== null && bestDelta <= 1e-6) return bestIdx;
        } catch(_e){ /* ignore */ }
        return null;
      }

      // Answer-key extraction: map of { number, answer_index }
      async function extractAnswerKeyMap(imageUrls){
        const schema = { type:'object', properties:{ answers:{ type:'array', items:{ type:'object', properties:{ number:{ type:'string' }, answer_index:{ type:'integer', minimum:0, maximum:5 } }, required:['number','answer_index'], additionalProperties:false } } }, required:['answers'], additionalProperties:false };
        const sys = 'Return ONLY JSON matching schema {"answers":[{"number":"...","answer_index":0-5}]}.';
        const content = [ { type:'text', text:'Extract answer mapping: problem number to zero-based option index. Return ONLY JSON.' } ];
        for (const u of imageUrls){ content.push({ type:'image_url', image_url:{ url:u } }); }
        try {
          const r = await oai.chat.completions.create({ model:'gpt-4o', temperature:0, response_format:{ type:'json_object' }, messages:[ { role:'system', content: sys + ' Schema: ' + JSON.stringify(schema) }, { role:'user', content } ] });
          const txt = r?.choices?.[0]?.message?.content || '';
          const obj = JSON.parse(txt);
          if (obj && Array.isArray(obj.answers)) return obj.answers;
        } catch(_e){ /* ignore */ }
        return [];
      }

      // System prompt and schema (latex-first with plaintext fallback)
      const systemPrompt = [
        'You are an expert educational content parser. Read each worksheet image and convert it into structured JSON that follows the schema exactly.',
        'Capture the problem number (if present), any instructions, the main question text, and the final answer ONLY.',
        'Do NOT create or infer multiple-choice options. Prefer LaTeX in math fields and use plain text for non-math fields.',
        'Return ONLY strict JSON that validates against the schema. If uncertain, produce an empty but schema-compliant object with minimal required fields.'
      ].join(' ');

      const jsonSchema = {
        type: 'object', additionalProperties: false,
        properties: {
          title: { $ref: '#/$defs/TexField' },
          school: { $ref: '#/$defs/TexField' },
          teacher: { $ref: '#/$defs/TexField' },
          student_full_name: { type: 'string', description: 'Student full name associated with this worksheet.', default: '' },
          student_email: { type: 'string', description: 'Student email address associated with this worksheet.', default: '' },
          exam_title: { $ref: '#/$defs/TexField' },
          problems: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                number: { type: 'string' },
                question_text: { $ref: '#/$defs/TexField' },
                instruction: { $ref: '#/$defs/TexField' },
                answer: { $ref: '#/$defs/TexField' },
                difficulty: { type: 'string', enum: ['easy','medium','hard'] }
              },
              required: ['question_text','answer']
            }
          }
        },
        required: ['title','problems'],
        $defs: {
          TexField: {
            type: 'object', additionalProperties: false,
            oneOf: [ { required: ['latex'] }, { required: ['text'] } ],
            properties: {
              latex: { type:'string', minLength:1, description:'LaTeX content WITHOUT surrounding $...$, $$...$$, \\[...\\], or \\(...\\). Use pure LaTeX body.' },
              text:  { type:'string', minLength:1, description:'Plaintext fallback if LaTeX is not applicable.' }
            }
          }
        }
      };

      // Helper to choose TexField as plain string (prefer latex, else text)
function texFieldToString(tf){
  if (!tf) return '';
  if (typeof tf === 'string') return tf.trim();
  if (tf.latex && typeof tf.latex === 'string' && tf.latex.trim()) return String(tf.latex).trim();
  if (tf.text && typeof tf.text === 'string' && tf.text.trim()) return String(tf.text).trim();
  return '';
}

function normalizeLatex(value){
  try {
    let s = String(value || '');
    if (!s) return '';
    // Normalize superscripts like x^2 -> x^{2}, e.g., handles optional sign or multiple chars until whitespace or delimiter
    s = s.replace(/\^(?!\{)([-+]?(?:\\[a-zA-Z]+|[A-Za-z0-9]+))/g, '^{$1}');
    // Collapse multiple spaces
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  } catch {
    return String(value || '');
  }
}

      // If this is an Answer Key batch, extract mapping and update existing questions
      if ((worksheetType||'').toLowerCase().includes('answer')){
        const answers = await extractAnswerKeyMap(urls);
        const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        await client.connect();
        const col = await getQuestionCollection(client);
        let updated = 0;
        for (const a of answers){
          const filter = { lessonSlug, problemNumber: String(a.number||'').trim() };
          const upd = { $set: { correct: Number(a.answer_index)||0, validated:true, validationMethod:'answer_key' } };
          const r = await col.updateMany(filter, upd);
          updated += (r?.modifiedCount || 0);
        }
        await client.close();
        return res.json({ ok:true, mode:'answer_key', mapped: answers.length, updated });
      }

      const groups = urls.map(u => [u]);
      const concurrencyLimit = Math.max(1, Math.min(Number(process.env.WORKSHEET_EXTRACT_CONCURRENCY) || 4, 8));

      async function runGroup(group){
        const messages = [
          { role: 'system', content: systemPrompt + ' Schema: ' + JSON.stringify(jsonSchema) }
        ];
        const content = [];
        content.push({ type:'text', text: [
          `Context:`,
          school ? `School: ${school}` : '',
          teacher ? `Teacher: ${teacher}` : '',
          worksheetType ? `Worksheet Type: ${worksheetType}` : '',
          normalizedStudentName ? `Student Full Name: ${normalizedStudentName}` : '',
          normalizedStudentEmail ? `Student Email: ${normalizedStudentEmail}` : '',
          `Task: Extract title and problems. Prefer LaTeX in TexField.latex; use TexField.text only if LaTeX is not applicable. Return ONLY JSON conforming to the schema.`,
          `When outputting JSON, copy the provided student name and email into "student_full_name" and "student_email" (use an empty string if not provided).`,
          `If an exam or quiz title is provided, mirror it in "exam_title" (leave as an empty TexField when not provided).`
        ].filter(Boolean).join('\n') });
        for (const u of group){ content.push({ type:'image_url', image_url: { url: u } }); }
        messages.push({ role:'user', content });

        try {
          const rsp = await oai.chat.completions.create({
            model: 'gpt-4o',
            temperature: 0,
            response_format: { type: 'json_object' },
            messages
          });
          const text = rsp && rsp.choices && rsp.choices[0] && rsp.choices[0].message && rsp.choices[0].message.content || '';
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.problems && Array.isArray(parsed.problems)) return parsed;
          } catch(_err){ /* ignore parse error */ }
        } catch (err) {
          console.error('[worksheet-extract] vision request failed', err);
        }
        return null;
      }

      async function runConcurrentGroups(list, limit){
        if (!list.length) return [];
        const cappedLimit = Math.max(1, Math.min(limit, list.length));
        const results = new Array(list.length);
        let cursor = 0;
        const workers = Array.from({ length: cappedLimit }, () => (async function worker(){
          while (true){
            let idx;
            if (cursor >= list.length) break;
            idx = cursor++;
            try {
              results[idx] = await runGroup(list[idx]);
            } catch (err){
              console.error('[worksheet-extract] group worker error', err);
              results[idx] = null;
            }
          }
        })());
        await Promise.all(workers);
        return results;
      }

      const collected = [];
      const groupOutputs = await runConcurrentGroups(groups, concurrencyLimit);
      groupOutputs.forEach(parsed => {
        if (parsed && parsed.problems && Array.isArray(parsed.problems)) collected.push(parsed);
      });

      // Merge collected results
      let finalTitle = (title || '').trim();
      let finalExamTitle = normalizedExamTitle;
      let finalStudentName = normalizedStudentName;
      let finalStudentEmail = normalizedStudentEmail;
      const merged = [];
      for (const block of collected){
        if (!finalTitle){ finalTitle = texFieldToString(block.title) || finalTitle; }
        if (!finalExamTitle){
          const extractedExamTitle = texFieldToString(block.exam_title);
          if (extractedExamTitle) finalExamTitle = extractedExamTitle;
        }
        if (!finalStudentName){
          const extractedName = texFieldToString(block.student_full_name);
          if (extractedName) finalStudentName = extractedName;
        }
        if (!finalStudentEmail){
          const extractedEmail = texFieldToString(block.student_email);
          if (extractedEmail) finalStudentEmail = extractedEmail;
        }
        for (const p of (block.problems||[])){
          const num = String(p.number||'').trim();
          const text = normalizeLatex(texFieldToString(p.question_text));
          const instruction = normalizeLatex(texFieldToString(p.instruction));
          const answer = normalizeLatex(texFieldToString(p.answer));
          const difficulty = (p.difficulty||'').toString().toLowerCase();
          merged.push({ number: num, text, instruction, answer, difficulty, rawQuestion:p });
        }
      }

      // Validate and prepare docs
      const nowIso = new Date().toISOString();
      const storedStudentName = (finalStudentName || normalizedStudentName || '').toString().trim();
      const storedStudentEmail = (finalStudentEmail || normalizedStudentEmail || '').toString().trim();
      const storedExamTitle = (finalExamTitle || normalizedExamTitle || '').toString().trim();
      const validatedDocs = [];
      for (const m of merged){
        if (!m.text) continue;
        m.options = [];
        const normalizedStem = normalizeLatex(m.text || '').slice(0, 4000);
        const normalizedInstruction = normalizeLatex(m.instruction || '').slice(0, 2000) || '';
        const answerText = normalizeLatex(m.answer || '').slice(0, 4000);
        const validationMethod = answerText ? 'answer_only' : null;
        const isValidated = !!answerText;
        validatedDocs.push({
          lessonSlug,
          lessonTitle: finalTitle || lessonSlug,
          school: school || null,
          teacher: teacher || null,
          worksheetType: worksheetType || null,
          studentFullName: storedStudentName || null,
          studentEmail: storedStudentEmail || null,
          examTitle: storedExamTitle || null,
          examDate: normalizedExamDate || null,
          problemNumber: m.number || null,
          stem: normalizedStem,
          instruction: normalizedInstruction,
          options: [],
          correct: null,
          solution: '',
          answer: answerText,
          answerPlain: stripLatexToPlain(answerText || ''),
          difficulty: (/easy|medium|hard/i.test(m.difficulty||'') ? m.difficulty : 'medium'),
          sourceHash: sha256Hex(`${lessonSlug}|${m.number||''}|${m.text||''}`),
          generatedAt: nowIso,
          generator: 'gpt4o-vision',
          validated: isValidated,
          validationMethod: validationMethod
        });
      }

      // Insert into questionbank
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const col = await getQuestionCollection(client);
      let inserted = 0;
      if (validatedDocs.length){
        try { const r = await col.insertMany(validatedDocs, { ordered: false }); inserted = (r && r.insertedCount) || validatedDocs.length; } catch { inserted = validatedDocs.length; }
      }
      await client.close();
      return res.json({
        ok: true,
        title: finalTitle || null,
        problems: validatedDocs.length,
        inserted,
        studentFullName: storedStudentName || null,
        studentEmail: storedStudentEmail || null,
        examTitle: storedExamTitle || null,
        examDate: normalizedExamDate || null
      });
    } catch (e){ console.error('[worksheet-extract] exception', e); return res.status(500).json({ error:'worksheet_extract_exception', detail:String(e && e.message || e) }); }
  });
}

bootstrap().catch(err => { console.error('Bootstrap error', err); process.exit(1); });
