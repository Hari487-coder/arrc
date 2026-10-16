// Jarvis Phone: laptop action server for a Sarvam Voice Agent.
// You call your Sarvam number, the agent decides what to do, and calls these HTTPS tools
// (through a cloudflared tunnel). Only a fixed allowlist of actions exists. No shell input
// from the caller ever reaches a command line.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
for (const line of (fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const PORT = Number(process.env.PORT || 3710);
const TOKEN = process.env.JARVIS_TOKEN || '';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const ALLOW_NO_CALLER = String(process.env.ALLOW_NO_CALLER || 'true') === 'true';
const OWNER_CALLER_ID = (process.env.OWNER_CALLER_ID || '').trim().toLowerCase();
const OWNER_HASHES = new Set(OWNER ? (() => {
  const ten = OWNER.slice(-10);
  const forms = [OWNER, `+${OWNER}`, ten, `0${ten}`, `+91${ten}`, `91${ten}`, `+91 ${ten}`];
  return forms.flatMap((f) => ['sha256', 'sha1', 'md5'].map((a) => crypto.createHash(a).update(f).digest('hex')));
})() : []);
let lastCaller = ''; // raw id of the most recent caller, shown only on the local /status page
const NOTES = path.join(os.homedir(), 'Documents', 'Jarvis Notes.md');

const activity = []; // newest first, shown on the live page
const recent = new Map(); // "action|input" -> { at, result promise }, for burst de-duplication
const DEDUPE_MS = 10_000;
function record(entry) {
  activity.unshift({ at: new Date().toLocaleTimeString('en-IN'), ...entry });
  activity.length = Math.min(activity.length, 50);
  console.log(`[${activity[0].at}]`, entry.action, JSON.stringify(entry.input || ''), '->', entry.result);
}

// ---------- safe launchers (fixed executables, argument arrays, no shell) ----------
const run = (file, args) => new Promise((resolve) => {
  const p = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => resolve(false));
  p.unref();
  setTimeout(() => resolve(true), 150);
});
const openUrl = (url) => run('explorer.exe', [url]); // default browser, URL passed as one argument
const ps = (cmd) => new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true, timeout: 8000 }, (e, out) => resolve(e ? '' : String(out).trim())));
// Fixed PowerShell scripts. Caller-supplied text only ever travels in env vars (JARVIS_*), never in the script.
const psEnv = (script, vars = {}, { detached = false } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...vars };
  if (detached) {
    const p = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true, env });
    p.on('error', () => resolve(false)); p.unref(); return setTimeout(() => resolve(true), 150);
  }
  execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 15000, env }, (e) => resolve(!e));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPEAK = 'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=0; $s.Speak($env:JARVIS_TEXT)';
const KEY = (code, times = 1) => `$w=New-Object -ComObject WScript.Shell; 1..${times} | % { $w.SendKeys([char]${code}); Start-Sleep -Milliseconds 40 }`;
const MEDIA = {
  play: [KEY(179), 'Toggled play and pause.'], pause: [KEY(179), 'Toggled play and pause.'], resume: [KEY(179), 'Toggled play and pause.'],
  next: [KEY(176), 'Skipped to the next track.'], previous: [KEY(177), 'Went back to the previous track.'], back: [KEY(177), 'Went back to the previous track.'],
  'volume up': [KEY(175, 6), 'Turned the volume up.'], louder: [KEY(175, 6), 'Turned the volume up.'],
  'volume down': [KEY(174, 6), 'Turned the volume down.'], quieter: [KEY(174, 6), 'Turned the volume down.'],
  mute: [KEY(173), 'Toggled mute.'], unmute: [KEY(173), 'Toggled mute.'],
};
const ROUTINES = {
  work: { say: 'Work mode on. Opening VS Code, Gmail and your calendar.', urls: ['https://mail.google.com', 'https://calendar.google.com'], apps: [['explorer.exe', ['vscode:']]] },
  study: { say: 'Study mode on. Lo-fi music and a fresh notepad.', urls: ['https://www.youtube.com/watch?v=jfKfPfyJRdk'], apps: [['notepad.exe', []]] },
  chill: { say: 'Chill mode on. Playing some music.', urls: ['https://www.youtube.com/results?search_query=arijit+singh+best+songs'], apps: [] },
  news: { say: 'Opening today\'s top news.', urls: ['https://news.google.com/home?hl=en-IN&gl=IN&ceid=IN:en'], apps: [] },
  demo: { say: 'Demo mode. Opening Sarvam and the Jarvis console.', urls: ['https://www.sarvam.ai', 'http://localhost:3710'], apps: [] },
};

const SITES = {
  youtube: 'https://www.youtube.com', gmail: 'https://mail.google.com', google: 'https://www.google.com',
  whatsapp: 'https://web.whatsapp.com', linkedin: 'https://www.linkedin.com', github: 'https://github.com',
  maps: 'https://maps.google.com', 'google maps': 'https://maps.google.com', calendar: 'https://calendar.google.com',
  'google calendar': 'https://calendar.google.com', drive: 'https://drive.google.com', 'google drive': 'https://drive.google.com',
  twitter: 'https://x.com', x: 'https://x.com', instagram: 'https://www.instagram.com', amazon: 'https://www.amazon.in',
  flipkart: 'https://www.flipkart.com', irctc: 'https://www.irctc.co.in', cricbuzz: 'https://www.cricbuzz.com',
  chatgpt: 'https://chatgpt.com', sarvam: 'https://www.sarvam.ai', netflix: 'https://www.netflix.com', spotify: 'https://open.spotify.com',
};
// App name -> [executable, args]. Fixed strings only.
const APPS = {
  notepad: ['notepad.exe', []], calculator: ['calc.exe', []], calc: ['calc.exe', []],
  chrome: ['cmd.exe', ['/c', 'start', '', 'chrome']], browser: ['cmd.exe', ['/c', 'start', '', 'chrome']],
  'vs code': ['explorer.exe', ['vscode:']], vscode: ['explorer.exe', ['vscode:']], 'visual studio code': ['explorer.exe', ['vscode:']], code: ['explorer.exe', ['vscode:']],
  'file explorer': ['explorer.exe', []], explorer: ['explorer.exe', []], files: ['explorer.exe', []],
  downloads: ['explorer.exe', [path.join(os.homedir(), 'Downloads')]], documents: ['explorer.exe', [path.join(os.homedir(), 'Documents')]],
  paint: ['mspaint.exe', []], camera: ['explorer.exe', ['microsoft.windows.camera:']], spotify: ['explorer.exe', ['spotify:']],
  settings: ['explorer.exe', ['ms-settings:']], 'task manager': ['taskmgr.exe', []], terminal: ['cmd.exe', ['/c', 'start', '', 'wt']],
  word: ['cmd.exe', ['/c', 'start', '', 'winword']], excel: ['cmd.exe', ['/c', 'start', '', 'excel']],
  powerpoint: ['cmd.exe', ['/c', 'start', '', 'powerpnt']], kivi: ['cmd.exe', ['/c', 'start', '', 'kivi']],
};
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
const norm = (s) => clean(s).toLowerCase().replace(/^(the|my)\s+/, '').replace(/[.!?]+$/, '');

// ---------- actions ----------
const ACTIONS = {
  async open_website({ input }) {
    const q = norm(input);
    if (!q) return 'Which website should I open?';
    let url = SITES[q];
    if (!url && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(q)) url = `https://${q}`;
    if (!url && /^https?:\/\/\S+$/i.test(clean(input))) url = clean(input);
    if (!url) url = `https://www.google.com/search?btnI=1&q=${encodeURIComponent(q + ' official site')}`;
    await openUrl(url);
    return `Opened ${q} in the browser.`;
  },
  async web_search({ input }) {
    const q = clean(input);
    if (!q) return 'What should I search for?';
    await openUrl(`https://www.google.com/search?q=${encodeURIComponent(q)}`);
    return `Searching Google for ${q}. The results are on your screen.`;
  },
  async play_youtube({ input }) {
    const q = clean(input);
    if (!q) return 'What should I play?';
    let id = null;
    try {
      const html = await (await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en-IN' }, signal: AbortSignal.timeout(6000) })).text();
      id = html.match(/"videoId":"([\w-]{11})"/)?.[1] || null;
    } catch {}
    await openUrl(id ? `https://www.youtube.com/watch?v=${id}` : `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`);
    return id ? `Playing ${q} on YouTube.` : `Opened YouTube results for ${q}.`;
  },
  async open_app({ input }) {
    const q = norm(input);
    const app = APPS[q];
    if (!app) {
      if (SITES[q]) return ACTIONS.open_website({ input: q });
      return `I can't open ${q || 'that'}. I can open notepad, calculator, chrome, VS Code, file explorer, downloads, paint, camera, settings, task manager, Word, Excel or PowerPoint.`;
    }
    const ok = await run(app[0], app[1]);
    return ok ? `Opened ${q}.` : `I tried to open ${q} but it did not start.`;
  },
  async take_note({ input }) {
    const text = clean(input);
    if (!text) return 'What should I write down?';
    fs.mkdirSync(path.dirname(NOTES), { recursive: true });
    if (!fs.existsSync(NOTES)) fs.writeFileSync(NOTES, '# Jarvis Notes\n\n');
    fs.appendFileSync(NOTES, `- ${new Date().toLocaleString('en-IN')}: ${text}\n`);
    return `Noted: ${text}.`;
  },
  async read_notes() {
    if (!fs.existsSync(NOTES)) return 'You have no notes yet.';
    const lines = fs.readFileSync(NOTES, 'utf8').split('\n').filter(l => l.startsWith('- ')).slice(-5);
    if (!lines.length) return 'You have no notes yet.';
    return `Your last ${lines.length} notes: ` + lines.map(l => l.replace(/^- [^:]+:\d\d:\d\d(?:\s?[ap]m)?:\s*/i, '').replace(/^- /, '')).join('. ') + '.';
  },
  async show_notes() {
    if (!fs.existsSync(NOTES)) return 'You have no notes yet.';
    await run('notepad.exe', [NOTES]);
    return 'Your notes are open on the screen.';
  },
  async system_status() {
    const raw = await ps('$b=Get-CimInstance Win32_Battery; if($b){"$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)"}else{"none"}');
    const now = new Date();
    const time = now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    const date = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    let battery = 'no battery reading';
    if (raw && raw !== 'none') {
      const [pct, st] = raw.split('|');
      battery = `battery at ${pct} percent, ${st === '2' ? 'charging' : 'on battery power'}`;
    }
    return `It is ${time} on ${date}. The laptop is on, ${battery}.`;
  },
  async lock_screen() {
    setTimeout(() => run('rundll32.exe', ['user32.dll,LockWorkStation']), 1500);
    return 'Locking your laptop now.';
  },

  // ----- the "wow" set: fixed keys, fixed URLs, or text that is only spoken/displayed -----
  async media_control({ input }) {
    const q = norm(input).replace(/^(the )?(music|song|video)\s*/, '').trim() || 'play';
    const hit = MEDIA[q] || Object.entries(MEDIA).find(([k]) => q.includes(k))?.[1];
    if (!hit) return 'I can play or pause, skip to next or previous, turn the volume up or down, or mute.';
    await psEnv(hit[0]);
    return hit[1];
  },
  async speak_on_laptop({ input }) {
    const text = clean(input);
    if (!text) return 'What should the laptop say?';
    await psEnv(SPEAK, { JARVIS_TEXT: text }, { detached: true });
    return `The laptop is saying: ${text}`;
  },
  async take_screenshot() {
    const dir = path.join(os.homedir(), 'Pictures', 'Jarvis');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
    const ok = await psEnv('Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save($env:JARVIS_PATH)', { JARVIS_PATH: file });
    if (!ok || !fs.existsSync(file)) return 'I could not take the screenshot.';
    return 'Screenshot taken and saved in your Pictures, Jarvis folder.';
  },
  async set_timer({ input }) {
    const q = clean(input).toLowerCase();
    const n = Number(q.match(/(\d+(?:\.\d+)?)/)?.[1] || 0);
    if (!n) return 'For how many minutes?';
    const secs = Math.round(/sec/.test(q) ? n : /hour/.test(q) ? n * 3600 : n * 60);
    if (secs > 6 * 3600) return 'I can set timers up to 6 hours.';
    const label = clean(input).replace(/^\s*\d+(?:\.\d+)?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)?\s*(for|to)?\s*/i, '').trim();
    const msg = label ? `Timer done: ${label}` : 'Your timer is done';
    await psEnv(`Start-Sleep -Seconds ([int]$env:JARVIS_SECS); ${SPEAK}`, { JARVIS_SECS: String(secs), JARVIS_TEXT: msg }, { detached: true });
    const human = secs < 60 ? `${secs} seconds` : `${Math.round(secs / 60)} minutes`;
    return `Timer set for ${human}${label ? ` for ${label}` : ''}. The laptop will speak when it's done.`;
  },
  async draft_email({ input }) {
    const raw = clean(input);
    if (!raw) return 'Who is the email to, and what should it say?';
    const [to = '', subject = '', ...bodyParts] = raw.split('|').map((s) => s.trim());
    const u = new URL('https://mail.google.com/mail/');
    u.searchParams.set('view', 'cm'); u.searchParams.set('fs', '1');
    if (/@/.test(to)) u.searchParams.set('to', to);
    u.searchParams.set('su', subject || (/@/.test(to) ? '' : to));
    u.searchParams.set('body', bodyParts.join(' | '));
    await openUrl(u.toString());
    return 'The email draft is open in Gmail. I have not sent it, check it and press send yourself.';
  },
  async directions({ input }) {
    const q = clean(input);
    if (!q) return 'Where do you want to go?';
    await openUrl(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`);
    return `Directions to ${q} are on the screen.`;
  },
  async weather({ input }) {
    const place = !clean(input) || norm(input) === 'none' ? 'Hyderabad' : clean(input);
    await openUrl(`https://www.google.com/search?q=${encodeURIComponent('weather ' + place)}`);
    return `Weather for ${place} is on the screen.`;
  },
  async run_routine({ input }) {
    const q = norm(input).replace(/\s*mode$/, '');
    const r = ROUTINES[q];
    if (!r) return `I know these modes: ${Object.keys(ROUTINES).join(', ')}.`;
    for (const app of r.apps) await run(app[0], app[1]);
    for (const u of r.urls) { await openUrl(u); await sleep(300); }
    return r.say;
  },
};
const ALIASES = { open_site: 'open_website', website: 'open_website', search: 'web_search', youtube: 'play_youtube', play: 'play_youtube', app: 'open_app', note: 'take_note', notes: 'read_notes', status: 'system_status', battery: 'system_status', lock: 'lock_screen', media: 'media_control', volume: 'media_control', say: 'speak_on_laptop', speak: 'speak_on_laptop', screenshot: 'take_screenshot', timer: 'set_timer', email: 'draft_email', maps: 'directions', routine: 'run_routine', mode: 'run_routine' };

// ---------- auth ----------
function authorise(req, body) {
  const auth = req.headers.authorization || '';
  const given = auth.replace(/^Bearer\s+/i, '') || req.headers['x-jarvis-token'] || body.token || '';
  if (!TOKEN || given.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))) return 'bad token';
  const raw = String(req.headers['x-caller'] || body.caller || body.user_identifier || '').trim();
  if (!OWNER && !OWNER_CALLER_ID) return null;
  if (!raw) return ALLOW_NO_CALLER ? null : 'no caller number';
  lastCaller = raw;
  // Sarvam passes a hashed caller id, not the number. Accept the configured owner hash, or a
  // hash of the owner's number in a common format; plain numbers are compared on the last 10 digits.
  if (OWNER_CALLER_ID && raw.toLowerCase() === OWNER_CALLER_ID) return null;
  if (/^[0-9a-f]{32,}$/i.test(raw)) return OWNER_HASHES.has(raw.toLowerCase()) ? null : `caller ${raw.slice(0, 6)}… is not the owner`;
  const digits = raw.replace(/\D/g, '');
  if (OWNER && digits.length >= 10 && digits.slice(-10) === OWNER.slice(-10)) return null;
  return `caller …${digits.slice(-2) || raw.slice(-2)} is not the owner`;
}

// ---------- http ----------
const PAGE = fs.readFileSync(path.join(ROOT, 'live.html'), 'utf8');
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Anything arriving through the Cloudflare tunnel carries cf-connecting-ip. The console and
  // activity feed are for this laptop's screen only; the tunnel exposes just /action and /tools.
  const viaTunnel = Boolean(req.headers['cf-connecting-ip']);
  if (viaTunnel && req.method === 'GET') return json(res, 404, { result: 'Not found' });
  if (req.method === 'GET' && url.pathname === '/status') {
    return json(res, 200, { owner: OWNER ? `…${OWNER.slice(-2)}` : null, lock: Boolean(OWNER || OWNER_CALLER_ID), lastCaller, allowNoCaller: ALLOW_NO_CALLER, actions: Object.keys(ACTIONS), phone: process.env.JARVIS_PHONE || '' });
  }
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (req.method === 'GET' && url.pathname === '/activity') return json(res, 200, activity);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

  const m = url.pathname.match(/^\/tools\/([a-z_]+)$/) || (url.pathname === '/action' ? [null, null] : null);
  if (!m) return json(res, 404, { result: 'Unknown endpoint' });

  let body = {};
  if (req.method !== 'GET') {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 20000) break; }
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { input: raw }; }
  }
  for (const [k, v] of url.searchParams) if (body[k] === undefined) body[k] = v;

  let name = m[1] || body.action || '';
  name = ALIASES[name] || name;
  const input = body.input ?? body.query ?? body.text ?? body.name ?? body.url ?? body.app ?? body.site ?? body.note ?? '';

  const denied = authorise(req, body);
  if (denied) { record({ action: name || '?', input, result: `REFUSED (${denied})`, refused: true }); return json(res, 401, { result: 'Not authorised.' }); }

  const fn = ACTIONS[name];
  if (!fn) return json(res, 400, { result: `I can't do ${name || 'that'} yet.` });

  // The voice agent can fire the same tool call several times in a burst. Run it once,
  // answer the repeats with the first result.
  const key = `${name}|${norm(input)}`;
  const prev = recent.get(key);
  if (prev && Date.now() - prev.at < DEDUPE_MS) {
    const result = await prev.result;
    return json(res, 200, { ok: true, result });
  }
  if (recent.size > 200) for (const [k, v] of recent) if (Date.now() - v.at > DEDUPE_MS) recent.delete(k);
  const pending = fn({ input });
  recent.set(key, { at: Date.now(), result: pending.catch(() => 'Something went wrong on the laptop.') });

  const callerRaw = String(req.headers['x-caller'] || body.caller || body.user_identifier || '').replace(/\D/g, '');
  const caller = callerRaw ? `…${callerRaw.slice(-2)}` : 'no caller id';
  try {
    const result = await pending;
    record({ action: name, input, result, caller });
    json(res, 200, { ok: true, result });
  } catch (e) {
    record({ action: name, input, result: `ERROR ${e.message}` });
    json(res, 500, { ok: false, result: 'Something went wrong on the laptop.' });
  }
}).listen(PORT, () => console.log(`Jarvis action server on http://localhost:${PORT}  owner=${OWNER ? OWNER.slice(0, 4) + '…' : 'NOT SET'}  token=${TOKEN ? 'set' : 'MISSING'}`));
