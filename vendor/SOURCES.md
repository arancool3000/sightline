# Where the vendored files came from

Pinned on purpose. Two of these must agree with each other, and when they
did not the app killed the browser tab rather than failing.

| file | package | version |
|---|---|---|
| `barcode-detector.js` | `barcode-detector` `dist/iife/ponyfill.js` | 3.2.2 |
| `zxing_reader.wasm` | `zxing-wasm` `dist/reader/zxing_reader.wasm` | **3.1.3** |

`barcode-detector@3.2.2` depends on `zxing-wasm@3.1.3` and its glue is
compiled against that exact build. `js/scan.js` points `locateFile` at our
copy so the decoder never asks a CDN for it. A `zxing_reader.wasm` from any
other version loads, instantiates, and then crashes the renderer on the
first `detect()` - which is what froze an iPad Pro, because Safari has no
built-in `BarcodeDetector` and so has no other path.

To refresh, take both from npm together:

    npm pack barcode-detector@3.2.2     # dist/iife/ponyfill.js -> barcode-detector.js
    npm pack zxing-wasm@3.1.3           # dist/reader/zxing_reader.wasm

and check the version the ponyfill asks for still matches:

    grep -o 'zxing-wasm@[0-9.]*' vendor/barcode-detector.js

`tests/panels_test.cjs` decodes a real EAN-13 through this pair, which is
the check that fails when they drift apart.

## models/hands — MediaPipe hand tracking
- `palm_detection_lite.tflite` (1,985,440 bytes)
- `hand_landmark_lite.tflite` (2,071,408 bytes)

From `https://storage.googleapis.com/mediapipe-assets/`, Google's own
published assets. Apache 2.0, the same licence as MediaPipe itself.

Vendored rather than fetched so hand tracking works offline, needs no
key and has no per-call limit — the standing rule for this app. Run
through the `tf-tflite` runtime that was already here for the species
models. Nothing else in the pipeline changes: `js/hands.js` rebuilds the
detector's anchor grid (2016 boxes, strides 8/16/16/16 over 192px) and
MediaPipe's own rect transformation, both of which are pinned by
`tests/hands_test.cjs` against photographs of real hands.
