import express from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { exec, execSync } from 'child_process';

const CONFIG = resolve(homedir(), '.openclaw/openclaw.json');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

function read() { return JSON.parse(readFileSync(CONFIG, 'utf-8')); }
function write(cfg) { writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n'); }

function sanitize(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  for (const ch of Object.keys(c.channels || {})) {
    if (c.channels[ch].token) c.channels[ch].token = '•••••';
    if (c.channels[ch].webhook?.token) c.channels[ch].webhook.token = '•••••';
  }
  return c;
}

async function runCmd(cmd, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.substring(0, 500) || err.message));
      else resolve(stdout);
    });
  });
}

const CHANNEL_PLUGINS = {
  whatsapp: { name: 'WhatsApp', icon: '💬', npm: '@openclaw/whatsapp', authType: 'qr-pair', interactive: true },
  telegram: { name: 'Telegram', icon: '✈️', npm: '@openclaw/telegram', authType: 'token', interactive: false },
  discord: { name: 'Discord', icon: '🎮', npm: '@openclaw/discord', authType: 'token', interactive: false },
  signal: { name: 'Signal', icon: '🔒', npm: '@openclaw/signal', authType: 'cli', interactive: true },
  slack: { name: 'Slack', icon: '💼', npm: '@openclaw/slack', authType: 'oauth', interactive: true },
  googlechat: { name: 'Google Chat', icon: '💭', npm: '@openclaw/googlechat', authType: 'webhook', interactive: false },
  matrix: { name: 'Matrix', icon: '💬', npm: '@openclaw/matrix', authType: 'token', interactive: false },
  irc: { name: 'IRC', icon: '🔌', npm: '@openclaw/irc', authType: 'config', interactive: false },
  line: { name: 'Line', icon: '💚', npm: '@openclaw/line', authType: 'token', interactive: false },
  msteams: { name: 'MS Teams', icon: '💠', npm: '@openclaw/msteams', authType: 'webhook', interactive: false },
};

const GUIDES = {
  whatsapp: {
    steps: [
      'تأكد من أن هاتفك متصل بالإنترنت',
      'شغّل هذا الأمر في التيرمنال: <code>openclaw channels login --channel whatsapp</code>',
      'سيظهر رمز QR على الشاشة. امسحه من واتساب: الإعدادات → الأجهزة المرتبطة → ربط جهاز',
      'بعد الربط، أعد تشغيل البوابة: <code>openclaw gateway restart</code>',
      'تأكد من الاتصال: <code>openclaw channels status --channel whatsapp</code>'
    ],
    note: '💡 يمكن ربط عدة أرقام بإضافة --account لكل رقم',
    interactive: true,
    terminal: true
  },
  discord: {
    steps: [
      'ادخل على https://discord.com/developers/applications',
      'أنشئ تطبيق جديد > Bot > Reset Token',
      'انسخ التوكن',
      'عدّل ملف openclaw.json: ضع التوكن في channels.discord.token',
      'أو استخدم: <code>openclaw config set channels.discord.token "التوكن"</code>',
      'أضف البوت لسيرفرك عبر OAuth2 URL Generator',
      'أعد تشغيل البوابة'
    ], note: '🤖 بوت واحد لكل سيرفر', interactive: false, terminal: false
  },
  telegram: {
    steps: [
      'افتح @BotFather في تليجرام وأرسل /newbot',
      'اختر اسماً واحفظ التوكن',
      'ثبّت البرنامج: <code>openclaw plugins install @openclaw/telegram</code>',
      'سجّل الدخول: <code>openclaw channels login --channel telegram</code>',
      'أدخل التوكن عند الطلب',
      'أعد تشغيل البوابة'
    ], note: '🤖 بوت لكل وكيل إذا كان عندك عدة وكلاء', interactive: false, terminal: true
  },
};

function getGuide(id) {
  return GUIDES[id] || {
    steps: ['راجع التوثيق: https://docs.openclaw.ai/channels/' + id],
    note: '', interactive: false, terminal: false
  };
}

function isInstalled(id) {
  const cfg = read();
  return !!cfg.channels?.[id];
}

// ===== API ENDPOINTS =====
app.get('/api/config', (req, res) => res.json(sanitize(read())));
app.get('/api/config/channels', (req, res) => { const cfg = read(); res.json(cfg.channels || {}); });
app.get('/api/config/access-groups', (req, res) => { const cfg = read(); res.json(cfg.accessGroups || {}); });

app.patch('/api/config', (req, res) => {
  try { const cfg = read(); deepMerge(cfg, req.body); write(cfg); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/channels/available', (req, res) => {
  const cfg = read();
  const installed = Object.keys(cfg.channels || {});
  res.json(Object.entries(CHANNEL_PLUGINS).map(([id, m]) => ({
    id, ...m, installed: installed.includes(id), enabled: cfg.channels?.[id]?.enabled !== false
  })));
});

app.get('/api/channels/setup-guide/:id', (req, res) => res.json(getGuide(req.params.id)));

app.post('/api/channels/setup', async (req, res) => {
  const { id } = req.body;
  if (!id || !CHANNEL_PLUGINS[id]) return res.status(400).json({ error: 'قناة غير معروفة: ' + id });
  const guide = getGuide(id);
  const meta = CHANNEL_PLUGINS[id];

  // 1. Add to config
  const cfg = read();
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels[id]) {
    cfg.channels[id] = { enabled: true, dmPolicy: 'pairing' };
    write(cfg);
  }

  // 2. If interactive (WhatsApp, Signal), don't try to automate - just show guide
  if (meta.interactive) {
    return res.json({
      ok: true, channel: id, automated: false,
      message: 'هذه القناة تحتاج تفاعل يدوي عبر التيرمنال',
      guide, command: `openclaw channels login --channel ${id}`
    });
  }

  // 3. For token-based channels, try install
  try {
    const out = await runCmd(`openclaw plugins install ${meta.npm}`, 120000);
    res.json({ ok: true, channel: id, automated: true, output: out?.substring(0, 300), guide });
  } catch (e) {
    res.json({ ok: true, channel: id, partial: true,
      message: 'تم إعداد القناة لكن فشل تثبيت البرنامج تلقائياً. جرب: openclaw plugins install ' + meta.npm,
      guide, error: e.message });
  }
});

app.post('/api/channels/install-plugin', async (req, res) => {
  const { id } = req.body;
  const meta = CHANNEL_PLUGINS[id];
  if (!meta) return res.status(400).json({ error: 'قناة غير معروفة' });
  try {
    const out = await runCmd(`openclaw plugins install ${meta.npm}`, 180000);
    res.json({ ok: true, output: out?.substring(0, 400) });
  } catch (e) {
    res.json({ ok: false, partial: true,
      message: `جرب يدوياً في التيرمنال: openclaw plugins install ${meta.npm}`,
      error: e.message });
  }
});

app.post('/api/channels/check', async (req, res) => {
  // Check if a channel is actually working
  const { id } = req.body;
  const cfg = read();
  const isConfigured = !!cfg.channels?.[id];
  try {
    const status = await runCmd('openclaw channels status --channel ' + id + ' 2>&1', 15000);
    res.json({ ok: true, configured: isConfigured, working: !status.includes('Error'), output: status?.substring(0, 400) });
  } catch (e) {
    res.json({ ok: true, configured: isConfigured, working: false, error: e.message });
  }
});

// ===== CRUD for channels, access groups, agents =====
app.post('/api/config/channels/:id', (req, res) => {
  const { id } = req.params;
  const cfg = read();
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels[id]) cfg.channels[id] = { enabled: true };
  deepMerge(cfg.channels[id], req.body);
  write(cfg);
  res.json({ ok: true });
});
app.delete('/api/config/channels/:id', (req, res) => {
  const { id } = req.params;
  const cfg = read(); if (cfg.channels?.[id]) delete cfg.channels[id]; write(cfg);
  res.json({ ok: true });
});
app.post('/api/config/channels/:ch/allow-from', (req, res) => {
  const { ch } = req.params; const { sender } = req.body;
  const cfg = read(); if (!cfg.channels?.[ch]) return res.status(404).json({ error: 'not found' });
  if (!cfg.channels[ch].allowFrom) cfg.channels[ch].allowFrom = [];
  if (!cfg.channels[ch].allowFrom.includes(sender)) cfg.channels[ch].allowFrom.push(sender);
  write(cfg); res.json({ ok: true });
});
app.delete('/api/config/channels/:ch/allow-from/:sender', (req, res) => {
  const { ch, sender } = req.params;
  const cfg = read();
  if (cfg.channels?.[ch]?.allowFrom) cfg.channels[ch].allowFrom = cfg.channels[ch].allowFrom.filter(s => s !== sender);
  write(cfg); res.json({ ok: true });
});

app.post('/api/config/access-groups', (req, res) => {
  const { name, type, members } = req.body;
  const cfg = read(); if (!cfg.accessGroups) cfg.accessGroups = {};
  cfg.accessGroups[name] = { type: type || 'message.senders', members: members || {} };
  write(cfg); res.json({ ok: true });
});
app.post('/api/config/access-groups/:name/members', (req, res) => {
  const { channel, id } = req.body; const { name } = req.params;
  const cfg = read(); const g = cfg.accessGroups?.[name];
  if (!g) return res.status(404).json({ error: 'not found' });
  if (!g.members) g.members = {};
  if (!g.members[channel]) g.members[channel] = [];
  if (!g.members[channel].includes(id)) g.members[channel].push(id);
  write(cfg); res.json({ ok: true });
});
app.delete('/api/config/access-groups/:name/members/:channel/:id', (req, res) => {
  const { name, channel, id } = req.params;
  const cfg = read(); const g = cfg.accessGroups?.[name];
  if (g?.members?.[channel]) g.members[channel] = g.members[channel].filter(m => m !== id);
  write(cfg); res.json({ ok: true });
});
app.delete('/api/config/access-groups/:name', (req, res) => {
  const { name } = req.params;
  const cfg = read(); if (cfg.accessGroups?.[name]) delete cfg.accessGroups[name];
  write(cfg); res.json({ ok: true });
});

app.get('/api/agents', (req, res) => {
  const cfg = read(); res.json({ defaults: cfg.agents?.defaults || {}, list: cfg.agents?.list || [] });
});
app.post('/api/agents', (req, res) => {
  const { id, workspace, skills, tools } = req.body;
  const cfg = read(); if (!cfg.agents) cfg.agents = { defaults: {} };
  if (!cfg.agents.list) cfg.agents.list = [];
  if (cfg.agents.list.find(a => a.id === id)) return res.status(400).json({ error: 'موجود' });
  const a = { id }; if (workspace) a.workspace = workspace; if (skills) a.skills = skills; if (tools) a.tools = tools;
  cfg.agents.list.push(a); write(cfg); res.json({ ok: true });
});
app.delete('/api/agents/:id', (req, res) => {
  const { id } = req.params; const cfg = read();
  if (cfg.agents?.list) { const i = cfg.agents.list.findIndex(a => a.id === id); if (i > -1) cfg.agents.list.splice(i, 1); write(cfg); }
  res.json({ ok: true });
});

function deepMerge(t, s) {
  for (const k of Object.keys(s))
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) { if (!t[k] || typeof t[k] !== 'object') t[k] = {}; deepMerge(t[k], s[k]); }
    else t[k] = s[k];
}

const PORT = process.env.PORT || 3780;
app.listen(PORT, '0.0.0.0', () => console.log('🔧 Admin Panel → http://localhost:' + PORT + '\n   توثيق القنوات: https://docs.openclaw.ai/channels'));
