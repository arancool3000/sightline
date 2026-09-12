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
