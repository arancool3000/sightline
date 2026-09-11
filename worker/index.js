/**
 * Sightline API - Cloudflare Worker.
 *
 * The browser never holds a key. This worker is the only thing that does.
 *
 * Routes
 *   GET  /v1/health      what is configured and reachable
 *   POST /v1/identify    { image: dataURL, hint } -> a named identification
 *   POST /v1/translate   { text, from, to }       -> translated text
 *
 * Everything it depends on has a free tier:
 *   GEMINI_KEY     ai.google.dev  - free tier, required for identification
 *   PLANTNET_KEY   my.plantnet.org - free 500/day, optional plant specialist
 *   VISION_KEY     Google Cloud Vision - optional; enables true reverse image
 *                  search for public figures (free for 1,000 units/month)
 *
 * Set them with:  wrangler secret put GEMINI_KEY
 */

const DEFAULTS = {
  MODEL: 'gemini-2.0-flash',
  ALLOW_ORIGIN: '*',
  RL_BURST: '40',        // requests per IP per window
  RL_WINDOW: '60',       // seconds
  MAX_IMAGE_KB: '1400'
};

const cfg = (env, k) => (env && env[k]) || DEFAULTS[k] || '';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function cors(env) {
  return {
    'Access-Control-Allow-Origin': cfg(env, 'ALLOW_ORIGIN'),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors(env))
  });
}

function err(message, status, env, extra) {
  return json(Object.assign({ ok: false, error: message }, extra || {}), status || 400, env);
}

/**
 * Per-IP burst limit on the Cache API: free, needs no KV, and fails OPEN so a
 * cache outage can never take the whole service down.
 */
async function rateLimited(request, env, ctx) {
  const limit = parseInt(cfg(env, 'RL_BURST'), 10);
  if (!limit) return false;
  const win = parseInt(cfg(env, 'RL_WINDOW'), 10) || 60;
  const ip = request.headers.get('CF-Connecting-IP') || 'anon';
  const bucket = Math.floor(Date.now() / (win * 1000));
  const key = new Request('https://sightline.rl/' + encodeURIComponent(ip) + '/' + bucket);

  try {
    const cache = caches.default;
    const hit = await cache.match(key);
    const n = hit ? parseInt(await hit.text(), 10) || 0 : 0;
    if (n >= limit) return true;
    const put = new Response(String(n + 1), { headers: { 'Cache-Control': 'max-age=' + win } });
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, put));
    else await cache.put(key, put);
    return false;
  } catch (e) {
    return false;  // fail open on purpose
  }
}

/** Split a data URL into the mime type and raw base64 Gemini expects. */
function parseDataUrl(s) {
  const m = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(String(s || ''));
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind:        { type: 'STRING', enum: ['person', 'plant', 'animal', 'insect', 'vehicle', 'object'] },
    name:        { type: 'STRING' },
    scientific:  { type: 'STRING' },
    confidence:  { type: 'NUMBER' },
    note:        { type: 'STRING' },
    alt:         { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['kind', 'name', 'confidence']
};

function promptFor(hint) {
  const common =
    'You are a precise visual identification engine. Look at the image and identify the MAIN subject.\n' +
    'Rules that matter more than being helpful:\n' +
    '- If you are not sure, say so with a low confidence number. A wrong name is far worse than no name.\n' +
    '- "confidence" is your honest probability from 0 to 1 that the name is exactly right.\n' +
    '- "name" must be the common English name, written the way an encyclopedia would title it.\n' +
    '- If nothing can be identified, return an empty name and confidence 0.\n' +
    '- "alt" holds up to three runner-up possibilities.\n';

  if (hint === 'person') {
    return common +
      'This crop shows a person.\n' +
      'Identify them ONLY if they are a widely photographed public figure - the kind of person who has a ' +
      'Wikipedia article and whose pictures appear across the web: heads of state, major athletes, famous ' +
      'musicians and actors, well-known scientists and writers.\n' +
      'If this is an ordinary private individual, or you are working from a mere resemblance, you MUST return ' +
      'an empty name with confidence 0. Never name someone because they look like someone. Never guess.\n' +
      'Set kind to "person".';
  }
  if (hint === 'plant') {
    return common + 'This crop shows a plant, tree, flower or fungus. Give the common name in "name" and the ' +
      'binomial in "scientific". Put the family and any distinguishing feature you used in "note". Set kind to "plant".';
  }
  if (hint === 'animal') {
    return common + 'This crop shows an animal. Give the species (or the breed if it is a domestic animal) in ' +
      '"name" and the binomial in "scientific". Set kind to "animal".';
  }
  if (hint === 'insect') {
    return common + 'This crop shows an insect, arachnid or other small invertebrate. Give the common name in ' +
      '"name" and the binomial in "scientific". Note whether it stings or bites in "note". Set kind to "insect".';
  }
  if (hint === 'vehicle') {
    return common + 'This crop shows a vehicle. Give make, model and generation in "name" (for example ' +
      '"Subaru Impreza WRX (GC8)"). Put the production years and body style in "note". Set kind to "vehicle".';
  }
  return common +
    'Work out for yourself what the subject is and set "kind" accordingly. It may be a plant, an animal, ' +
    'an insect, a vehicle, a manufactured object, or a person.\n' +
    'If it is a person, the strict rule applies: name them only if they are a widely photographed public ' +
    'figure, otherwise return an empty name with confidence 0.\n' +
    'For living things give the binomial in "scientific".';
}

async function gemini(env, image, hint) {
  const key = cfg(env, 'GEMINI_KEY');
  if (!key) return { ok: false, error: 'identification is not configured on this endpoint' };

  const img = parseDataUrl(image);
  if (!img) return { ok: false, error: 'bad image' };

  const model = cfg(env, 'MODEL');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: promptFor(hint) },
        { inline_data: { mime_type: img.mime, data: img.b64 } }
      ]
    }],
    generationConfig: {
      temperature: 0.05,
      maxOutputTokens: 400,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA
    }
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (r.status === 429) return { ok: false, error: 'quota exhausted', status: 429 };
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return { ok: false, error: 'upstream ' + r.status, detail: detail.slice(0, 200) };
  }

  const j = await r.json().catch(() => null);
  const cand = j && j.candidates && j.candidates[0];

  /* A safety stop is a legitimate answer here, not a crash: it means the model
     declined to identify a person, which is the conservative outcome we want. */
  if (!cand || (cand.finishReason && cand.finishReason !== 'STOP' && !cand.content)) {
    return { ok: true, kind: hint === 'auto' ? 'object' : hint, name: '', confidence: 0,
             note: 'The model declined to identify this.' };
  }

  const text = ((cand.content && cand.content.parts) || [])
    .map(p => p.text || '').join('').trim();

  let parsed = null;
  try { parsed = JSON.parse(text); }
  catch (e) {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { /* give up below */ } }
  }
  if (!parsed) return { ok: true, kind: hint === 'auto' ? 'object' : hint, name: '', confidence: 0, note: 'unreadable response' };

  return {
    ok: true,
    kind: parsed.kind || (hint === 'auto' ? 'object' : hint),
    name: String(parsed.name || '').trim(),
    scientific: String(parsed.scientific || '').trim(),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    note: String(parsed.note || '').slice(0, 400),
    alt: Array.isArray(parsed.alt) ? parsed.alt.slice(0, 3).map(String) : []
  };
}

/* ------------------------------------------------------------------ */
/* Google Cloud Vision - real reverse image search, optional           */
/* ------------------------------------------------------------------ */

/**
 * This is the "look on Google Images" path. It is only used when VISION_KEY is
 * set, because it is free for just 1,000 units a month. It is strictly better
 * than the model for public figures: it matches against the actual web index
 * rather than recalling from training.
 *
 * A name is only returned when the crop has genuine matching pages online,
 * which is the mechanism that keeps private individuals unidentifiable.
 */
async function visionWebDetect(env, image) {
  const key = cfg(env, 'VISION_KEY');
  if (!key) return null;

  const img = parseDataUrl(image);
  if (!img) return null;

  const r = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        image: { content: img.b64 },
        features: [{ type: 'WEB_DETECTION', maxResults: 8 }]
      }]
    })
  });
  if (!r.ok) return null;

  const j = await r.json().catch(() => null);
  const web = j && j.responses && j.responses[0] && j.responses[0].webDetection;
  if (!web) return null;

  const entities = (web.webEntities || []).filter(e => e.description && e.score);
  if (!entities.length) return null;

  /* Require the image to actually appear online somewhere. Without this a
     stranger can pick up a weak entity label from a visually similar photo. */
  const pages = (web.pagesWithMatchingImages || []).length;
  const full  = (web.fullMatchingImages || []).length;
  const partial = (web.partialMatchingImages || []).length;
  if (!pages && !full && !partial) return null;

  const top = entities[0];
  /* Vision scores are not probabilities; this maps the useful range onto one. */
  const conf = Math.max(0, Math.min(1, top.score / 2));

  return {
    ok: true,
    kind: 'person',
    name: top.description,
    confidence: conf,
    note: 'Matched against images published on the web.',
    alt: entities.slice(1, 4).map(e => e.description),
    source: 'vision'
  };
}

/* ------------------------------------------------------------------ */
/* Pl@ntNet - free plant specialist, optional                          */
/* ------------------------------------------------------------------ */

async function plantnet(env, image) {
  const key = cfg(env, 'PLANTNET_KEY');
  if (!key) return null;

  const img = parseDataUrl(image);
  if (!img) return null;

  const bin = Uint8Array.from(atob(img.b64), c => c.charCodeAt(0));
  const form = new FormData();
  form.append('images', new Blob([bin], { type: img.mime }), 'crop.jpg');
  form.append('organs', 'auto');

  const r = await fetch('https://my-api.plantnet.org/v2/identify/all?api-key=' + encodeURIComponent(key), {
    method: 'POST', body: form
  });
  if (!r.ok) return null;

  const j = await r.json().catch(() => null);
  const best = j && j.results && j.results[0];
  if (!best || !best.species) return null;

  const sp = best.species;
  const common = (sp.commonNames && sp.commonNames[0]) || sp.scientificNameWithoutAuthor || '';
  return {
    ok: true,
    kind: 'plant',
    name: common,
    scientific: sp.scientificNameWithoutAuthor || '',
    confidence: Math.max(0, Math.min(1, Number(best.score) || 0)),
    note: sp.family && sp.family.scientificNameWithoutAuthor ? 'Family ' + sp.family.scientificNameWithoutAuthor : '',
    alt: (j.results || []).slice(1, 4).map(x => (x.species && x.species.scientificNameWithoutAuthor) || '').filter(Boolean),
    source: 'plantnet'
  };
}

/* ------------------------------------------------------------------ */
/* translation - MyMemory is free and keyless; Gemini is the fallback  */
/* ------------------------------------------------------------------ */

async function translate(env, text, from, to) {
  if (!text || !to || from === to) return { ok: true, text: text };

  try {
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
                '&langpair=' + encodeURIComponent((from || 'en') + '|' + to);
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      const out = j && j.responseData && j.responseData.translatedText;
      /* MyMemory reports its own failures inside a 200, in the response text. */
      if (out && !/^(MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID)/i.test(out)) {
        return { ok: true, text: out, via: 'mymemory' };
      }
    }
  } catch (e) { /* fall through to the model */ }

  const key = cfg(env, 'GEMINI_KEY');
  if (!key) return { ok: false, error: 'translation unavailable' };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(cfg(env, 'MODEL')) + ':generateContent?key=' + encodeURIComponent(key);
  const r2 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{
        text: 'Translate into the language with code "' + to + '". Reply with the translation only, no quotes, ' +
              'no explanation, no transliteration.\n\n' + text
      }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 300 }
    })
  });
  if (!r2.ok) return { ok: false, error: 'translation unavailable' };

  const j2 = await r2.json().catch(() => null);
  const out = j2 && j2.candidates && j2.candidates[0] && j2.candidates[0].content &&
              (j2.candidates[0].content.parts || []).map(p => p.text || '').join('').trim();
  return out ? { ok: true, text: out, via: 'gemini' } : { ok: false, error: 'translation unavailable' };
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    if (path === '/' || path === '/v1/health') {
      return json({
        ok: true,
        service: 'sightline',
        features: {
          identify: !!cfg(env, 'GEMINI_KEY'),
          plants: !!cfg(env, 'PLANTNET_KEY'),
          webSearch: !!cfg(env, 'VISION_KEY'),
          translate: true
        }
      }, 200, env);
    }

    if (request.method !== 'POST') return err('use POST', 405, env);
    if (await rateLimited(request, env, ctx)) return err('too many requests - slow down', 429, env);

    let body;
    try { body = await request.json(); }
    catch (e) { return err('expected JSON', 400, env); }

    /* ---- identify ---- */
    if (path === '/v1/identify') {
      const image = body.image;
      if (!image) return err('image is required', 400, env);

      const maxKb = parseInt(cfg(env, 'MAX_IMAGE_KB'), 10);
      if (String(image).length > maxKb * 1400) return err('image too large', 413, env);

      const hint = ['person', 'plant', 'animal', 'insect', 'vehicle', 'object', 'auto']
        .indexOf(body.hint) >= 0 ? body.hint : 'auto';

      try {
        /* People: prefer the real web index when it is configured, since it
           beats model recall and is naturally limited to public figures. */
        if (hint === 'person') {
          const v = await visionWebDetect(env, image);
          if (v && v.name) return json(v, 200, env);
        }
        /* Plants: the specialist beats the generalist when it is configured. */
        if (hint === 'plant') {
          const p = await plantnet(env, image);
          if (p && p.name) return json(p, 200, env);
        }

        const g = await gemini(env, image, hint);
        if (!g.ok) return err(g.error, g.status || 502, env, { detail: g.detail });
        g.source = g.source || 'gemini';
        return json(g, 200, env);
      } catch (e) {
        return err('identification failed', 502, env, { detail: String(e && e.message || e).slice(0, 160) });
      }
    }

    /* ---- translate ---- */
    if (path === '/v1/translate') {
      const text = String(body.text || '').slice(0, 900);
      if (!text) return err('text is required', 400, env);
      try {
        const r = await translate(env, text, String(body.from || 'en').slice(0, 8), String(body.to || '').slice(0, 8));
        return r.ok ? json(r, 200, env) : err(r.error, 502, env);
      } catch (e) {
        return err('translation failed', 502, env);
      }
    }

    return err('unknown route', 404, env);
  }
};
