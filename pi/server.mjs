/* Sightline on a Raspberry Pi 5.

   The app talks to one endpoint. It does not care whether that endpoint is
   a Cloudflare Worker or a computer on your desk, so long as it answers the
   same three routes. This is that endpoint, running on your own hardware,
   which is the only arrangement that is genuinely unlimited: nobody is
   metering it because nobody else is paying for it.

   It speaks to llama.cpp's own HTTP server, which does the actual work.
   See README.md in this directory for the twenty minutes of setup.

   Routes, matching worker/index.js:
     GET  /            health
     POST /v1/identify { image, hint }  -> { ok, kind, name, scientific, ... }
     POST /v1/translate{ text, from, to } -> { ok, text }

   Not implemented here: /v1/transcribe. Whisper on a Pi 5 is roughly real
   time for tiny.en, which makes live captions a poor fit; leave captions on
   the Worker, or on the browser's own recogniser.                         */

import http from 'node:http';

const PORT = Number(process.env.PORT || 8088);
const LLAMA = process.env.LLAMA_URL || 'http://127.0.0.1:8080';
const SECRET = process.env.SIGHTLINE_SECRET || '';
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 90000);

/* ---- the prompts -------------------------------------------------------
   Deliberately the same instructions the Worker uses. The whole point of
   this app is that it does not name the obvious, and a smaller model needs
   telling that more firmly, not less. */
const COMMON =
  'You are a precise visual identification engine. Identify the MAIN subject of the image.\n' +
  'A wrong name is far worse than no name. If you are unsure, say so with a low confidence.\n' +
  '"confidence" is your honest probability from 0 to 1 that the name is exactly right.\n' +
  'If nothing can be identified, return an empty name and confidence 0.\n';

const HINTS = {
  person:
    'The crop shows a person. Name them ONLY if they are a widely photographed public figure with a ' +
    'Wikipedia article. For an ordinary private individual, or a mere resemblance, return an empty name ' +
    'and confidence 0. Never name someone because they look like someone.',
  plant:
    'The crop shows a plant, tree, flower or fungus. Common name in "name", binomial in "scientific".',
  animal:
    'The crop shows an animal. Species, or breed if domestic, in "name"; binomial in "scientific".',
  insect:
    'The crop shows an insect, arachnid or other small invertebrate. Common name in "name", binomial in ' +
    '"scientific". Say in "note" whether it stings or bites.',
  vehicle:
    'The crop shows a vehicle. Make, model and generation in "name". Production years in "note".',
  object:
    'The crop shows a manufactured object. A generic noun is useless - "chair", "printer" - so give the ' +
    'full model name and manufacturer if the image supports it. Fill "specs" with {k,v} rows for ' +
    'Manufacturer, Model, Released, Price from and Where to buy, OMITTING any you are unsure of rather ' +
    'than inventing it. If you cannot tell the model from the generic category, return the generic name ' +
    'with confidence below 0.4.'
};

function promptFor(hint) {
  return COMMON + (HINTS[hint] || HINTS.object) +
    '\nReply with ONLY a JSON object with keys: kind, name, scientific, confidence, note, alt, specs.';
}

/* A small model will wrap its JSON in prose however firmly it is asked not
   to. Take the outermost braces and try to read them. */
function looseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  const body = s.slice(a, b + 1);
  try { return JSON.parse(body); } catch (e) {}
  try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
  return null;
}

function normalise(p, hint) {
  if (!p) return { ok: false, error: 'the model did not return a readable answer' };
  const conf = Number(p.confidence);
  return {
    ok: true,
    kind: String(p.kind || hint || 'object').slice(0, 20),
    name: String(p.name || '').slice(0, 90),
    scientific: String(p.scientific || '').slice(0, 90),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    note: String(p.note || '').slice(0, 400),
    alt: Array.isArray(p.alt) ? p.alt.slice(0, 3).map(x => String(x).slice(0, 60)) : [],
    specs: Array.isArray(p.specs)
      ? p.specs.slice(0, 6)
          .map(x => ({ k: String(x.k || x.key || '').slice(0, 40), v: String(x.v || x.value || '').slice(0, 80) }))
          .filter(x => x.k && x.v)
      : [],
    source: 'pi'
  };
}

async function llama(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(LLAMA + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('llama.cpp answered HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

function cors(res, extra) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sightline-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (extra) Object.keys(extra).forEach(k => res.setHeader(k, extra[k]));
}
function send(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > limitBytes) { reject(new Error('too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

  if (path === '/' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'sightline-pi', llama: LLAMA });
  }

  /* Anything reachable from the internet needs a door with a lock on it.
     The key is a header the app sends; without SIGHTLINE_SECRET set, this
     server refuses to answer at all rather than sitting open. */
  if (!SECRET) return send(res, 500, { ok: false, error: 'SIGHTLINE_SECRET is not set on this server' });
  if ((req.headers['x-sightline-key'] || '') !== SECRET) {
    return send(res, 401, { ok: false, error: 'unauthorised' });
  }

  let body;
  try { body = await readBody(req, 6 * 1024 * 1024); }
  catch (e) { return send(res, 413, { ok: false, error: String(e.message) }); }

  if (path === '/v1/identify') {
    const image = String(body.image || '');
    if (!image) return send(res, 400, { ok: false, error: 'image is required' });
    const hint = String(body.hint || 'object');
    try {
      /* llama.cpp's OpenAI-compatible route takes a data URL directly. */
      const out = await llama('/v1/chat/completions', {
        messages: [{ role: 'user', content: [
          { type: 'text', text: promptFor(hint) },
          { type: 'image_url', image_url: { url: image } }
        ] }],
        temperature: 0.1, max_tokens: 400
      });
      const text = out?.choices?.[0]?.message?.content || '';
      const rec = normalise(looseJson(text), hint);
      return send(res, rec.ok ? 200 : 502, rec);
    } catch (e) {
      return send(res, 502, { ok: false, error: 'identification failed: ' + String(e.message).slice(0, 140) });
    }
  }

  if (path === '/v1/translate') {
    const text = String(body.text || '').slice(0, 900);
    const to = String(body.to || 'en').slice(0, 8);
    if (!text) return send(res, 400, { ok: false, error: 'text is required' });
    try {
      const out = await llama('/v1/chat/completions', {
        messages: [
          { role: 'system', content: 'You translate. Reply with the translation and nothing else.' },
          { role: 'user', content: 'Translate into ' + to + ':\n' + text }
        ],
        temperature: 0, max_tokens: 300
      });
      const t = (out?.choices?.[0]?.message?.content || '').trim();
      return send(res, t ? 200 : 502, t ? { ok: true, text: t, via: 'pi' }
                                       : { ok: false, error: 'no translation' });
    } catch (e) {
      return send(res, 502, { ok: false, error: 'translation failed' });
    }
  }

  return send(res, 404, { ok: false, error: 'unknown route' });
});

server.listen(PORT, () => {
  console.log('sightline-pi listening on ' + PORT + ', talking to ' + LLAMA);
  if (!SECRET) console.log('WARNING: SIGHTLINE_SECRET is not set, so every request will be refused.');
});
