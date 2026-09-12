/* The licence-refusal test, run against the real function. Cloudflare uses
   one error code for both "you have not agreed" and "thank you for
   agreeing", so only the sentence can tell them apart. */
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../worker/index.js', import.meta.url),'utf8');
const body = src.slice(src.indexOf('function licenceRefused'), src.indexOf('async function runVision'));
const licenceRefused = new Function(body + '; return licenceRefused;')();

const cases = [
  ["5016: Thank you for agreeing to this model's terms. You may now use the model.", false, 'the acceptance'],
  ["5016: Prior to using this model, you must submit the prompt 'agree'.", true, 'the refusal'],
  ["5016: You may now use the model", false, 'a terser acceptance'],
  ["InferenceUpstreamError: 502", false, 'an unrelated failure'],
  ["", false, 'nothing at all']
];
let bad = 0;
for (const [msg, want, what] of cases) {
  const got = licenceRefused(new Error(msg));
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? '  ok   ' : '  FAIL ') + what + ' -> refused=' + got);
}
console.log(bad ? bad + ' FAILED' : 'all ' + cases.length + ' correct');
process.exit(bad ? 1 : 0);
