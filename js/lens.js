/* Sightline - reading a sign in a language you do not have.

   "add live translation from camera like google translate camera mode
    where it overlays in same/similar colour text translated over the
    different language text."

   The trick that makes Google's version feel like magic is not the
   translation, it is that the translation SITS WHERE THE WORDS WERE, in
   roughly their colour, so a sign simply appears to be in your language.
   Two things follow from that:

     THE BOXES MATTER AS MUCH AS THE WORDS. A correct translation in a
     list at the bottom of the screen is a dictionary. On the sign, it is
     a sign you can read.

     THE COLOUR IS TAKEN FROM THE PICTURE, NOT GUESSED. Sampling the block
     the model pointed at gives an ink and a ground that already match the
     scene, so the patch does not read as a sticker.

   Reading the text is Gemini's job - it returns the blocks, their boxes
   and their translations in one answer, which is one round trip rather
   than an OCR pass plus a translation pass. With no key there is nothing
   here that can read a sign, and it says so rather than pretending.   */
var LENS = (function () {

  var on = false, busy = false, at = 0, blocks = [], err = '', lastTo = '';
  var EVERY_MS = 2600;         // a sign does not move; re-reading faster is waste
  var listeners = [];

  function onEvent(fn) { listeners.push(fn); }
  function fire(ev) { listeners.forEach(function (f) { try { f(ev); } catch (e) {} }); }

  function available() { return !!(window.GEM && GEM.has && GEM.has()); }
  function running() { return on; }
  function state() { return { on: on, busy: busy, blocks: blocks.length, error: err, to: lastTo }; }
  function all() { return blocks; }

  function start() {
    if (on) return true;
    if (!available()) { err = 'Reading a sign needs a Gemini key.'; fire({ kind: 'error', error: err }); return false; }
    on = true; err = ''; blocks = []; at = 0;
    fire({ kind: 'on' });
    return true;
  }
  function stop() {
    if (!on) return;
    on = false; blocks = []; busy = false;
    fire({ kind: 'off' });
  }
  function toggle() { return on ? (stop(), false) : start(); }

  /* Called from the app loop. Paces itself and does nothing while a read
     is outstanding. */
  function step(now) {
    if (!on || busy || !window.CAM || !CAM.live || !CAM.live()) return;
    if (now - at < EVERY_MS) return;
    at = now;
    read();
  }

  var PROMPT =
    'Read every piece of TEXT in this photograph and translate it into ' +
    '{{TO}}.\n' +
    'Reply as JSON only: {"blocks":[{"text":"","out":"","box":[x,y,w,h]}]}\n' +
    '- "text" is what is written, exactly as it appears.\n' +
    '- "out" is that text in {{TO}}. If it is already in {{TO}}, copy it unchanged.\n' +
    '- "box" is where it sits, as FRACTIONS of the image from 0 to 1: x and y are the ' +
    'top-left corner, w and h the width and height. Be tight: the box should hug the words.\n' +
    '- One block per line or short phrase that shares a box. Do not merge a heading with a paragraph.\n' +
    '- Ignore watermarks, timestamps and anything too blurred to be sure of.\n' +
    '- If there is no text at all, reply {"blocks":[]}.';

  function read() {
    var to = (window.SET && SET.get('capTo')) || 'en';
    lastTo = to;
    var shot = CAM.frame ? CAM.frame(768) : null;
    if (!shot) return;
    busy = true;
    GEM.ask(PROMPT.replace(/\{\{TO\}\}/g, to), shot, { json: true, maxTokens: 900, temperature: 0 })
      .then(function (r) {
        busy = false;
        if (!r || !r.ok) { err = r && r.error ? r.error : 'could not read that'; fire({ kind: 'error', error: err }); return; }
        var j = r.json;
        if (!j) { try { j = JSON.parse(r.text); } catch (e) { j = null; } }
        var got = (j && j.blocks) || [];
        blocks = got.map(clean).filter(Boolean);
        err = '';
        fire({ kind: 'blocks', blocks: blocks });
      }, function (e) {
        busy = false;
        err = String(e && e.message || e).slice(0, 80);
        fire({ kind: 'error', error: err });
      });
  }

  /* A block is only worth drawing if it has somewhere to go and something
     different to say. Covering a word with the same word is vandalism. */
  function clean(b) {
    if (!b || !b.box || b.box.length !== 4) return null;
    var out = String(b.out || '').trim();
    var src = String(b.text || '').trim();
    if (!out) return null;
    if (out.toLowerCase() === src.toLowerCase()) return null;
    var x = num(b.box[0]), y = num(b.box[1]), w = num(b.box[2]), h = num(b.box[3]);
    if (w <= 0.005 || h <= 0.004) return null;
    if (x < -0.05 || y < -0.05 || x > 1 || y > 1) return null;
    return { text: src, out: out, box: [clamp(x), clamp(y), Math.min(w, 1 - clamp(x)), Math.min(h, 1 - clamp(y))] };
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : -1; }
  function clamp(v) { return Math.max(0, Math.min(1, v)); }

  return { start: start, stop: stop, toggle: toggle, step: step, on: onEvent,
           available: available, running: running, state: state, all: all,
           _clean: clean, EVERY_MS: EVERY_MS, _read: read };
})();
