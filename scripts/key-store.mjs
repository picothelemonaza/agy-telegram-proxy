import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT_DIR, 'data');
const HISTORY_DIR = resolve(DATA_DIR, 'history');
const KEYS_FILE = resolve(DATA_DIR, 'keys.json');

function ensureDirs() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
}

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

export function loadKeys(defaultMasterKey = '') {
  ensureDirs();
  let keys = [];
  if (existsSync(KEYS_FILE)) {
    try {
      keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
    } catch {
      keys = [];
    }
  }
  if (defaultMasterKey && !keys.some((k) => k.key === defaultMasterKey)) {
    keys.unshift({
      name: 'master',
      key: defaultMasterKey,
      tokenLimit: 0, // 0 = unlimited
      tokensUsed: 0,
      requests: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    saveKeys(keys);
  }
  return keys;
}

export function saveKeys(keys) {
  ensureDirs();
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
}

export function findKeyBySecret(secret, defaultMasterKey = '') {
  const keys = loadKeys(defaultMasterKey);
  return keys.find((k) => k.key === secret) || null;
}

export function createApiKey(name, tokenLimit = 0, defaultMasterKey = '') {
  const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!cleanName) throw new Error('Tên key không hợp lệ (chỉ dùng chữ, số, _, -).');
  const keys = loadKeys(defaultMasterKey);
  if (keys.some((k) => k.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error(`Key tên "${cleanName}" đã tồn tại.`);
  }
  const newEntry = {
    name: cleanName,
    key: 'sk-agy-' + crypto.randomBytes(20).toString('hex'),
    tokenLimit: Math.max(0, Number(tokenLimit) || 0),
    tokensUsed: 0,
    requests: 0,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  keys.push(newEntry);
  saveKeys(keys);
  return newEntry;
}

export function deleteApiKey(name, defaultMasterKey = '') {
  const keys = loadKeys(defaultMasterKey);
  const idx = keys.findIndex((k) => k.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return false;
  keys.splice(idx, 1);
  saveKeys(keys);
  return true;
}

export function resetApiKeyUsage(name, defaultMasterKey = '') {
  const keys = loadKeys(defaultMasterKey);
  const entry = keys.find((k) => k.name.toLowerCase() === name.toLowerCase());
  if (!entry) return null;
  entry.tokensUsed = 0;
  entry.requests = 0;
  saveKeys(keys);
  return entry;
}

export function recordKeyUsageAndHistory({ keyName, model, input, output, status, defaultMasterKey = '' }) {
  ensureDirs();
  const inTokens = estimateTokens(input);
  const outTokens = estimateTokens(output);
  const totalTokens = inTokens + outTokens;

  const keys = loadKeys(defaultMasterKey);
  const entry = keys.find((k) => k.name === keyName);
  if (entry) {
    entry.tokensUsed = (entry.tokensUsed || 0) + totalTokens;
    entry.requests = (entry.requests || 0) + 1;
    saveKeys(keys);
  }

  const safeName = keyName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const histFile = resolve(HISTORY_DIR, `${safeName}.jsonl`);
  const record = {
    time: new Date().toISOString(),
    keyName,
    model,
    inTokens,
    outTokens,
    totalTokens,
    status,
    input: String(input || '').slice(0, 1000),
    output: String(output || '').slice(0, 1500),
  };
  appendFileSync(histFile, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

export function getKeyHistory(name, limit = 5) {
  ensureDirs();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const histFile = resolve(HISTORY_DIR, `${safeName}.jsonl`);
  if (!existsSync(histFile)) return [];
  const lines = readFileSync(histFile, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-limit)
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
