# Realtime performance: what was measured

The target is a label on screen **within 500ms** of pointing the camera at
something. This documents what that actually costs, measured rather than
assumed, and what the architecture does about it.

## Method

Real models, real inference, in Chromium. `coco-ssd` (`lite_mobilenet_v2`) and
MobileNet v1 at 224×224, weights served locally, 10–15 samples each after a
warm-up pass, median reported. Harness: `tests/` plus the benchmark described
below.

**The backend was SwiftShader — software GL, no GPU.** Every number here is
therefore a pessimistic floor. A phone or tablet GPU is substantially faster,
and an iPad running a native app on the Neural Engine faster still. Treat these
as "slower than any real device", not as an estimate of one.

## Results

| Step | Median |
|---|---|
| Detector pass, full 1280×720 frame | 631ms |
| Detector pass, frame downscaled to 512 | 572ms |
| Detector pass, frame downscaled to 384 | 566ms |
| Detector pass, frame downscaled to 320 | 555ms |
| Classify one object, MobileNet α1.0 | 327ms |
| Classify one object, MobileNet α0.5 | 143ms |

## What that changed

**Downscaling the detector input barely helps.** 631 → 555ms is 12% for a 16×
reduction in pixels. The hypothesis that the resize was the cost was wrong; the
cost is the network's forward pass. Recorded here because it is the kind of
optimisation that looks obviously right and isn't.

**The classifier's width is a real lever.** α0.5 is 2.3× faster than α1.0 for a
modest accuracy cost, and it is the difference between fitting the budget and
not on slow hardware.

**The detector is the thing that cannot fit.** Detector plus classify is
~1000ms on software GL — double the budget. No amount of tuning closes that.

## The architecture that follows from it

So the detector is not on the realtime path.

**Scene mode is the live path.** One classification of the centre of the frame,
no object detection at all: **143–327ms measured**, inside budget even on
software GL. This is what runs continuously as you walk around, and it is what
produces the live label. It is the same shape as the AR plant-labelling in apps
like PictureThis.

**The detector runs only when there is headroom.** It produces the boxes for
scenes with several distinct things in them, and its interval is derived at
runtime from what it actually costs on the device (`detectEvery()` — measured
cost × 1.6, floor 90ms, ceiling 2s). On a slow phone it thins out rather than
starving the live label of GPU time.

**The app steps itself down.** `considerStepDown()` in `js/local.js` measures
its own first six classifications on the real device and reloads at α0.5 if the
mean is over 160ms. Nothing here is tuned to a device this code has never run
on.

**The cloud is never on the realtime path.** A round trip is 400ms at best, so
it could not be. It upgrades a label already on screen — a species to an exact
binomial, a car to a model and generation, a person to a name — and replaces it
in place when it lands.

## Reading the real numbers on your own device

The two pills at the top of the screen are live: detector rate, and median
time-to-label. In the console:

```js
SL_PERF()
// { sceneLabelMs, firstSceneLabelMs, detectorMs, detectorEveryMs,
//   perObject: { median, p90, worst, n }, classifier: { backend, model } }
```

`sceneLabelMs` is the number the 500ms target is about.

## What is still unverified

No measurement on a real GPU was possible from the build environment — it has
no GPU and blocks the model CDN. The numbers above are a software-GL floor, and
the on-device ladder exists precisely because the real figure cannot be known
from here. The first honest test is `SL_PERF()` on your own phone.
