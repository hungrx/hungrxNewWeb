// Shared safety layer for the /order chat functions. Not a public route (files starting with _ are private on Vercel).
import crypto from 'node:crypto';

export const ALLOWED_ORIGINS = ['https://hungrx.com', 'https://www.hungrx.com'];
const HITS = new Map();               // per-IP limit inside one running instance
const LIMIT_PER_HOUR = 20;            // ~6 full chats per person per hour (each chat = 3 calls)
const SESSION_MINUTES = 20;

export const clean = (s, max = 80) => String(s || '').replace(/[<>{}`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function secret() {
  const base = process.env.SESSION_SECRET || process.env.GEMINI_API_KEY || '';
  return crypto.createHash('sha256').update('hungrx-session:' + base).digest();
}
export function makeSession() {
  const exp = Date.now() + SESSION_MINUTES * 60e3;
  const id = crypto.randomBytes(8).toString('hex');
  const body = exp + '.' + id;
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + sig;
}
export function checkSession(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 3) return false;
  const [exp, id, sig] = parts;
  const good = crypto.createHmac('sha256', secret()).update(exp + '.' + id).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return Number(exp) > Date.now();
}

// Cloudflare Turnstile (invisible bot check). Active only when TURNSTILE_SECRET is set in Vercel.
export async function humanCheck(token, ip) {
  if (!process.env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET, response: String(token).slice(0, 2048), remoteip: ip })
    });
    const j = await r.json();
    return j.success === true && (!j.hostname || /(^|\.)hungrx\.com$/.test(j.hostname));
  } catch { return false; }
}

// Common gatekeeping. Returns { ip, body } or sends the error response and returns null.
export function gate(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.status(204).end(); return null; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, reason: 'method' }); return null; }
  // browsers always send Origin on POST fetch; anything else (scripts, other sites) is refused
  if (!ALLOWED_ORIGINS.includes(origin) && !/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) { res.status(403).json({ ok: false, reason: 'origin' }); return null; }
  if (!process.env.GEMINI_API_KEY) { res.status(500).json({ ok: false, reason: 'config' }); return null; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= LIMIT_PER_HOUR) { res.status(429).json({ ok: false, reason: 'limit' }); return null; }
  hits.push(now); HITS.set(ip, hits);
  if (HITS.size > 5000) HITS.clear();

  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  if (raw.length > 4000) { res.status(413).json({ ok: false, reason: 'input' }); return null; }
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch { body = {}; }
  return { ip, body };
}

export async function gemini(model, payload, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!r.ok) { console.error('gemini_error', model, r.status, (await r.text()).slice(0, 300)); return null; }
    const data = await r.json();
    return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  } catch (e) {
    console.error('gemini_exception', model, e && e.message);
    return null;
  } finally { clearTimeout(t); }
}
