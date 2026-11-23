import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findKeyBySecret, recordKeyUsageAndHistory, estimateTokens } from './key-store.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

// Load .env
const envPath = resolve(ROOT_DIR, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';

function getAuthKeyEntry(req) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const xKey = (req.headers['x-api-key'] || '').toString().trim();
  const secret = bearer || xKey;
  if (!secret) return null;
  return findKeyBySecret(secret, PROXY_API_KEY);
}

// Metrics store (last 24h)
const metrics = [];
function recordMetric(model, duration, status) {
  metrics.push({ model, duration, status, timestamp: Date.now() });
  if (metrics.length > 5000) metrics.shift();
}

function getStats() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = metrics.filter((m) => m.timestamp >= cutoff);
  const totalRequests = recent.length;
  const successCount = recent.filter((m) => m.status === 'success').length;
  const errorCount = recent.filter((m) => m.status === 'error').length;
  const rateLimitedCount = recent.filter((m) => m.status === 'rate_limited').length;
  const successRate = totalRequests ? Math.round((successCount / totalRequests) * 10000) / 100 : 0;
  const avgDuration = totalRequests
    ? Math.round(recent.reduce((s, m) => s + m.duration, 0) / totalRequests)
    : 0;
  const requestsByModel = {};
  for (const m of recent) {
    requestsByModel[m.model] = (requestsByModel[m.model] || 0) + 1;
  }
  return { totalRequests, successCount, errorCount, rateLimitedCount, successRate, avgDuration, requestsByModel };
}

// Cached live models from `agy models`
let cachedModels = [];
let modelsFetchedAt = 0;

async function getLiveModels() {
  if (cachedModels.length > 0 && Date.now() - modelsFetchedAt < 5 * 60 * 1000) {
    return cachedModels;
  }
  try {
    const { stdout } = await execFileAsync('agy', ['models'], { timeout: 15000 });
    const list = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('ERROR:') || line.includes('Fetching available models')) continue;
      const match = line.match(/^([a-zA-Z0-9._-]+)\s+(.+)$/);
      if (match) {
        list.push({
          id: match[1],
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'google-antigravity',
          description: match[2].trim(),
        });
      }
    }
    if (list.length > 0) {
      cachedModels = list;
      modelsFetchedAt = Date.now();
    }
  } catch (err) {
    console.error('Failed to fetch agy models:', err.message);
  }
  return cachedModels;
}

const MODEL_ALIASES = {
  'gemini-4-hydrogen': 'gemini-4-hydrogen-medium',
  'gemini-4-neon': 'gemini-4-neon-medium',
  'gemini-4-argon': 'gemini-4-argon-medium',
  'gemini-3.8-flash': 'gemini-3.8-flash-medium',
  'claude-opus-5-5': 'claude-opus-5-5-medium',
  'claude-sonnet-5-5': 'claude-sonnet-5-5-medium',
  'gpt-oss-120b': 'gpt-oss-120b-medium',
};

function resolveModel(requested) {
  if (!requested) return 'gemini-4-neon-low';
  return MODEL_ALIASES[requested] || requested;
}

function formatMessagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  if (messages.length === 1 && messages[0].role === 'user') {
    const c = messages[0].content;
    return typeof c === 'string' ? c : JSON.stringify(c);
  }
  return messages
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => p.text || '').join('\n')
            : '';
      return `[${m.role.toUpperCase()}]: ${text}`;
    })
    .join('\n\n');
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Private-Network': 'true',
    });
    return res.end();
  }

  if (req.method === 'GET' && path === '/health') {
    return sendJson(res, 200, { status: 'healthy', backend: 'agy-cli', port: PORT, auth: Boolean(PROXY_API_KEY) });
  }

  if (req.method === 'GET' && path === '/admin/api/metrics') {
    return sendJson(res, 200, { stats: getStats(), recentRequests: metrics.slice(-50).reverse() });
  }

  // Require valid API key for all OpenAI API endpoints
  const keyEntry = getAuthKeyEntry(req);
  if (!keyEntry || !keyEntry.enabled) {
    return sendJson(res, 401, {
      error: {
        message: 'Invalid or disabled API key. Provide Authorization: Bearer <API_KEY>.',
        type: 'authentication_error',
      },
    });
  }

  if (keyEntry.tokenLimit > 0 && keyEntry.tokensUsed >= keyEntry.tokenLimit) {
    return sendJson(res, 429, {
      error: {
        message: `Token limit exceeded for key "${keyEntry.name}" (${keyEntry.tokensUsed}/${keyEntry.tokenLimit}).`,
        type: 'rate_limit_error',
      },
    });
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    const data = await getLiveModels();
    return sendJson(res, 200, { object: 'list', data });
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    const startTime = Date.now();
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    }

    const model = resolveModel(body.model);
    const prompt = formatMessagesToPrompt(body.messages);
    if (!prompt) {
      return sendJson(res, 400, { error: { message: 'Missing messages', type: 'invalid_request_error' } });
    }

    const isStream = Boolean(body.stream);
    const chatId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const args = ['-p', prompt, '--model', model, '--disable-slash-commands', '--output-format', 'text'];

    if (isStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const child = spawn('agy', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderrBuf = '';
      let outputBuf = '';

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        outputBuf += text;
        const payload = {
          id: chatId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      });

      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
      });

      child.on('close', (code) => {
        const duration = Date.now() - startTime;
        const status = code === 0 ? 'success' : 'error';
        recordMetric(model, duration, status);
        recordKeyUsageAndHistory({
          keyName: keyEntry.name,
          model,
          input: prompt,
          output: outputBuf || stderrBuf,
          status,
          defaultMasterKey: PROXY_API_KEY,
        });
        const endPayload = {
          id: chatId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        res.write(`data: ${JSON.stringify(endPayload)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      req.on('close', () => {
        if (!child.killed) child.kill('SIGTERM');
      });
      return;
    }

    // Non-streaming
    try {
      const { stdout } = await execFileAsync('agy', args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
      const content = stdout.trim();
      recordMetric(model, Date.now() - startTime, 'success');
      const rec = recordKeyUsageAndHistory({
        keyName: keyEntry.name,
        model,
        input: prompt,
        output: content,
        status: 'success',
        defaultMasterKey: PROXY_API_KEY,
      });
      return sendJson(res, 200, {
        id: chatId,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: rec.inTokens,
          completion_tokens: rec.outTokens,
          total_tokens: rec.totalTokens,
        },
      });
    } catch (err) {
      const errMsg = err.stderr?.trim() || err.message || 'agy execution failed';
      recordMetric(model, Date.now() - startTime, 'error');
      recordKeyUsageAndHistory({
        keyName: keyEntry.name,
        model,
        input: prompt,
        output: errMsg,
        status: 'error',
        defaultMasterKey: PROXY_API_KEY,
      });
      return sendJson(res, 500, {
        error: {
          message: errMsg,
          type: 'api_error',
        },
      });
    }
  }

  return sendJson(res, 404, { error: { message: `Route ${req.method} ${path} not found`, type: 'not_found_error' } });
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 AGY OpenAI Proxy listening on http://${HOST}:${PORT}`);
  console.log(`   POST /v1/chat/completions`);
  console.log(`   GET  /v1/models`);
  console.log(`   GET  /health`);
  getLiveModels();
});
