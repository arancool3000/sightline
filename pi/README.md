# Sightline on a Raspberry Pi 5

The app talks to one endpoint and does not care what is behind it. Put your
Pi behind it and nobody is metering you, because nobody else is paying.

**Read the trade-off first.** A Pi 5 has no GPU worth the name. A vision
model small enough to run on it is a 2-billion-parameter model, and a model
that size will tell you "a black backpack" far more often than "Mous Extreme
Luggage, £290". Expect **three to fifteen seconds** an answer, not half a
second.

So the honest recommendation is: keep Cloudflare's Worker as the everyday
engine, and use the Pi when you want it to be *yours* — no account, no
licence, no daily allowance, and it keeps working if Cloudflare does not.
Switching between them is one field in Settings.

---

## 1. The model

[llama.cpp](https://github.com/ggml-org/llama.cpp) does the work.

```sh
sudo apt update && sudo apt install -y git cmake build-essential libcurl4-openssl-dev
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j4
```

Then pick a vision model. Smallest to largest, all of which fit in 8 GB:

| model | size | speed on a Pi 5 | what it is good for |
|---|---|---|---|
| `ggml-org/SmolVLM-500M-Instruct-GGUF` | ~0.5 GB | fastest, a second or two | "is there a dog in this" |
| `ggml-org/Qwen2-VL-2B-Instruct-GGUF` | ~2 GB | 5-15 s | the best balance; start here |
| `ggml-org/gemma-3-4b-it-GGUF` | ~3.5 GB | 20 s+ | better answers, testing patience |

```sh
./build/bin/llama-server -hf ggml-org/Qwen2-VL-2B-Instruct-GGUF \
  --host 127.0.0.1 --port 8080 -t 4 -c 4096
```

Leave that running. It is the engine; the next part is the door.

## 2. The door

```sh
sudo apt install -y nodejs
cd ~/sightline/pi
SIGHTLINE_SECRET=$(head -c 24 /dev/urandom | base64 | tr -d '/+=') \
  node server.mjs
```

Write that secret down — the app sends it as a header, and **without it the
server refuses every request**. That is deliberate: something reachable from
the internet with no lock on it will be found, and it is your Pi.

To have it start with the machine, `pi/sightline-pi.service` is a systemd
unit ready to copy into `/etc/systemd/system/`.

## 3. Reaching it from outside the house

Do **not** forward a port. Use a Cloudflare Tunnel: it is free, it needs no
open port and no static address, and it gives you a name on a domain you
already have.

```sh
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/

cloudflared tunnel login
cloudflared tunnel create sightline
cloudflared tunnel route dns sightline sightline.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:8088 sightline
```

Now `https://sightline.yourdomain.com` reaches the Pi from anywhere, over
TLS, with the Pi making the outbound connection rather than accepting an
inbound one.

*(Tailscale Funnel does the same job on its free tier if you would rather not
use a domain.)*

## 4. Point the app at it

Settings → **ANALYSIS ENDPOINT** → `https://sightline.yourdomain.com`, then
**TEST CONNECTION**.

## What this does and does not answer

- **Identification** and **translation**: yes, both routes.
- **Captions**: no. Whisper on a Pi 5 runs at roughly real time for the
  tiny model, which is too slow to caption a conversation as it happens.
  Leave captions on the browser's own recogniser or on the Worker.
- **Speed**: a Pi answers in seconds. The on-device tier in the browser is
  still what gives you a label immediately; the Pi is the detail behind it,
  exactly as the Worker is.
