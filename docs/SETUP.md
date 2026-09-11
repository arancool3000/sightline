# Setting Sightline up

Two pieces: the **site** (static, free on Cloudflare Pages) and the **API worker**
(free on Cloudflare Workers). The site works without the worker — you still get
live boxes for people, animals, vehicles and everyday objects — but nothing is
*named* until the worker is running, because that is where the keys live.

Total cost at normal use: **nothing**.

---

## 1. Get the one key you actually need

**Gemini** — https://aistudio.google.com/apikey → *Create API key*.
Free tier, no card required. This powers every identification: people, plants,
trees, insects, animals, vehicles and objects.

Current free limits are roughly 15 requests/minute and 1,500/day, which at
Sightline's default pacing is a few hours of continuous scanning per day.

---

## 2. Deploy the worker

```bash
npm install -g wrangler
wrangler login

cd worker
wrangler deploy
wrangler secret put GEMINI_KEY      # paste the key when prompted
```

Wrangler prints a URL like `https://sightline-api.<you>.workers.dev`.
Open it in a browser — you should see `{"ok":true,...}`.

---

## 3. Deploy the site

Cloudflare dashboard → **Workers & Pages** → *Create* → **Pages** → *Connect to
Git* → pick this repo.

- Framework preset: **None**
- Build command: *(leave empty)*
- Output directory: `/`

There is no build step. The repo is the site.

---

## 4. Point the site at the worker

Open your Pages URL → **Settings** (top right) → paste the worker URL into
*Analysis endpoint* → **Test connection**. It should report which features are
live.

Then lock the worker down to your own site:

```bash
cd worker
wrangler deploy --var ALLOW_ORIGIN:https://your-site.pages.dev
```

---

## Optional extras

### Better plants — Pl@ntNet (free, 500/day)

A specialist model that beats a general one on flowers, trees and leaves.
Get a key at https://my.plantnet.org/ (free account → API tab).

```bash
wrangler secret put PLANTNET_KEY
```

When set, plants go to Pl@ntNet first and fall back to Gemini.

### True reverse image search — Google Cloud Vision (free for 1,000/month)

This is the "search Google Images" path. Instead of the model recalling who
somebody is, the crop is matched against Google's actual web index, and a name
is returned only when the picture genuinely appears online. It is more accurate
for public figures, and it is what naturally makes private individuals
unidentifiable — an ordinary person's face matches nothing.

1. https://console.cloud.google.com/ → new project
2. Enable **Cloud Vision API**
3. Credentials → Create credentials → API key
4. Restrict the key to the Cloud Vision API

```bash
wrangler secret put VISION_KEY
```

**Watch the quota.** 1,000 units a month are free; past that it is about
$1.50 per 1,000. Leave it unset to stay free forever — Gemini handles people
too, just from memory rather than a live index.

---

## Config reference

| Variable | Where | Default | What it does |
|---|---|---|---|
| `GEMINI_KEY` | secret | — | Required. All identification. |
| `PLANTNET_KEY` | secret | — | Optional plant specialist. |
| `VISION_KEY` | secret | — | Optional reverse image search. |
| `MODEL` | var | `gemini-2.0-flash` | Any vision-capable Gemini model. |
| `ALLOW_ORIGIN` | var | `*` | Set to your Pages origin. |
| `RL_BURST` | var | `40` | Requests per IP per window. |
| `RL_WINDOW` | var | `60` | Window length in seconds. |
| `MAX_IMAGE_KB` | var | `1400` | Rejects oversized uploads. |

---

## Troubleshooting

**"No response. Check the URL is your deployed Worker."**
Open the worker URL directly. If it does not return JSON, the deploy did not
succeed. If it does, the browser is probably being blocked by CORS — set
`ALLOW_ORIGIN` to your exact site origin, including `https://`.

**Boxes appear but nothing is ever named.**
No endpoint set, or `GEMINI_KEY` is missing. Settings → Test connection will say
`identify: false`.

**"Daily free limit reached".**
Gemini's free tier resets at midnight Pacific. Raising *Detail level* to
"Frugal" in Settings makes a day's allowance last considerably longer.

**People are never named.**
That is usually correct behaviour, not a fault — see `docs/PEOPLE.md`.

**Captions do nothing.**
Web Speech API is a Chrome/Edge/Safari feature. Firefox does not implement it.
