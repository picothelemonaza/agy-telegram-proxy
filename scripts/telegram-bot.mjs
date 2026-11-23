import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadKeys,
  createApiKey,
  deleteApiKey,
  resetApiKeyUsage,
  getKeyHistory,
} from './key-store.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

// Load .env manually (zero dependencies)
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

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? Number(process.env.ALLOWED_USER_ID) : null;
const PORT = process.env.PORT || '3000';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HEALTH_URL = `${BASE_URL}/health`;
const PROXY_API_KEY = process.env.PROXY_API_KEY || 'sk-antigravity-local';

if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${TOKEN}`;

let proxyProc = null;
let tunnelProc = null;
let publicUrl = null;
let startedAt = null;
const logBuffer = [];
const MAX_LOGS = 100;

function pushLog(source, chunk) {
  const lines = chunk.toString().split('\n').filter(Boolean);
  const ts = new Date().toISOString().slice(11, 19);
  for (const line of lines) {
    logBuffer.push(`[${ts} ${source}] ${line}`);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  }
}

async function tg(method, body = {}) {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🔑 Lấy Key & Link', callback_data: 'get_api_key' },
      { text: '🤖 Danh Sách Model', callback_data: 'models_usage' },
    ],
    [
      { text: '🗝️ Quản Lý Key', callback_data: 'manage_keys' },
      { text: '📜 Lịch Sử I/O', callback_data: 'history_master' },
    ],
    [
      { text: '⚡ Xem Hạn Mức (5H/1W)', callback_data: 'quota' },
      { text: '📊 Trạng Thái', callback_data: 'status' },
    ],
    [
      { text: '▶️ Bật', callback_data: 'start_proxy' },
      { text: '⏹ Tắt', callback_data: 'stop_proxy' },
      { text: '🔄 Chạy lại', callback_data: 'restart_proxy' },
    ],
  ],
};

function startProxy() {
  if (proxyProc && !proxyProc.killed) {
    return `Proxy is already running (PID: ${proxyProc.pid}).`;
  }
  const serverEntry = resolve(ROOT_DIR, 'scripts/agy-openai-proxy.mjs');
  if (!existsSync(serverEntry)) {
    return '❌ scripts/agy-openai-proxy.mjs not found.';
  }
  proxyProc = spawn(process.execPath, [serverEntry], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedAt = Date.now();
  logBuffer.length = 0;
  pushLog('SYS', `Started proxy (PID: ${proxyProc.pid})`);

  proxyProc.stdout.on('data', (d) => pushLog('OUT', d));
  proxyProc.stderr.on('data', (d) => pushLog('ERR', d));
  proxyProc.on('exit', (code, signal) => {
    pushLog('SYS', `Proxy exited (code=${code}, signal=${signal})`);
    proxyProc = null;
    startedAt = null;
  });

  startTunnel();
  return `✅ Proxy started (PID: ${proxyProc.pid}) on port ${PORT}.`;
}

function startTunnel() {
  if (tunnelProc && !tunnelProc.killed) return;
  try {
    tunnelProc = spawn('cloudflared', ['tunnel', '--url', BASE_URL, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && match[0] !== publicUrl) {
        publicUrl = match[0];
        pushLog('TUNNEL', `Public HTTPS URL: ${publicUrl}`);
        if (ALLOWED_USER_ID) {
          tg('sendMessage', {
            chat_id: ALLOWED_USER_ID,
            text: [
              '✅ *Hệ thống đã sẵn sàng!*',
              '',
              '📋 *Cách dùng (3 bước):*',
              '1. Mở app/web AI → chọn *OpenAI Compatible / Custom API*',
              `2. Dán *Base URL:*\n\`${publicUrl}/v1\``,
              `3. Dán *API Key:*\n\`${PROXY_API_KEY}\``,
              '',
              '_(Bấm vào chữ để copy nhanh)_',
            ].join('\n'),
            parse_mode: 'Markdown',
            reply_markup: MENU_KEYBOARD,
          }).catch(() => {});
        }
      }
    };
    tunnelProc.stdout.on('data', onData);
    tunnelProc.stderr.on('data', onData);
    tunnelProc.on('exit', () => {
      tunnelProc = null;
      publicUrl = null;
    });
  } catch (err) {
    pushLog('TUNNEL', `Failed to start cloudflared: ${err.message}`);
  }
}

function stopProxy() {
  if (tunnelProc && !tunnelProc.killed) {
    tunnelProc.kill('SIGTERM');
    tunnelProc = null;
    publicUrl = null;
  }
  if (!proxyProc || proxyProc.killed) {
    return 'Proxy is not running.';
  }
  const pid = proxyProc.pid;
  proxyProc.kill('SIGTERM');
  proxyProc = null;
  startedAt = null;
  return `⏹ Sent SIGTERM to proxy (PID: ${pid}) and tunnel.`;
}

async function checkHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    return `HTTP ${res.status}\n\`\`\`json\n${text.slice(0, 3000)}\n\`\`\``;
  } catch (err) {
    return `❌ Health check failed: ${err.message}`;
  }
}

async function getStatus() {
  const running = Boolean(proxyProc && !proxyProc.killed);
  const mins = running && startedAt ? Math.floor((Date.now() - startedAt) / 60000) : 0;
  const secs = running && startedAt ? Math.floor(((Date.now() - startedAt) / 1000) % 60) : 0;
  const uptime = running ? `${mins}p ${secs}s` : 'Đang tắt';
  return [
    '📊 *Trạng Thái Hệ Thống*',
    '',
    `• Máy chủ: ${running ? '🟢 Đang chạy' : '🔴 Đang tắt'}`,
    `• Thời gian chạy: *${uptime}*`,
    `• Link công khai: ${publicUrl ? `\`${publicUrl}/v1\`` : '⏳ Đang tạo link...'}`,
  ].join('\n');
}

function getLogs() {
  if (logBuffer.length === 0) return 'Chưa có nhật ký.';
  const recent = logBuffer.slice(-30).join('\n').slice(-3500);
  return `\`\`\`\n${recent}\n\`\`\``;
}

function getApiKeyInfo() {
  return [
    '🔑 *Thông Tin Kết Nối AI*',
    '',
    '📋 *Hướng dẫn nhanh (3 bước):*',
    '1️⃣ Chọn nhà cung cấp: *OpenAI Compatible / Custom*',
    '2️⃣ Copy *Base URL*:',
    publicUrl ? `\`${publicUrl}/v1\`` : '⏳ _Đang khởi tạo link, thử lại sau 5 giây..._',
    '3️⃣ Copy *API Key*:',
    `\`${PROXY_API_KEY}\``,
    '',
    '💡 _Bấm vào từng dòng trên để tự động copy._',
  ].join('\n');
}

async function fetchLiveAgyModels() {
  try {
    const { stdout } = await execFileAsync('agy', ['models'], { timeout: 15000 });
    const models = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('ERROR:') || line.includes('Fetching available models')) continue;
      const match = line.match(/^([a-zA-Z0-9._-]+)\s+(.+)$/);
      if (match) {
        models.push({ id: match[1], label: match[2].trim() });
      }
    }
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

async function fetchAgyQuota() {
  try {
    const { stdout } = await execFileAsync('agy', ['-p', '/usage', '--print-timeout', '15s'], { timeout: 20000 });
    const lines = stdout
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('ERROR:'));
    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

async function getQuotaReport() {
  const quota = await fetchAgyQuota();
  if (!quota) {
    return '❌ Could not fetch AGY usage via `agy -p /usage`.';
  }
  return `⚡ *AGY Quota (5H & Weekly)*\n\`\`\`\n${quota}\n\`\`\``;
}

async function getModelsAndUsage() {
  const [liveModels, quota] = await Promise.all([
    fetchLiveAgyModels(),
    fetchAgyQuota(),
  ]);
  let models = liveModels;
  let source = 'agy models (live)';

  let stats = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const [modelsRes, metricsRes] = await Promise.all([
      models ? Promise.resolve(null) : fetch(`${BASE_URL}/v1/models`, { signal: controller.signal }).catch(() => null),
      fetch(`${BASE_URL}/admin/api/metrics`, { signal: controller.signal }).catch(() => null),
    ]);
    clearTimeout(timer);

    if (!models && modelsRes && modelsRes.ok) {
      const modelsData = await modelsRes.json();
      models = (Array.isArray(modelsData.data) ? modelsData.data : []).map((m) => ({
        id: m.id,
        label: m.owned_by || 'proxy',
      }));
      source = 'proxy /v1/models';
    }

    if (metricsRes && metricsRes.ok) {
      const metricsData = await metricsRes.json();
      stats = metricsData.stats || null;
    }
  } catch {
    // Proxy may be stopped; still show live agy models
  }

  if (!models || models.length === 0) {
    return `❌ Could not fetch models from \`agy models\` or \`${BASE_URL}/v1/models\`.`;
  }

  const usageMap = stats?.requestsByModel || {};
  const lines = [`🤖 *Latest AGY Models & 24h Usage* _(${source})_`, ''];

  for (const m of models) {
    const count = usageMap[m.id] || 0;
    lines.push(`• \`${m.id}\` — ${m.label} (*${count}* reqs)`);
  }

  if (quota) {
    lines.push('', '⚡ *AGY Quota (5H & Weekly)*', '```', quota, '```');
  }

  if (stats) {
    lines.push(
      '',
      '📈 *24h Proxy Summary*',
      `• Total: *${stats.totalRequests}* | Success: *${stats.successRate}%*`,
      `• Errors: *${stats.errorCount}* | Rate-limited: *${stats.rateLimitedCount}*`,
      `• Avg latency: *${stats.avgDuration}ms*`
    );
  } else {
    lines.push('', '_Proxy metrics unavailable (proxy stopped)._');
  }

  return lines.join('\n');
}

function formatKeysList() {
  const keys = loadKeys(PROXY_API_KEY);
  const lines = ['🗝️ *Danh Sách API Key*', ''];
  for (const k of keys) {
    const limitStr = k.tokenLimit > 0 ? k.tokenLimit.toLocaleString() : '∞';
    const pct = k.tokenLimit > 0 ? ` (${Math.min(100, Math.round((k.tokensUsed / k.tokenLimit) * 100))}%)` : '';
    lines.push(
      `• *${k.name}* — ${k.tokensUsed.toLocaleString()} / ${limitStr} tokens${pct} (${k.requests || 0} reqs)`,
      `  \`${k.key}\``
    );
  }
  lines.push(
    '',
    '📌 *Lệnh nhanh:*',
    '• `/newkey <tên> <giới_hạn>` — Tạo key (vd: `/newkey banA 50000`, `0` = không giới hạn)',
    '• `/history <tên>` — Xem lịch sử Input/Output của key',
    '• `/resetkey <tên>` — Reset token về 0',
    '• `/delkey <tên>` — Xóa key'
  );
  return lines.join('\n');
}

function formatKeyHistory(name = 'master') {
  const items = getKeyHistory(name, 5);
  if (items.length === 0) {
    return `📜 Chưa có lịch sử Input/Output nào cho key *${name}*.\n_(Dùng \`/history <tên_key>\` để xem key khác)_`;
  }
  const lines = [`📜 *Lịch Sử Input/Output: ${name}* (5 gần nhất)`, ''];
  for (const item of items) {
    const t = item.time.replace('T', ' ').slice(5, 19);
    const inp = item.input.replace(/`/g, "'").slice(0, 220);
    const out = item.output.replace(/`/g, "'").slice(0, 300);
    lines.push(
      `🕒 \`${t}\` | *${item.model}* | ${item.inTokens}→${item.outTokens} tok`,
      `📥 *In:* ${inp}${item.input.length > 220 ? '…' : ''}`,
      `📤 *Out:* ${out}${item.output.length > 300 ? '…' : ''}`,
      '───'
    );
  }
  return lines.join('\n').slice(0, 3900);
}

async function handleAction(chatId, action, args = []) {
  let reply = '';
  switch (action) {
    case 'start_proxy':
      reply = startProxy();
      break;
    case 'stop_proxy':
      reply = stopProxy();
      break;
    case 'restart_proxy':
      stopProxy();
      await new Promise((r) => setTimeout(r, 800));
      reply = startProxy();
      break;
    case 'status':
      reply = await getStatus();
      break;
    case 'health':
      reply = await checkHealth();
      break;
    case 'logs':
      reply = getLogs();
      break;
    case 'get_api_key':
      reply = getApiKeyInfo();
      break;
    case 'models_usage':
      reply = await getModelsAndUsage();
      break;
    case 'quota':
      reply = await getQuotaReport();
      break;
    case 'manage_keys':
      reply = formatKeysList();
      break;
    case 'history_master':
      reply = formatKeyHistory(args[0] || 'master');
      break;
    case 'newkey': {
      const [name, limit] = args;
      if (!name) {
        reply = '❌ Cú pháp: `/newkey <tên> <giới_hạn_token>`\nVí dụ: `/newkey banA 50000` (hoặc `0` = không giới hạn)';
      } else {
        try {
          const entry = createApiKey(name, limit ?? 0, PROXY_API_KEY);
          const limitStr = entry.tokenLimit > 0 ? `${entry.tokenLimit.toLocaleString()} tokens` : 'Không giới hạn';
          reply = `✅ *Đã tạo key mới!*\n\n• Tên: *${entry.name}*\n• Giới hạn: *${limitStr}*\n• API Key:\n\`${entry.key}\`\n• Base URL:\n\`${publicUrl ? `${publicUrl}/v1` : `${BASE_URL}/v1`}\``;
        } catch (err) {
          reply = `❌ ${err.message}`;
        }
      }
      break;
    }
    case 'delkey': {
      const [name] = args;
      if (!name) {
        reply = '❌ Cú pháp: `/delkey <tên_key>`';
      } else {
        const ok = deleteApiKey(name, PROXY_API_KEY);
        reply = ok ? `🗑️ Đã xóa key *${name}*.` : `❌ Không tìm thấy key *${name}*.`;
      }
      break;
    }
    case 'resetkey': {
      const [name] = args;
      if (!name) {
        reply = '❌ Cú pháp: `/resetkey <tên_key>`';
      } else {
        const entry = resetApiKeyUsage(name, PROXY_API_KEY);
        reply = entry ? `🔄 Đã reset số token của *${entry.name}* về 0.` : `❌ Không tìm thấy key *${name}*.`;
      }
      break;
    }
    default:
      reply = [
        '👋 *Bảng Điều Khiển AI Proxy*',
        '',
        '• Bấm *🔑 Lấy Key & Link* để copy dán vào web/app',
        '• Bấm *🤖 Danh Sách Model* để xem tên model hỗ trợ',
        '• Bấm *⚡ Xem Hạn Mức* để kiểm tra % còn lại',
      ].join('\n');
  }
  await tg('sendMessage', {
    chat_id: chatId,
    text: reply,
    parse_mode: 'Markdown',
    reply_markup: MENU_KEYBOARD,
  });
}

let offset = 0;

async function poll() {
  console.log('Telegram control bot started. Polling for updates...');
  startProxy();
  if (ALLOWED_USER_ID) {
    await tg('sendMessage', {
      chat_id: ALLOWED_USER_ID,
      text: '👋 *Bot điều khiển AI đã bật!*\nĐang tạo link kết nối, bạn chờ vài giây hoặc bấm nút bên dưới nhé:',
      parse_mode: 'Markdown',
      reply_markup: MENU_KEYBOARD,
    }).catch(() => {});
  }

  while (true) {
    try {
      const data = await tg('getUpdates', { offset, timeout: 25 });
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          const msg = update.message;
          const cb = update.callback_query;
          const userId = msg?.from?.id ?? cb?.from?.id;
          const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;

          if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
            continue;
          }

          if (cb) {
            await tg('answerCallbackQuery', { callback_query_id: cb.id });
            await handleAction(chatId, cb.data);
          } else if (msg?.text) {
            const parts = msg.text.trim().split(/\s+/);
            const cmd = parts[0].replace(/^\//, '').split('@')[0].toLowerCase();
            const args = parts.slice(1);
            if (['start', 'menu', 'help'].includes(cmd)) {
              await handleAction(chatId, 'menu');
            } else if (['apikey', 'key', 'get_api_key'].includes(cmd)) {
              await handleAction(chatId, 'get_api_key');
            } else if (['keys', 'manage_keys'].includes(cmd)) {
              await handleAction(chatId, 'manage_keys');
            } else if (['newkey', 'delkey', 'resetkey'].includes(cmd)) {
              await handleAction(chatId, cmd, args);
            } else if (['history', 'hist'].includes(cmd)) {
              await handleAction(chatId, 'history_master', args);
            } else if (['model', 'models', 'models_usage'].includes(cmd)) {
              await handleAction(chatId, 'models_usage');
            } else if (['usage', 'quota'].includes(cmd)) {
              await handleAction(chatId, 'quota');
            } else if (['status', 'health', 'logs', 'start_proxy', 'stop_proxy', 'restart_proxy'].includes(cmd)) {
              await handleAction(chatId, cmd);
            } else {
              await handleAction(chatId, 'menu');
            }
          }
        }
      }
    } catch (err) {
      console.error('Poll error:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

process.on('SIGINT', () => {
  stopProxy();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopProxy();
  process.exit(0);
});

poll();
