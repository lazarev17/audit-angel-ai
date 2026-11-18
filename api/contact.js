// Demo / pilot request form handler for the Audit Angel AI landing page.
// Sends the request by email (Resend) to contact@audit-angel.co.uk and to the team Telegram chat.
// Env (set in the Vercel project, same values as the audit-angel-cqc project):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RESEND_API_KEY
//   optional: CONTACT_TO (default contact@audit-angel.co.uk), MAIL_FROM (default Audit Angel AI <hello@audit-angel.co.uk>)
// GET /api/contact?check=1 reports which channels are configured (booleans only, never secrets).

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clean = v => String(v || '').trim().replace(/^[`'"\s]+|[`'"\s]+$/g, '').replace(/^bot(?=\d)/i, '');
const cleanToken = v => { const c = clean(v); const m = c.match(/\d{6,12}:[A-Za-z0-9_-]{30,50}(?![A-Za-z0-9_-])/); return m ? m[0] : c; };
const TO = () => process.env.CONTACT_TO || 'contact@audit-angel.co.uk';
const FROM = () => process.env.MAIL_FROM || 'Audit Angel AI <hello@audit-angel.co.uk>';

// Small in-memory throttle per IP (best effort on serverless).
const hits = new Map();
function throttled(ip) {
  const now = Date.now(), win = 10 * 60e3, max = 5;
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > max;
}

async function withTimeout(promise, ms) {
  let t; const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
  try { return await Promise.race([promise, timer]); } finally { clearTimeout(t); }
}

async function telegram(html) {
  const token = cleanToken(process.env.TELEGRAM_BOT_TOKEN), chat = clean(process.env.TELEGRAM_CHAT_ID);
  if (!token || !chat) { console.warn('contact: Telegram not configured'); return false; }
  try {
    const r = await withTimeout(fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true })
    }), 4000);
    if (!r.ok) console.error('contact telegram', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('contact telegram', e.message); return false; }
}

async function email(d) {
  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) { console.warn('contact: RESEND_API_KEY not set'); return false; }
  const rows = [['Name', d.name], ['Work email', d.email], ['Phone', d.phone], ['Organisation', d.org], ['Sites', d.sites], ['System', d.system], ['Page', d.page]];
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#2E2E2E">
<h2 style="margin:0 0 12px;font-size:19px">New demo request · Audit Angel AI</h2>
<table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#6A6972;padding-right:16px">${k}</td><td><b>${esc(v || '—')}</b></td></tr>`).join('')}</table>
<p style="color:#6A6972;font-size:13px;margin-top:16px">Reply to this email to answer ${esc(d.name)} directly.</p></div>`;
  const text = rows.map(([k, v]) => `${k}: ${v || '—'}`).join('\n');
  try {
    const r = await withTimeout(fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [TO()], reply_to: d.email, subject: `Demo request: ${d.org} (${d.name})`, html, text })
    }), 8000);
    if (!r.ok) console.error('contact mail', r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.error('contact mail', e.message); return false; }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); } }
  return new Promise(resolve => {
    let data = ''; req.on('data', c => { data += c; if (data.length > 2e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function send(res, code, obj) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); }

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return send(res, 200, { telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), email: !!process.env.RESEND_API_KEY, to: TO() });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  if (origin && !origin.endsWith('://' + host)) return send(res, 403, { error: 'Bad origin' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (throttled(ip)) return send(res, 429, { error: 'Too many requests. Please try again in a few minutes.' });

  const b = await readBody(req);
  if (b.website) return send(res, 200, { ok: true }); // honeypot: bots fill hidden field

  const cut = (v, n) => String(v || '').trim().slice(0, n);
  const d = { name: cut(b.name, 120), email: cut(b.email, 160), phone: cut(b.phone, 40), org: cut(b.org, 160), sites: cut(b.sites, 20), system: cut(b.system, 60), page: cut(b.page, 200) };

  if (!d.name || !d.org) return send(res, 400, { error: 'Please fill in your name and organisation.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return send(res, 400, { error: 'Please enter a valid work email.' });
  if ((d.phone.match(/\d/g) || []).length < 7 || !/^[+()\d\s.-]+$/.test(d.phone)) return send(res, 400, { error: 'Please enter a valid phone number.' });

  const tg = `📞 <b>New demo request</b> · Audit Angel AI
<b>${esc(d.name)}</b>
🏥 ${esc(d.org)} · ${esc(d.sites)} site(s) · ${esc(d.system)}
✉️ ${esc(d.email)}
📱 ${esc(d.phone)}`;

  const [mailOk, tgOk] = await Promise.all([email(d), telegram(tg)]);
  if (!mailOk && !tgOk) return send(res, 502, { error: 'We couldn’t send your request. Please email contact@audit-angel.co.uk.' });
  return send(res, 200, { ok: true, email: mailOk, telegram: tgOk });
};
