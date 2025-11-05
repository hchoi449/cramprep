/**
 * Worksheet processing pipeline
 *
 * Stages:
 *  - upload → mathpix → routing → (vision?) → llm → output
 *
 * The implementation keeps modules loosely coupled so they can be swapped or
 * unit-tested independently.
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { MongoClient } = require('mongodb');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';

const MATHPIX_APP_ID = process.env.MATHPIX_APP_ID;
const MATHPIX_APP_KEY = process.env.MATHPIX_APP_KEY;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function joinUrl(...segments){
  return segments
    .map((segment) => segment.replace(/(^\/+|\/+$)/g, ''))
    .filter(Boolean)
    .join('/');
}

async function withTimeout(promise, timeoutMs = DEFAULT_TIMEOUT_MS, message = 'Operation timed out'){
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutHandle);
    return result;
  } catch (err){
    clearTimeout(timeoutHandle);
    throw err;
  }
}

async function withRetry(fn, { retries = MAX_RETRIES, onRetry = () => {}, baseDelayMs = 500 } = {}){
  let attempt = 0;
  let lastErr;
  while (attempt <= retries){
    try {
      return await fn(attempt);
    } catch (err){
      lastErr = err;
      if (attempt === retries) break;
      const delayMs = baseDelayMs * 2 ** attempt + Math.random() * 250;
      await onRetry(err, attempt + 1, delayMs);
      await sleep(delayMs);
      attempt += 1;
    }
  }
  throw lastErr;
}

class MathpixClient {
  constructor({ appId, appKey, timeoutMs = DEFAULT_TIMEOUT_MS, logger = console }){
    if (!appId || !appKey){
      throw new Error('Mathpix credentials (MATHPIX_APP_ID & MATHPIX_APP_KEY) are required');
    }
    this.appId = appId;
    this.appKey = appKey;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.baseUrl = 'https://api.mathpix.com/v3';
  }

  async extractProblems(fileBuffer, filename){
    const start = performance.now();
    const base64 = fileBuffer.toString('base64');
    const uploadPayload = {
      filename: filename || 'worksheet.pdf',
      pdf: base64,
      formats: ['text', 'html', 'data'],
      data_options: {
        includes_layout_aspects: true,
        confidence_threshold: 0.1,
        include_asciimath: false
      }
    };

    const uploadResp = await this._post('/pdf', uploadPayload, { timeoutMs: this.timeoutMs });
    if (!uploadResp || !uploadResp.pdf_id){
      throw new Error('Mathpix did not return pdf_id');
    }
    const pdfId = uploadResp.pdf_id;

    const pollStart = performance.now();
    let statusResponse;
    await withRetry(async () => {
      statusResponse = await this._get(`/pdf/${pdfId}`, { timeoutMs: this.timeoutMs });
      if (statusResponse.status === 'completed'){
        return;
      }
      if (statusResponse.status === 'error'){
        throw new Error(`Mathpix processing failed: ${statusResponse.error}`);
      }
      throw new Error('PENDING');
    }, {
      retries: 6,
      baseDelayMs: 2_000,
      onRetry: async (err, attempt, delay) => {
        if (err.message !== 'PENDING') this.logger.warn('[Mathpix] retry due to', err.message);
        this.logger.info(`[Mathpix] waiting for job ${pdfId}. Attempt ${attempt}, retrying in ${(delay/1000).toFixed(1)}s`);
      }
    }).catch((err) => {
      if (err.message === 'PENDING'){
        throw new Error('Mathpix job timed out before completion');
      }
      throw err;
    });

    const problems = this._extractProblems(statusResponse);
    this.logger.info(`[Mathpix] Extracted ${problems.length} problem(s) in ${((performance.now() - start)/1000).toFixed(2)}s (poll ${((performance.now() - pollStart)/1000).toFixed(2)}s)`);
    return problems;
  }

  _extractProblems(result){
    if (!result || !Array.isArray(result.data)){
      return [];
    }
    const problems = [];
    result.data.forEach((page, pageIndex) => {
      const pageProblems = Array.isArray(page.problems) ? page.problems : [];
      pageProblems.forEach((problem, problemIndex) => {
        problems.push({
          page: pageIndex + 1,
          index: problems.length,
          question_index: problemIndex,
          instruction: problem.instruction || null,
          text: problem.text || problem.plaintext || '',
          latex: problem.latex || null,
          options: problem.choices || null,
          diagrams: problem.figures || problem.diagrams || [],
          raw: problem
        });
      });
    });
    return problems;
  }

  async _post(endpoint, payload, { timeoutMs } = {}){
    const url = `${this.baseUrl}${endpoint}`;
    const response = await withTimeout(fetch(url, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        app_id: this.appId,
        app_key: this.appKey
      },
      body: JSON.stringify(payload)
    }), timeoutMs, 'Mathpix POST request timed out');
    if (!response.ok){
      const text = await response.text().catch(() => '');
      throw new Error(`Mathpix POST failed (${response.status}): ${text}`);
    }
    return response.json();
  }

  async _get(endpoint, { timeoutMs } = {}){
    const url = `${this.baseUrl}${endpoint}`;
    const response = await withTimeout(fetch(url, {
      method: 'GET',
      headers: {
        app_id: this.appId,
        app_key: this.appKey
      }
    }), timeoutMs, 'Mathpix GET request timed out');
    if (!response.ok){
      const text = await response.text().catch(() => '');
      throw new Error(`Mathpix GET failed (${response.status}): ${text}`);
    }
    return response.json();
  }
}

function needsVision(problem){
  if (!problem) return false;
  const diagrams = problem.diagrams || problem.raw?.figures || problem.raw?.diagrams;
  if (Array.isArray(diagrams) && diagrams.length){
    return true;
  }
  if (Array.isArray(problem.raw?.images) && problem.raw.images.length){
    return true;
  }
  const hint = problem.raw?.diagram_detected || problem.raw?.has_diagram;
  return Boolean(hint);
}

class VisionClient {
  constructor({ apiKey = OPENAI_API_KEY, model = OPENAI_VISION_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, logger = console }){
    if (!apiKey){
      throw new Error('OPENAI_API_KEY is required for vision processing');
    }
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.baseUrl = 'https://api.openai.com/v1/responses';
  }

  async extractVisualContext(problem){
    const diagrams = problem.diagrams || problem.raw?.figures || problem.raw?.diagrams || problem.raw?.images || [];
    if (!diagrams.length){
      throw new Error('No diagram payload available for vision processing');
    }
    const prompt = this._buildVisionPrompt(problem);
    const imagePayload = diagrams.slice(0, 1).map((diagram) => ({
      type: 'input_image',
      image_url: typeof diagram === 'string' && diagram.startsWith('http')
        ? diagram
        : `data:image/png;base64,${diagram.data || diagram.base64 || diagram}`
    }));

    const body = {
      model: this.model,
      input: [
        ...imagePayload,
        {
          type: 'text',
          text: prompt
        }
      ]
    };

    const response = await this._post(body);
    const content = response?.output?.[0]?.content || response?.choices?.[0]?.message?.content;
    if (!content){
      throw new Error('Vision response missing content');
    }
    if (Array.isArray(content)){
      const textPart = content.find((part) => part.type === 'output_text' || part.type === 'text');
      return textPart?.text || textPart?.value || '';
    }
    return typeof content === 'string' ? content : JSON.stringify(content);
  }

  _buildVisionPrompt(problem){
    const context = [
      'You are a math diagram interpreter.',
      'Analyze the provided diagram image and summarize all relevant visual details (points, labels, relationships, axes, shapes).',
      'Focus on quantitative information that could influence the solution.',
      'Return a concise JSON object with keys such as "entities", "relationships", "measurements", or "notes".'
    ];
    if (problem.text){
      context.push('Associated problem text:', problem.text);
    }
    return context.join('\n');
  }

  async _post(body){
    const response = await withRetry(async () => {
      const res = await withTimeout(fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      }), this.timeoutMs, 'OpenAI Vision request timed out');
      if (!res.ok){
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI Vision error (${res.status}): ${text}`);
      }
      return res.json();
    }, {
      onRetry: async (err, attempt, delay) => {
        this.logger.warn(`[Vision] Retry ${attempt} in ${(delay/1000).toFixed(1)}s due to ${err.message}`);
      }
    });
    return response;
  }
}

class LlmClient {
  constructor({ apiKey = OPENAI_API_KEY, model = OPENAI_TEXT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, logger = console }){
    if (!apiKey){
      throw new Error('OPENAI_API_KEY is required for LLM processing');
    }
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.baseUrl = 'https://api.openai.com/v1/chat/completions';
  }

  async solveProblem(problem, { visualContext } = {}){
    const prompt = this._buildPrompt(problem, visualContext);
    const payload = {
      model: this.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a precise mathematics tutor. Return JSON with keys answer, explanation, and optionally topic and difficulty. Ensure the answer is fully simplified (exact values, reduced fractions, rationalized denominators).'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    };

    const response = await withRetry(async () => {
      const res = await withTimeout(fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(payload)
      }), this.timeoutMs, 'LLM request timed out');
      if (!res.ok){
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI LLM error (${res.status}): ${text}`);
      }
      return res.json();
    }, {
      onRetry: async (err, attempt, delay) => {
        this.logger.warn(`[LLM] Retry ${attempt} in ${(delay/1000).toFixed(1)}s due to ${err.message}`);
      }
    });

    const rawContent = response?.choices?.[0]?.message?.content;
    if (!rawContent){
      throw new Error('LLM returned no content');
    }
    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      parsed = { answer: rawContent };
    }
    return parsed;
  }

  _buildPrompt(problem, visualContext){
    const lines = [
      'Problem:',
      problem.text || problem.raw?.plaintext || problem.raw?.text || '',
      ''
    ];
    if (problem.latex){
      lines.push('LaTeX representation:', problem.latex, '');
    }
    if (problem.options?.length){
      lines.push('Options:', JSON.stringify(problem.options), '');
    }
    if (visualContext){
      lines.push('Diagram context (JSON):', typeof visualContext === 'string' ? visualContext : JSON.stringify(visualContext), '');
    }
    lines.push('Provide the solution as JSON with keys: answer, explanation, (optional) topic, (optional) difficulty.');
    lines.push('The answer must be fully simplified (reduce fractions, rationalize denominators, combine like terms, and avoid approximations unless necessary).');
    return lines.join('\n');
  }
}

function createLogger(){
  return {
    info: (...args) => console.log('[Worksheet]', ...args),
    warn: (...args) => console.warn('[Worksheet][WARN]', ...args),
    error: (...args) => console.error('[Worksheet][ERROR]', ...args)
  };
}

async function processWorksheet(filePath, options = {}){
  const logger = options.logger || createLogger();
  const mathpix = new MathpixClient({ appId: MATHPIX_APP_ID, appKey: MATHPIX_APP_KEY, logger });
  const vision = new VisionClient({ logger });
  const llm = new LlmClient({ logger });

  const absolutePath = path.resolve(filePath);
  const fileBuffer = fs.readFileSync(absolutePath);

  const problems = await mathpix.extractProblems(fileBuffer, path.basename(absolutePath));
  if (!problems.length){
    logger.warn('No problems detected by Mathpix.');
    return [];
  }

  const results = [];
  const tasks = problems.map((problem, order) => ({
    order,
    problem
  }));

  await Promise.allSettled(tasks.map((task) => handleProblem(task, { vision, llm, logger, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS }))).then((settled) => {
    settled.forEach((result, idx) => {
      if (result.status === 'fulfilled'){
        results[idx] = result.value;
      } else {
        const { problem } = tasks[idx];
        results[idx] = {
          instruction: problem.instruction || null,
          text: problem.text || '',
          latex: problem.latex || null,
          options: problem.options || null,
          visual_context: null,
          answer: null,
          explanation: null,
          topic: null,
          difficulty: null,
          error: result.reason?.message || String(result.reason),
          page: problem.page || null,
          index: problem.index
        };
      }
    });
  });

  return results;
}

async function handleProblem({ problem, order }, { vision, llm, logger, timeoutMs }){
  const start = performance.now();
  const logPrefix = `[Problem ${order}]`;

  const result = {
    instruction: problem.instruction || null,
    text: problem.text || '',
    latex: problem.latex || null,
    options: problem.options || null,
    visual_context: null,
    answer: null,
    explanation: null,
    topic: null,
    difficulty: null,
    error: null,
    page: problem.page || null,
    index: problem.index
  };

  try {
    let visualContext = null;
    if (needsVision(problem)){
      logger.info(`${logPrefix} diagram detected. Routing to vision.`);
      const visionStart = performance.now();
      visualContext = await withTimeout(vision.extractVisualContext(problem), timeoutMs, 'Vision step timed out');
      logger.info(`${logPrefix} vision completed in ${((performance.now() - visionStart)/1000).toFixed(2)}s`);
      result.visual_context = visualContext;
    } else {
      logger.info(`${logPrefix} text-only problem. Skipping vision.`);
    }

    const solveStart = performance.now();
    const llmResponse = await withTimeout(llm.solveProblem(problem, { visualContext }), timeoutMs, 'LLM step timed out');
    result.answer = llmResponse.answer || null;
    result.explanation = llmResponse.explanation || null;
    result.topic = llmResponse.topic || null;
    result.difficulty = llmResponse.difficulty || null;
    logger.info(`${logPrefix} LLM completed in ${((performance.now() - solveStart)/1000).toFixed(2)}s`);
  } catch (err){
    logger.error(`${logPrefix} failed:`, err.message);
    result.error = err.message;
  } finally {
    logger.info(`${logPrefix} total time ${( (performance.now() - start)/1000).toFixed(2)}s`);
  }

  return result;
}

module.exports = {
  processWorksheet,
  persistWorksheetResults,
  MathpixClient,
  VisionClient,
  LlmClient,
  needsVision
};

if (require.main === module){
  (async () => {
    const filePath = process.argv[2];
    const worksheetId = process.argv[3] || `worksheet_${Date.now()}`;
    if (!filePath){
      console.error('Usage: node worksheet-pipeline.js <worksheet-file> [worksheet-id]');
      process.exit(1);
    }
    try {
      const results = await processWorksheet(filePath);
      const storeResults = String(process.env.WORKSHEET_RESULTS_STORE || '').toLowerCase();
      if (storeResults === '1' || ['true','yes','on'].includes(storeResults)){
        await persistWorksheetResults(results, {
          worksheetId,
          lessonSlug: process.env.WORKSHEET_LESSON_SLUG || null
        });
      }
      console.log(JSON.stringify(results, null, 2));
    } catch (err){
      console.error('Failed to process worksheet:', err);
      process.exit(1);
    }
  })();
}

async function persistWorksheetResults(results, { worksheetId, lessonSlug = null, logger = createLogger(), metadata = {} } = {}){
  if (!Array.isArray(results)){
    throw new Error('results must be an array');
  }
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGODB_URL;
  if (!mongoUri){
    throw new Error('MONGODB_URI is required to persist worksheet results');
  }

  const dbName = process.env.WORKSHEET_RESULTS_DB || process.env.MONGODB_DATABASE || 'thinkpod';
  const collectionName = process.env.WORKSHEET_RESULTS_COLLECTION || 'worksheet_results';

  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
  const start = performance.now();
  try {
    await client.connect();
    const collection = client.db(dbName).collection(collectionName);
    try {
      await collection.createIndex({ worksheetId: 1, index: 1 }, { unique: true });
    } catch (err){
      logger.warn('[Worksheet][persist] index creation skipped:', err.message);
    }

    const bulkOps = results.map((result) => ({
      updateOne: {
        filter: { worksheetId, index: result.index },
        update: {
          $set: {
            worksheetId,
            lessonSlug,
            index: result.index,
            page: result.page || null,
            instruction: result.instruction || null,
            text: result.text || '',
            latex: result.latex || null,
            options: result.options || null,
            visual_context: result.visual_context || null,
            answer: result.answer || null,
            explanation: result.explanation || null,
            topic: result.topic || null,
            difficulty: result.difficulty || null,
            error: result.error || null,
            metadata,
            updatedAt: new Date().toISOString()
          }
        },
        upsert: true
      }
    }));

    if (bulkOps.length){
      const outcome = await collection.bulkWrite(bulkOps, { ordered: false });
      logger.info(`[Worksheet][persist] upserted ${outcome.upsertedCount || 0} items, modified ${outcome.modifiedCount || 0}`);
    } else {
      logger.warn('[Worksheet][persist] no results to write');
    }
    logger.info(`[Worksheet][persist] completed in ${((performance.now() - start)/1000).toFixed(2)}s`);
  } finally {
    await client.close().catch(()=>{});
  }
}
