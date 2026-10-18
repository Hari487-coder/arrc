// Voice file search: find the document the owner names and open it with its default app.
// Only document/media types are ever indexed, so programs and scripts can never be opened.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const ROOTS = ['Desktop', 'Documents', 'Downloads', 'OneDrive', 'Pictures']
  .map((r) => path.join(HOME, r)).filter((p) => fs.existsSync(p));
export const OPENABLE = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.csv', '.txt', '.md', '.png', '.jpg', '.jpeg', '.mp4', '.mov']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'AppData', '$RECYCLE.BIN', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'site-packages']);
const STOP = new Set(['my', 'the', 'a', 'an', 'file', 'files', 'document', 'doc', 'open', 'please', 'mera', 'meri', 'mere', 'ka', 'ki', 'ke', 'kholo', 'dikhao', 'wala', 'wali', 'of', 'for', 'to', 'latest', 'last', 'recent', 'pdf', 'word']);
const MAX_FILES = 60000;
const MAX_DEPTH = 6;
const REFRESH_MS = 10 * 60_000;

let index = [];
let indexedAt = 0;
let building = null;

async function walk(dir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  const subdirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) subdirs.push(full); }
    else if (OPENABLE.has(path.extname(e.name).toLowerCase())) files.push(full);
  }
  await Promise.all(files.map(async (full) => {
    try { const st = await fsp.stat(full); out.push({ full, name: path.basename(full).toLowerCase(), mtime: st.mtimeMs }); } catch {}
  }));
  for (const d of subdirs) await walk(d, depth + 1, out);
}

// Non-blocking: always answers from the current index and refreshes it in the background.
export function buildIndex(force = false) {
  if ((force || Date.now() - indexedAt > REFRESH_MS) && !building) {
    const out = [];
    building = (async () => {
      for (const r of ROOTS) await walk(r, 0, out);
      const seen = new Set();
      index = out.filter((f) => !seen.has(f.full) && seen.add(f.full));
      indexedAt = Date.now();
    })().finally(() => { building = null; });
  }
  return building || Promise.resolve();
}
export const indexSize = () => index.length;

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w));

export function findFiles(query, limit = 3) {
  buildIndex();
  const q = words(query);
  if (!q.length) return [];
  const codes = q.filter((w) => /\d/.test(w) && /[a-z]/.test(w)); // course codes like em5120 must match
  const now = Date.now();
  return index
    .map((f) => {
      const base = f.name.replace(/\.[^.]+$/, '');
      const flat = base.replace(/[^a-z0-9]/g, '');
      if (codes.some((c) => !flat.includes(c))) return null;
      const nameWords = words(base);
      let score = 0;
      for (const w of q) {
        if (nameWords.includes(w)) score += 3;
        else if (flat.includes(w)) score += 2;
        else if (w.length >= 4 && nameWords.some((n) => n.startsWith(w.slice(0, 4)))) score += 1;
      }
      if (score < Math.min(3, q.length * 2)) return null;
      score += Math.max(0, 1.5 - (now - f.mtime) / 86_400_000 / 30); // gentle preference for recent files
      if (q.every((w) => flat.includes(w))) score += 2;
      return { ...f, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime)
    .slice(0, limit);
}

export function describe(f) {
  const where = path.relative(HOME, path.dirname(f.full)).split(path.sep).slice(0, 2).join(' / ') || 'your home folder';
  const days = Math.floor((Date.now() - f.mtime) / 86_400_000);
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return { file: path.basename(f.full), where, when };
}
