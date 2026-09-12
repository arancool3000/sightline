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
 * NO KEYS ARE REQUIRED. By default identification and translation run on
 * Cloudflare Workers AI (the `AI` binding in wrangler.toml): part of the free
 * plan, no signup, no card, nothing that can be billed.
 *
 * Optional upgrades, each with a free tier, picked up automatically if set:
 *   GEMINI_KEY     ai.google.dev  - sharper answers, notably for public figures
 *   PLANTNET_KEY   my.plantnet.org - free 500/day, plant specialist
 *   VISION_KEY     Google Cloud Vision - true reverse image search (1,000/mo free)
 *
 * Set them with:  wrangler secret put GEMINI_KEY
 */

const DEFAULTS = {
  MODEL: 'gemini-2.0-flash',
  CF_VISION_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
  /* Open weights, no licence gate. Used when the one above is not
     available to this account. */
  CF_VISION_FALLBACK: '@cf/llava-hf/llava-1.5-7b-hf',
  CF_TRANSLATE_MODEL: '@cf/meta/m2m100-1.2b',
  CF_STT_MODEL: '@cf/openai/whisper',
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
    alt:         { type: 'ARRAY', items: { type: 'STRING' } },
    specs:       { type: 'ARRAY', items: { type: 'OBJECT', properties: { k: { type: 'STRING' }, v: { type: 'STRING' } } } }
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
  if (hint === 'object') {
    return common +
      'This crop shows a manufactured object, device or machine.\n' +
      'A generic noun is USELESS here. "Chair", "printer", "laptop" tell the viewer nothing they cannot see. ' +
      'Your job is the specific identity: the full model name and manufacturer, as precisely as the image supports ' +
      '(for example "Prusa MK4S", "Bambu Lab X1 Carbon", "MacBook Pro 14-inch M3", "Herman Miller Aeron Size B").\n' +
      'Put the manufacturer in specs, and fill the rest of "specs" with what someone looking at this would actually ' +
      'want to know, as {k, v} pairs, in this order where you can: Manufacturer, Model, Released, Price from, ' +
      'Where to buy, and one standout specification.\n' +
      '"Price from" should be an approximate current starting price with a currency symbol. "Where to buy" should ' +
      'name the usual retailers or the maker\'s own store. If you are unsure of a price or retailer, omit that ' +
      'row rather than inventing one.\n' +
      'If you genuinely cannot tell the model apart from the generic category, return the generic name but set ' +
      'confidence below 0.4 so it is treated as a weak guess.\n' +
      'Set kind to "object".';
  }
  return common +
    'Work out for yourself what the subject is and set "kind" accordingly. It may be a plant, an animal, ' +
    'an insect, a vehicle, a manufactured object or machine, or a person.\n' +
    'For a manufactured object a generic noun is useless: give the full model name and manufacturer as precisely ' +
    'as the image supports, and fill "specs" with {k, v} rows for Manufacturer, Model, Released, Price from and ' +
    'Where to buy, omitting any you are unsure of rather than inventing it.\n' +
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
    alt: Array.isArray(parsed.alt) ? parsed.alt.slice(0, 3).map(String) : [],
    specs: normalise(parsed, hint).specs
  };
}

/* ------------------------------------------------------------------ */
/* Cloudflare Workers AI - the keyless default                          */
/* ------------------------------------------------------------------ */

/** Pull the first JSON object out of a chatty model reply. */
function looseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

function normalise(parsed, hint) {
  if (!parsed) return { ok: true, kind: hint === 'auto' ? 'object' : hint, name: '', confidence: 0, note: 'unreadable response' };
  return {
    ok: true,
    kind: ['person','plant','animal','insect','vehicle','object'].indexOf(parsed.kind) >= 0
          ? parsed.kind : (hint === 'auto' ? 'object' : hint),
    name: String(parsed.name || '').trim(),
    scientific: String(parsed.scientific || '').trim(),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    note: String(parsed.note || '').slice(0, 400),
    alt: Array.isArray(parsed.alt) ? parsed.alt.slice(0, 3).map(String) : [],
    specs: Array.isArray(parsed.specs)
      ? parsed.specs.slice(0, 6).map(x => ({ k: String(x.k || x.key || '').slice(0, 40), v: String(x.v || x.value || '').slice(0, 80) }))
                    .filter(x => x.k && x.v)
      : []
  };
}

async function workersAI(env, image, hint) {
  if (!env.AI) return { ok: false, error: 'no AI binding', status: 501 };
  const img = parseDataUrl(image);
  if (!img) return { ok: false, error: 'bad image' };

  const prompt = promptFor(hint) +
    '\nReply with ONLY a JSON object with keys: kind, name, scientific, confidence, note, alt, specs. No prose.';

  const bytes = Uint8Array.from(atob(img.b64), c => c.charCodeAt(0));

  /* Llama's vision model is the sharpest of these, and Cloudflare gates it
     behind Meta's licence: until the account has sent the prompt "agree"
     once, every call comes back 5016 and identification simply never
     happens. That is not something to accept on someone's behalf, so the
     open model is tried next and the licence is offered as a choice in
     settings (POST /v1/agree). */
  const models = [cfg(env, 'CF_VISION_MODEL'), cfg(env, 'CF_VISION_FALLBACK')]
    .filter((m, i, a) => m && a.indexOf(m) === i);

  let out = null, lastErr = '', gated = false;
  for (const model of models) {
    try {
      out = await runVision(env, model, prompt, image, bytes);
      if (out) break;
    } catch (e) {
      lastErr = String(e && e.message || e);
      if (licenceRefused(lastErr)) gated = true;
      out = null;
    }
  }
  if (!out) {
    return { ok: false, status: 502,
             error: gated ? 'the sharper vision model needs its licence accepted once - Settings has the button'
                          : 'workers ai: ' + lastErr.slice(0, 120),
             gatedModel: gated ? models[0] : '' };
  }

  const text = (out && (out.response || out.description || out.text)) || '';
  const rec = normalise(looseJson(text), hint);
  rec.source = 'workers-ai';
  return rec;
}

/* Workers AI vision models have taken two input shapes over time; try the
   messages form first and fall back to the older prompt+image form. */
/* Cloudflare answers the licence agreement with code 5016 and the words
   "Thank you for agreeing to this model's terms. You may now use the
   model." - the same code it uses to REFUSE. So the code says nothing; the
   sentence is what matters, and matching on the code alone reported a
   successful acceptance as a failure. */
function licenceRefused(e) {
  var m = String((e && e.message) || e || '');
  if (/thank you for agreeing|you may now use/i.test(m)) return false;
  return /must submit the prompt|prior to using this model/i.test(m);
}

async function runVision(env, model, prompt, image, bytes) {
  try {
    return await env.AI.run(model, {
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: image } }
      ] }],
      max_tokens: 400, temperature: 0.1
    });
  } catch (e1) {
    /* A licence refusal is about the model, not the input shape, so there is
       no point trying the other one. */
    if (licenceRefused(e1)) throw e1;
    return await env.AI.run(model, { prompt, image: Array.from(bytes), max_tokens: 400, temperature: 0.1 });
  }
}

async function workersAITranslate(env, text, from, to) {
  if (!env.AI) return null;
  try {
    const r = await env.AI.run(cfg(env, 'CF_TRANSLATE_MODEL'), {
      text, source_lang: from || 'en', target_lang: to
    });
    const out = r && r.translated_text;
    return out ? { ok: true, text: out, via: 'workers-ai' } : null;
  } catch (e) { return null; }
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

  const viaCf = await workersAITranslate(env, text, from, to);
  if (viaCf) return viaCf;

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
          identify: !!(env.AI || cfg(env, 'GEMINI_KEY')),
          engine: cfg(env, 'GEMINI_KEY') ? 'gemini' : (env.AI ? 'workers-ai' : 'none'),
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

        /* The keyless default is Workers AI. A free Gemini key, if present,
           is used instead because its answers are sharper - but nothing here
           requires one. */
        let g;
        if (cfg(env, 'GEMINI_KEY')) {
          g = await gemini(env, image, hint);
          if (!g.ok && g.status !== 429) g = await workersAI(env, image, hint);
        } else {
          g = await workersAI(env, image, hint);
        }
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

    /* ---- transcribe ----

       Web Speech recognition is missing or broken on a great many phones -
       Safari in particular - and when it fails it fails silently, which is
       the "captions don't work" report. This route is the way round it that
       needs no key: Whisper runs on the same AI binding as identification,
       transcribes a few seconds of audio and says which language it heard,
       which is also what makes translate-to-English work without the
       listener naming the language first. */
    if (path === '/v1/transcribe') {
      if (!env.AI) return err('no AI binding on this endpoint', 501, env);
      const audio = String(body.audio || '');
      const b64 = audio.indexOf(',') !== -1 ? audio.slice(audio.indexOf(',') + 1) : audio;
      if (!b64) return err('audio is required', 400, env);
      if (b64.length > 900000) return err('audio too long', 413, env);
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const out = await env.AI.run(cfg(env, 'CF_STT_MODEL'), { audio: Array.from(bytes) });
        const text = String((out && (out.text || out.transcription)) || '').trim();
        return json({ ok: true, text, language: (out && out.language) || '', via: 'whisper' }, 200, env);
      } catch (e) {
        return err('transcription failed', 502, env, { detail: String(e && e.message || e).slice(0, 160) });
      }
    }

    /* ---- accept the model licence ----

       Cloudflare requires the account to send the prompt "agree" once before
       Meta's vision model will run. The app will not do that by itself: it
       is a licence, and it is the account owner's to accept. This route
       exists so they can, deliberately, from settings. */
    if (path === '/v1/agree') {
      if (!env.AI) return err('no AI binding on this endpoint', 501, env);
      const model = String(body.model || cfg(env, 'CF_VISION_MODEL')).slice(0, 120);
      try {
        await env.AI.run(model, { prompt: 'agree' });
        return json({ ok: true, model, accepted: true }, 200, env);
      } catch (e) {
        const m = String(e && e.message || e);
        /* Accepting a licence is not a completion, so the call throws even
           when it worked. Only a message that is STILL asking for the
           agreement means it did not land. */
        if (!licenceRefused(e)) {
          return json({ ok: true, model, accepted: true, note: m.slice(0, 140) }, 200, env);
        }
        return err('the licence was not accepted: ' + m.slice(0, 140), 502, env);
      }
    }

    return err('unknown route', 404, env);
  }
};
