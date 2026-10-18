// ARRC's watchful side: deadlines and laptop health. When something needs the owner,
// ARRC phones them through Sarvam's instant outbound call API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STAGES = [24 * 60, 3 * 60, 60, 15]; // minutes before a deadline
const MIN_GAP_MS = 10 * 60_000;           // at most one call every 10 minutes
const MAX_PER_DAY = 8;

export function createMonitor({ root, env, record, battery }) {
  const file = path.join(root, 'deadlines.json');
  const state = { lastCallAt: 0, callsToday: 0, day: '', batteryAlerted: false, lastCall: null };

  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  const save = (list) => fs.writeFileSync(file, JSON.stringify(list, null, 2));

  const configured = () => Boolean(env.SARVAM_WORKSPACE_KEY && env.SARVAM_ORG_ID && env.SARVAM_WORKSPACE_ID && env.ARRC_CONNECTION_ID && env.ARRC_APP_ID && env.OWNER_NUMBER);

  // ---------- parsing ----------
  function parseWhen(text, now = new Date()) {
    const t = String(text || '').trim().toLowerCase();
    let m = t.match(/^in\s+(\d+(?:\.\d+)?)\s*(min|minute|minutes|mins|hour|hours|hr|hrs|day|days)$/);
    if (m) {
      const n = Number(m[1]);
      const mult = m[2].startsWith('h') ? 3_600_000 : m[2].startsWith('d') ? 86_400_000 : 60_000;
      return new Date(now.getTime() + n * mult);
    }
    m = t.match(/^(today|tomorrow|tonight)?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (m && (m[1] || m[4] || m[3])) {
      let h = Number(m[2]); const min = Number(m[3] || 0);
      if (m[4] === 'pm' && h < 12) h += 12;
      if (m[4] === 'am' && h === 12) h = 0;
      if (m[1] === 'tonight' && h < 12) h += 12;
      const d = new Date(now); d.setHours(h, min, 0, 0);
      if (m[1] === 'tomorrow') d.setDate(d.getDate() + 1);
      return d;
    }
    m = t.match(/^(\d{4}-\d{2}-\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/);
    if (m) return new Date(`${m[1]}T${(m[2] || '23').padStart(2, '0')}:${m[3] || '59'}:00`); // local time
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const human = (mins) => {
    if (mins < 1) return 'now';
    if (mins < 60) return `${Math.round(mins)} minutes`;
    if (mins < 48 * 60) { const h = Math.round(mins / 60); return `${h} hour${h > 1 ? 's' : ''}`; }
    return `${Math.round(mins / 1440)} days`;
  };
  const clock = (d) => d.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  // ---------- deadlines ----------
  function add(input) {
    const [rawTitle, rawWhen] = String(input || '').split('|').map((s) => s.trim());
    if (!rawTitle || !rawWhen) return { error: 'Tell me what is due and when, like: EM5120 assignment | tomorrow 5 pm.' };
    const due = parseWhen(rawWhen);
    if (!due) return { error: `I couldn't understand the time "${rawWhen}".` };
    if (due.getTime() < Date.now() - 60_000) return { error: 'That time has already passed.' };
    const list = load();
    const item = { id: crypto.randomUUID().slice(0, 8), title: rawTitle.slice(0, 120), due: due.toISOString(), done: false, notified: [] };
    // Stages already inside the window don't fire (no call right after you add it); later stages
    // and the at-due-time call still do.
    const left = (due.getTime() - Date.now()) / 60_000;
    item.notified = STAGES.filter((s) => left <= s);
    list.push(item); save(list);
    return { item, text: `Got it. ${item.title} is due ${clock(due)}, in ${human(left)}. I'll call you before it's due.` };
  }

  function list() {
    const now = Date.now();
    return load().filter((d) => !d.done).sort((a, b) => a.due.localeCompare(b.due))
      .map((d) => ({ ...d, minutesLeft: (new Date(d.due).getTime() - now) / 60_000 }));
  }

  function spokenList() {
    const open = list();
    if (!open.length) return 'You have no pending deadlines.';
    return `You have ${open.length} pending: ` + open.slice(0, 4).map((d) =>
      d.minutesLeft < 0 ? `${d.title}, overdue` : `${d.title}, due in ${human(d.minutesLeft)}`).join('; ') + '.';
  }

  function finish(query) {
    const q = String(query || '').toLowerCase().trim();
    const all = load();
    const open = all.filter((d) => !d.done);
    const hit = open.find((d) => d.id === q) || open.find((d) => d.title.toLowerCase().includes(q)) ||
      open.find((d) => q.split(/\s+/).some((w) => w.length > 2 && d.title.toLowerCase().includes(w))) ||
      (open.length === 1 ? open[0] : null);
    if (!hit) return open.length ? `Which one? ${open.map((d) => d.title).join(', ')}.` : 'You have no pending deadlines.';
    hit.done = true; hit.doneAt = new Date().toISOString(); save(all);
    return `Marked ${hit.title} as submitted. No more reminders for it. Well done.`;
  }

  // ---------- the call ----------
  async function callOwner(message, reason) {
    const today = new Date().toDateString();
    if (state.day !== today) { state.day = today; state.callsToday = 0; }
    const entry = { action: 'call_owner', input: reason, caller: 'ARRC → you' };
    if (!configured()) {
      record({ ...entry, result: `DRY RUN (outbound not configured): "${message}"` });
      return { ok: false, dryRun: true };
    }
    try {
      const url = `https://apps.sarvam.ai/api/outbounds/v1/orgs/${encodeURIComponent(env.SARVAM_ORG_ID)}/workspaces/${encodeURIComponent(env.SARVAM_WORKSPACE_ID)}/outbounds`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'X-API-Key': env.SARVAM_WORKSPACE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_config: {
            app_id: env.ARRC_APP_ID,
            app_version: Number(env.ARRC_APP_VERSION || 1),
            connection_config: { connection_id: env.ARRC_CONNECTION_ID, agent_phone_number: env.ARRC_AGENT_NUMBER },
            app_overrides: { initial_bot_message: message },
          },
          user_config: { user_phone_number: `+${String(env.OWNER_NUMBER).replace(/\D/g, '')}` },
        }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.text();
      if (!res.ok) { record({ ...entry, result: `CALL FAILED ${res.status}: ${body.slice(0, 160)}`, refused: true }); return { ok: false, status: res.status, body }; }
      state.lastCallAt = Date.now(); state.callsToday += 1;
      state.lastCall = { at: new Date().toISOString(), message };
      record({ ...entry, result: `Calling you now: "${message}"` });
      return { ok: true, body };
    } catch (e) {
      record({ ...entry, result: `CALL FAILED: ${e.message}`, refused: true });
      return { ok: false, error: e.message };
    }
  }

  const canCall = (urgentNow) => {
    if (state.callsToday >= MAX_PER_DAY) return false;
    if (Date.now() - state.lastCallAt < MIN_GAP_MS) return false;
    const h = new Date().getHours();
    return urgentNow || (h >= 7 && h < 23);
  };

  // ---------- the watch loop ----------
  async function tick() {
    // Deadlines
    const all = load();
    let changed = false;
    for (const d of all) {
      if (d.done) continue;
      const left = (new Date(d.due).getTime() - Date.now()) / 60_000;
      if (left < -30) continue; // long overdue: stop nagging
      const due = STAGES.filter((s) => left <= s && !d.notified.includes(s));
      const overdue = left <= 0 && !d.notified.includes(0);
      if (!due.length && !overdue) continue;
      if (!canCall(left <= 120)) continue;
      const msg = overdue
        ? `Hi, ARRC here. This is urgent. ${d.title} was due just now and it is not marked as submitted. Please take a look right away. Say submitted if you have done it.`
        : `Hi, ARRC here. Heads up, ${d.title} is due in ${human(left)}, at ${clock(new Date(d.due))}. Please take a look. Say submitted once you are done and I will stop reminding you.`;
      const r = await callOwner(msg, `deadline: ${d.title}`);
      d.notified.push(...due, ...(overdue ? [0] : []));
      changed = true;
      if (r.ok || r.dryRun) break; // one call per tick
    }
    if (changed) save(all);

    // Battery about to die while unplugged
    const b = await battery();
    if (b && b.pct != null) {
      if (b.charging || b.pct > 20) state.batteryAlerted = false;
      else if (b.pct <= 15 && !state.batteryAlerted && canCall(true)) {
        state.batteryAlerted = true;
        await callOwner(`Hi, ARRC here. Urgent: your laptop battery is at ${b.pct} percent and it is not charging. Please plug it in now or you may lose your work.`, `battery ${b.pct}%`);
      }
    }
  }

  let timer = null;
  function start() { if (!timer) { timer = setInterval(() => tick().catch(() => {}), 60_000); setTimeout(() => tick().catch(() => {}), 5000); } }

  function status() {
    return { configured: configured(), callsToday: state.callsToday, lastCall: state.lastCall, deadlines: list() };
  }

  return { add, list, spokenList, finish, callOwner, start, status, human };
}
