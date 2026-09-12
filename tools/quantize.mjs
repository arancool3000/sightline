/* Shrink a TensorFlow.js graph model in place-ish (writes to a new directory).

   Why: the detector shipped as 18 MB of float32 weights and the classifier as
   5.3 MB. On a phone that is a long wait before anything is recognised and a
   lot of memory held at once - which is what "takes forever to load, then
   crashes" is made of.

   TensorFlow.js reads a per-tensor affine quantisation straight out of the
   manifest (io_utils decodeWeights): value = stored * scale + min. So the
   weights can be stored as uint8 and the library dequantises on load, with
   no change to the app's code at all.

   Small tensors (biases, batch-norm parameters) are left alone: they are a
   rounding error in size and the accuracy they cost is not worth it. int32
   tensors are shapes and indices and must never be touched.

   Two modes, and the choice is a measurement rather than a preference -
   see tests/quantize_test.cjs, which runs the same input through the
   original and the shrunk model:

     uint8    4x smaller. MEASURED to change mobilenet's top-1 class and to
              move a class score by 0.29, so it is not shipped.
     float16  2x smaller. The mantissa loss is far below the noise of the
              model itself.

   Usage: node tools/quantize.mjs <srcDir> <dstDir> [float16|uint8] [minElements] */

import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2], dst = process.argv[3];
const MODE = process.argv[4] || 'float16';
const MIN = Number(process.argv[5] || 1024);
if (MODE !== 'float16' && MODE !== 'uint8') { console.error('mode must be float16 or uint8'); process.exit(1); }
if (!src || !dst) { console.error('usage: quantize.mjs <src> <dst> [minElements]'); process.exit(1); }

const model = JSON.parse(fs.readFileSync(path.join(src, 'model.json'), 'utf8'));
const groups = model.weightsManifest;

// The shards of one group are one contiguous byte stream.
function readGroup(g) {
  return Buffer.concat(g.paths.map(p => fs.readFileSync(path.join(src, p))));
}

/* IEEE-754 half. Returns null for a value half precision cannot hold. */
function f16(v) {
  if (v === 0) return Object.is(v, -0) ? 0x8000 : 0;
  if (!Number.isFinite(v)) return null;
  const sign = v < 0 ? 0x8000 : 0;
  v = Math.abs(v);
  if (v >= 65520) return null;                 // rounds to Infinity
  if (v < 6.103515625e-5) {                    // subnormal
    return sign | Math.round(v / 5.9604644775390625e-8);
  }
  let e = Math.floor(Math.log2(v));
  let m = v / Math.pow(2, e) - 1;
  let mm = Math.round(m * 1024);
  if (mm === 1024) { mm = 0; e += 1; }         // mantissa rounded up a whole step
  if (e > 15) return null;
  if (e < -14) return sign | Math.round(v / 5.9604644775390625e-8);
  return sign | ((e + 15) << 10) | mm;
}

const SZ = { float32: 4, int32: 4, uint8: 1, bool: 1, string: 0, complex64: 8 };
const numel = s => (s && s.length ? s.reduce((a, b) => a * b, 1) : 1);

let before = 0, after = 0, quantised = 0, left = 0;

for (const g of groups) {
  const buf = readGroup(g);
  const out = [];
  let off = 0;

  for (const w of g.weights) {
    const n = numel(w.shape);
    const width = SZ[w.dtype];
    if (width === undefined) throw new Error('unhandled dtype ' + w.dtype);
    const bytes = n * width;
    const slice = buf.subarray(off, off + bytes);
    off += bytes;
    before += bytes;

    if (w.dtype !== 'float32' || n < MIN || w.quantization) {
      out.push(slice); after += bytes; left++;
      continue;
    }

    const f = new Float32Array(slice.buffer, slice.byteOffset, n);

    if (MODE === 'float16') {
      const h = Buffer.allocUnsafe(n * 2);
      let overflow = false;
      for (let i = 0; i < n; i++) {
        const bits = f16(f[i]);
        if (bits === null) { overflow = true; break; }
        h.writeUInt16LE(bits, i * 2);
      }
      // A weight too large for half precision would become Infinity, which
      // is silently catastrophic. Such a tensor is left as it was.
      if (overflow) { out.push(slice); after += bytes; left++; continue; }
      w.quantization = { dtype: 'float16' };
      out.push(h); after += n * 2; quantised++;
      continue;
    }

    // Per-tensor affine range. A constant tensor gets scale 0, which
    // decodes back to exactly `min` for every element.
    let lo = Infinity, hi = -Infinity, bad = false;
    for (let i = 0; i < n; i++) {
      const v = f[i];
      if (!Number.isFinite(v)) { bad = true; break; }
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (bad) { out.push(slice); after += bytes; left++; continue; }

    const scale = hi === lo ? 0 : (hi - lo) / 255;
    const q = Buffer.allocUnsafe(n);
    if (scale === 0) q.fill(0);
    else for (let i = 0; i < n; i++) {
      let v = Math.round((f[i] - lo) / scale);
      q[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }

    w.quantization = { dtype: 'uint8', scale, min: lo };
    out.push(q); after += n; quantised++;
  }

  if (off !== buf.length) throw new Error('manifest and shards disagree: read ' + off + ' of ' + buf.length);

  // One shard per group keeps the manifest simple; the files are small now.
  const name = 'q-' + (groups.indexOf(g) + 1) + '.bin';
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, name), Buffer.concat(out));
  g.paths = [name];
}

fs.writeFileSync(path.join(dst, 'model.json'), JSON.stringify(model));
const mb = b => (b / 1048576).toFixed(2) + ' MB';
console.log(MODE + ': quantised ' + quantised + ' tensors, left ' + left + ' alone');
console.log('weights ' + mb(before) + ' -> ' + mb(after) +
            '  (' + (100 - after / before * 100).toFixed(1) + '% smaller)');
