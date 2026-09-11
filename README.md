# Sightline

Point a camera at the world and it tells you what you are looking at — people,
plants, trees, insects, animals, vehicles and everyday objects — then gives you
the encyclopedia page for any of them with one tap. It also captions speech
live and translates it as it is spoken.

It runs entirely on free tiers.

---

## How it is fast

Two layers, doing different jobs:

**Local.** A TensorFlow.js detector (`lite_mobilenet_v2`) runs in the browser at
roughly 11 passes a second and draws boxes immediately. No network, no key, no
quota. This is what makes the app feel instant — you see a box the moment you
point the camera.

**Remote, and sparingly.** Only once a box has held still for ~0.6s does a
single small crop go up for fine identification. Answers attach to a tracked
object, so the label follows it around the screen and is never requested twice.
At most one lookup is in flight at a time, paced by a setting.

The result: smooth at camera rate, while a day's free API allowance lasts hours
rather than minutes.

---

## Features

### Identification
- **People** — living public figures only. See [docs/PEOPLE.md](docs/PEOPLE.md).
- **Plants and trees** — common name, binomial, family, conservation status.
- **Insects** — species, and whether it bites or stings.
- **Animals** — species, or breed for domestic animals.
- **Vehicles** — make, model, generation, production years.
- **Objects** — anything else in view.

Tap any label for a panel with a photograph, a summary, structured facts and a
link to the Wikipedia article and official site.

**Tap anywhere to identify.** The local detector only knows 80 object classes,
and insects, wild flowers and trees are not among them. Tapping any empty part
of the screen identifies that region from scratch — this is the path that covers
everything outside those 80 classes.

### Live captions and translation
Speech is transcribed by the browser's own Web Speech API (free, no key) and
each finished line is translated. The original can be shown above the
translation. 34 source languages, 32 targets.

---

## Stack

| Layer | What | Cost |
|---|---|---|
| Detection | TensorFlow.js COCO-SSD, in-browser | free, offline |
| Identification | Gemini (AI Studio free tier) via a Worker | free |
| Plants | Pl@ntNet API *(optional)* | free, 500/day |
| Reverse image search | Google Cloud Vision *(optional)* | free to 1,000/mo |
| Encyclopedia | Wikipedia + Wikidata REST, direct from the browser | free, keyless |
| Captions | Web Speech API | free, in-browser |
| Translation | MyMemory, Gemini fallback | free |
| Hosting | Cloudflare Pages + Workers | free |

No build step. No framework. No bundler. The repo is the site.

---

## Running it

See **[docs/SETUP.md](docs/SETUP.md)** — about ten minutes, one required key.

```bash
# locally (a camera needs https or localhost)
npx serve .

# the API
cd worker && wrangler deploy && wrangler secret put GEMINI_KEY
```

---

## Privacy

- Frames are analysed in memory and discarded. No video or audio is recorded.
- Only a cropped region is ever transmitted, only when a lookup is needed.
- No face data is computed, stored or indexed — there is no face database.
- Nothing about what you have seen is kept between sessions.
- The keys live in the Worker. The browser never holds one.

---

## Layout

```
index.html          the whole app shell
css/app.css
js/util.js          helpers, escaping, LRU cache
js/settings.js      persisted preferences
js/wiki.js          Wikipedia + Wikidata; owns the living-person gate
js/camera.js        stream, cover-fit maths, cropping
js/track.js         detections -> objects with stable identity
js/identify.js      the lookup queue and enrichment
js/captions.js      Web Speech + translation
js/ui.js            overlay rendering, detail sheet, settings
js/app.js           boot and the main loop
worker/index.js     Cloudflare Worker: the only thing holding keys
docs/SETUP.md       deployment
docs/PEOPLE.md      the face-identification design and its limits
```

---

## Licence

MIT.
