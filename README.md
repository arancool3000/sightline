# Sightline

Point a camera at the world and it tells you what you are looking at — people,
plants, trees, insects, animals, vehicles and everyday objects — then gives you
the encyclopedia page for any of them with one tap. It also captions speech
live and translates it as it is spoken.

It runs entirely on free tiers.

---

## How it is fast

Everything that has to be realtime happens **on the device**. A network round
trip is 400ms at best, so nothing that waits for a server can label a live
scene inside half a second — no matter how fast the server is.

**The live label — on device, continuous.** One MobileNet classification of the
centre of the frame, every pass, no object detection involved. Measured at
**143–327ms on software GL with no GPU at all**, so it holds the half-second
budget on hardware far slower than any phone. This is what runs as you walk
around: point at a plant, read its name, keep walking.

**Boxes — on device, when there is headroom.** `coco-ssd` labels several
distinct things at once, but it costs ~600ms a pass on the same hardware, so it
is deliberately not on the realtime path. Its interval is derived at runtime
from what it actually costs on your device.

**The cloud — an upgrade, never a dependency.** When a label is already on
screen, a crop may go up in the background to sharpen it: a species to an exact
binomial, a car to a model and generation, a person to a name. It replaces the
label in place when it lands. If it never lands, the on-device label stands.

**The app tunes itself.** It measures its own first classifications on the real
device and drops to a lighter model if it is missing the budget. Nothing is
tuned to hardware this code has never run on.

Full measurements and method: **[docs/PERFORMANCE.md](docs/PERFORMANCE.md)**.

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

## What is free, and what "free" means in each case

The rule this was built to: *no API unless it is literally unlimited free
fast use, not practically unlimited.* Here is every source it touches,
sorted honestly, because the difference matters when one of them stops
answering.

### Genuinely uncapped

Nothing meters these, and the app is designed so that these alone are
enough to have something on screen.

| what | why it is uncapped |
|---|---|
| **The detector and the classifier** | They run in your browser. The weights are served from this site and nothing is sent anywhere. There is no request to count. |
| **Your position, heading, speed and distance** | The device's own GPS and compass. Nothing leaves the phone. |
| **Wikipedia and Wikidata** | No key, no account, no quota for a reader. They are read the same way a person reading an article reads them. |
| **Your own hardware** | The Pi in `pi/`. You own it, so nobody is metering it. |

### Free, no key, but a fair-use policy rather than a promise

These have no cost and no sign-up, and their operators ask you not to hammer
them. **The app is built to be a good citizen of each**, and to keep working
when one of them says no.

| what | the policy, and what this app does about it |
|---|---|
| **Open-Meteo** (weather) | Free for non-commercial use with no key. Asked once when you move a few hundred metres, not on a timer. |
| **Overpass** (road geometry) | A volunteer-run service. One request per 700-metre tile, **cached on your device for a month**, and never retried in a loop. A street you have walked down once draws with no network at all. |
| **MyMemory** (translation, fallback) | Has a daily character allowance. Only used if the Worker's own translation is unavailable. |

### Free on your own account, with an allowance

| what | the truth about it |
|---|---|
| **Cloudflare Workers AI** | This is the tier that knows a 3D printer from a Polaroid camera, and it runs on **your** Cloudflare account, on the free plan's daily neuron allowance. That is generous but it is not infinite. When it runs out, everything on-device carries on and names stay generic. |

There is deliberately **no** Google Vision, no PlantNet, no Gemini key and no
tile provider in the default build. The Worker supports them if you set the
keys, and it works completely without them.

### The one thing that is not solved

**Naming a tree species from a photograph, free and unlimited, does not
currently have an answer**, and it is worth being straight about why rather
than pretending otherwise.

- Every keyless species API (iNaturalist, Pl@ntNet) either needs an account
  or does not do image identification without one.
- The only truly unlimited route is a model running on the device, and there
  is no species classifier published in a form this app can vendor. The AIY
  plant and insect classifiers exist but are not available as TensorFlow.js.
- ImageNet, which is what the on-device classifier knows, has almost no tree
  species in it. That is where "rapeseed", "pot" and "valley" for one tree
  came from, and why the on-device tier is now forbidden from naming a
  species at all.

So species identification goes to the detail tier — Workers AI, or your own
Pi — and everything Wikidata knows is layered on top of whatever name comes
back: the binomial, the rank, the genus or family it belongs to, its other
common names, and its conservation status. That part *is* unlimited.

If a species classifier ever ships in a form that can be vendored here, it
drops into the same slot the other two models use and the whole thing
becomes unlimited. Until then this is the honest position.

## Stack

| Layer | What | Cost |
|---|---|---|
| Live labelling | MobileNet, in-browser, on device | free, offline |
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
js/local.js         the realtime tier: on-device labelling, adaptive quality
js/identify.js      the lookup queue and enrichment
js/captions.js      Web Speech + translation
js/ui.js            overlay rendering, detail sheet, settings
js/app.js           boot and the main loop
worker/index.js     Cloudflare Worker: the only thing holding keys
docs/SETUP.md       deployment
docs/PEOPLE.md      the face-identification design and its limits
docs/PERFORMANCE.md what the realtime path costs, measured
```

---

## Licence

MIT.
