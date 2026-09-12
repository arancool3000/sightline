/* Sightline - what a scanned code actually means.

   A barcode is a number and a QR is a string. Neither is an answer, so this
   turns them into one.

   PRODUCTS go to Open Food Facts: open data, no key, no account, CORS-open,
   and it already holds the Nutri-Score, the NOVA processing group, the
   additives and the allergens for around three million products. Nothing
   here is invented - every fact shown comes back from that database, and
   where it has nothing the card says so rather than guessing.

   LINKS are shown as what they are before they are opened. A QR code is the
   one thing on a wall that can send you anywhere without you reading where,
   so the domain is spelled out, the tricks are checked for, and the page's
   own title and picture are fetched through the endpoint so the preview
   does not cost you a visit to a site you have not agreed to yet.        */
'use strict';

var CODES = (function () {

  var OFF = 'https://world.openfoodfacts.org/api/v2/product/';
  var cache = {};

  function isProduct(format) {
    return /^(ean|upc)/i.test(String(format || '').replace(/\s/g, '_'));
  }

  /* ---- links ---------------------------------------------------------- */

  function asUrl(value) {
    var v = String(value || '').trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) {
      /* A bare "example.com/x" is a link in every scanner people have used,
         so treat it as one - but only when it really looks like a host. */
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$|\?)/i.test(v)) return null;
      v = 'https://' + v;
    }
    try {
      var u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch (e) { return null; }
  }

  /* THE THINGS A QR CODE ON A WALL DOES TO PEOPLE.

     Every one of these is something a real scam has used, and every one is
     invisible if all you show is "link". They are warnings, not refusals -
     the reader decides, and they cannot decide what they cannot see. */
  function risks(u) {
    var out = [];
    var host = u.hostname;

    if (u.protocol === 'http:') out.push('Not encrypted. Anything you type goes in the clear.');
    if (/^xn--/i.test(host) || /xn--/i.test(host)) {
      out.push('The address uses characters that can be made to look like a different one.');
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) out.push('It points at a bare address, not a named site.');
    if (u.username || u.password) out.push('The link carries a username in it, which is a known trick.');
    /* A long chain ending somewhere else: "paypal.com.login.secure.xyz".
       Counting dots is not enough - www.bbc.co.uk has four labels and is
       the BBC. What matters is how much sits in front of the real site, so
       the public suffix comes off first. */
    if (depth(host) > 2) {
      out.push('It has an unusually deep address - read the LAST two parts, they are the real site.');
    }
    /* A top-level domain used as a middle label is the classic dressing-up:
       "yourbank.com.verify.example". */
    if (/\.(com|net|org|gov|edu|co)\.[a-z]{2,}\./i.test(host) && !TWO_PART.test(host)) {
      out.push('It puts a familiar-looking name in the middle. Only the end of the address decides where it goes.');
    }
    if (/^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|cutt\.ly|rb\.gy|shorturl\.at)$/i.test(host)) {
      out.push('A shortened link. Where it really goes is hidden until you follow it.');
    }
    return out;
  }

  /* Suffixes that are two labels long, so "bbc.co.uk" is one site and not
     a subdomain of anything. Not the whole public-suffix list - that is a
     10,000-line file - but the ones a person is likely to meet. */
  var TWO_PART = /\.(co|com|net|org|gov|edu|ac|gob|or|ne)\.(uk|jp|nz|au|za|in|br|kr|il|tr|id|my|sg|th|ua|mx|ar|pl|es|ch|hk|tw|ph|vn|ng|ke|pk|bd|eg|sa|ae)$/i;

  function depth(host) {
    var h = host.replace(/^www\./i, '');
    var labels = h.split('.');
    var suffix = TWO_PART.test(h) ? 2 : 1;
    return Math.max(0, labels.length - suffix);
  }

  function site(u) {
    var h = u.hostname.replace(/^www\./i, '');
    var keep = TWO_PART.test(h) ? 3 : 2;
    var p = h.split('.');
    return p.length > keep ? p.slice(-keep).join('.') : h;
  }

  /* The page's own title and picture, fetched by the endpoint rather than
     by the browser - the browser cannot read another site's page, and
     asking it to would mean visiting the site to preview it. */
  function preview(u) {
    if (!SET.hasApi()) return Promise.resolve(null);
    return IDENT.post('/v1/preview', { url: u.href })
      .then(function (r) { return (r && r.ok) ? r : null; })
      .catch(function () { return null; });
  }

  function forLink(u) {
    var rec = {
      kind: 'link',
      name: site(u),
      url: u.href,
      host: u.hostname,
      secure: u.protocol === 'https:',
      risks: risks(u),
      pending: true
    };
    return { record: rec, done: preview(u).then(function (p) {
      rec.pending = false;
      if (p) {
        rec.title = p.title || '';
        rec.description = p.description || '';
        rec.image = p.image || '';
        if (p.finalUrl && p.finalUrl !== u.href) {
          rec.finalUrl = p.finalUrl;
          try {
            var f = new URL(p.finalUrl);
            if (f.hostname !== u.hostname) {
              rec.risks = rec.risks.concat(['It redirects to ' + f.hostname + '.']);
            }
          } catch (e) {}
        }
      } else {
        rec.note = SET.hasApi() ? 'The page could not be previewed.'
                                : 'No endpoint set, so the page cannot be previewed.';
      }
      return rec;
    }) };
  }

  /* ---- food ------------------------------------------------------------ */

  /* A HEALTH SCORE, AND HOW IT IS ARRIVED AT.

     There is no official "out of 100" for food, so inventing one silently
     would be dressing a guess as a fact. This is built from figures Open
     Food Facts publishes, the arithmetic is fixed, and the card shows every
     part of it so the number can be argued with:

       Nutri-Score  the official nutritional score, roughly -15 (best) to
                    +40 (worst), mapped onto 0-100
       NOVA         how processed it is, 1 (whole food) to 4 (ultra-
                    processed) - a real and separate thing from nutrition
       additives    each one costs a little, capped, because a long E-number
                    list is a signal even when each is individually fine

     Where Nutri-Score is missing there is no score at all. A number built
     out of nothing is worse than an empty space. */
  function healthScore(p) {
    var parts = [];
    var raw = null;

    var nd = p.nutriscore_data || {};
    if (typeof nd.score === 'number') raw = nd.score;
    else if (typeof p.nutriscore_score === 'number') raw = p.nutriscore_score;

    var base = null;
    if (raw !== null) {
      base = Math.round(100 - ((raw + 15) * 100 / 55));
      base = Math.max(0, Math.min(100, base));
      parts.push({ k: 'Nutri-Score', v: (p.nutriscore_grade ? p.nutriscore_grade.toUpperCase() + '  ' : '') + '(' + raw + ' points)', d: 0 });
    } else if (p.nutriscore_grade) {
      var byGrade = { a: 85, b: 70, c: 55, d: 40, e: 25 };
      base = byGrade[String(p.nutriscore_grade).toLowerCase()];
      if (typeof base === 'number') parts.push({ k: 'Nutri-Score', v: String(p.nutriscore_grade).toUpperCase(), d: 0 });
    }
    if (base === null || base === undefined) return null;

    var score = base;
    var nova = Number(p.nova_group);
    if (nova === 4) { score -= 12; parts.push({ k: 'Ultra-processed', v: 'NOVA 4', d: -12 }); }
    else if (nova === 3) { score -= 5; parts.push({ k: 'Processed', v: 'NOVA 3', d: -5 }); }
    else if (nova === 1) { score += 3; parts.push({ k: 'Unprocessed', v: 'NOVA 1', d: +3 }); }

    var adds = (p.additives_tags || []).length;
    if (adds) {
      var pen = Math.min(16, adds * 2);
      score -= pen;
      parts.push({ k: adds + (adds === 1 ? ' additive' : ' additives'), v: '', d: -pen });
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score: score, parts: parts, base: base };
  }

  /* The E-numbers people actually meet, in plain words. Anything not here
     is shown as its number rather than described, because a description
     nobody checked is the thing this app exists not to do. */
  var E = {
    e100: 'Curcumin, a turmeric colour', e101: 'Riboflavin, vitamin B2',
    e120: 'Cochineal, a colour made from insects', e129: 'Allura Red, a colour',
    e102: 'Tartrazine, a yellow colour', e110: 'Sunset Yellow, a colour',
    e122: 'Carmoisine, a colour', e124: 'Ponceau 4R, a colour',
    e150a: 'Plain caramel colour', e150c: 'Ammonia caramel colour', e150d: 'Sulphite caramel colour',
    e160a: 'Carotene, an orange colour', e163: 'Anthocyanins, a plant colour',
    e200: 'Sorbic acid, a preservative', e202: 'Potassium sorbate, a preservative',
    e211: 'Sodium benzoate, a preservative', e223: 'Sodium metabisulphite, a preservative',
    e250: 'Sodium nitrite, a curing salt', e251: 'Sodium nitrate, a curing salt',
    e260: 'Acetic acid, vinegar', e270: 'Lactic acid',
    e300: 'Ascorbic acid, vitamin C', e306: 'Tocopherols, vitamin E',
    e322: 'Lecithin, an emulsifier', e330: 'Citric acid', e331: 'Sodium citrate',
    e338: 'Phosphoric acid', e341: 'Calcium phosphate',
    e400: 'Alginic acid, a thickener', e401: 'Sodium alginate, a thickener',
    e407: 'Carrageenan, a thickener from seaweed', e410: 'Locust bean gum',
    e412: 'Guar gum', e414: 'Gum arabic', e415: 'Xanthan gum',
    e420: 'Sorbitol, a sweetener', e422: 'Glycerol',
    e440: 'Pectin, a gelling agent', e450: 'Diphosphates', e451: 'Triphosphates',
    e460: 'Cellulose', e466: 'Carboxymethyl cellulose, a thickener',
    e471: 'Mono- and diglycerides, an emulsifier', e472e: 'DATEM, an emulsifier',
    e476: 'Polyglycerol polyricinoleate, an emulsifier',
    e500: 'Sodium carbonates, a raising agent', e503: 'Ammonium carbonates',
    e621: 'Monosodium glutamate, a flavour enhancer',
    e627: 'Disodium guanylate', e631: 'Disodium inosinate',
    e900: 'Dimethyl polysiloxane, an anti-foaming agent',
    e950: 'Acesulfame K, a sweetener', e951: 'Aspartame, a sweetener',
    e952: 'Cyclamate, a sweetener', e954: 'Saccharin, a sweetener',
    e955: 'Sucralose, a sweetener', e960: 'Steviol glycosides, from stevia',
    e965: 'Maltitol, a sweetener', e967: 'Xylitol, a sweetener',
    e1422: 'Modified starch'
  };

  function additives(p) {
    return (p.additives_tags || []).map(function (tag) {
      var id = String(tag).replace(/^en:/, '').toLowerCase();
      return { code: id.toUpperCase(), what: E[id] || '' };
    });
  }

  function levels(p) {
    var n = p.nutrient_levels || {};
    var rows = [];
    [['fat', 'Fat'], ['saturated-fat', 'Saturated fat'], ['sugars', 'Sugar'], ['salt', 'Salt']]
      .forEach(function (pair) {
        var v = n[pair[0]];
        if (v) rows.push({ k: pair[1], v: v.replace(/_/g, ' ') });
      });
    return rows;
  }

  function forProduct(code) {
    if (cache[code]) return { record: cache[code], done: Promise.resolve(cache[code]) };
    var rec = { kind: 'product', code: code, name: '', pending: true };
    var done = U.fetchT(OFF + encodeURIComponent(code) +
        '.json?fields=product_name,brands,quantity,image_front_small_url,nutriscore_grade,' +
        'nutriscore_score,nutriscore_data,nova_group,additives_tags,allergens_tags,' +
        'nutrient_levels,ingredients_text,categories,labels', {}, 12000)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        rec.pending = false;
        if (!j || j.status !== 1 || !j.product) {
          rec.missing = true;
          rec.note = 'Not in Open Food Facts. Anyone can add it - the database is open.';
          return rec;
        }
        var p = j.product;
        rec.name = p.product_name || ('Barcode ' + code);
        rec.brand = p.brands || '';
        rec.quantity = p.quantity || '';
        rec.image = p.image_front_small_url || '';
        rec.grade = p.nutriscore_grade || '';
        rec.nova = Number(p.nova_group) || 0;
        rec.health = healthScore(p);
        rec.additives = additives(p);
        rec.levels = levels(p);
        rec.allergens = (p.allergens_tags || []).map(function (a) {
          return String(a).replace(/^en:/, '').replace(/-/g, ' ');
        });
        rec.ingredients = p.ingredients_text || '';
        cache[code] = rec;
        return rec;
      })
      .catch(function () {
        rec.pending = false;
        rec.note = 'Open Food Facts could not be reached.';
        return rec;
      });
    return { record: rec, done: done };
  }

  /* ---- the one door ---------------------------------------------------- */

  function resolve(hit) {
    if (!hit) return null;
    if (isProduct(hit.format)) return forProduct(hit.value.replace(/\D/g, ''));
    var u = asUrl(hit.value);
    if (u) return forLink(u);
    return { record: { kind: 'text', name: 'Text', text: hit.value, pending: false },
             done: Promise.resolve(null) };
  }

  return { resolve: resolve, healthScore: healthScore, risks: risks, asUrl: asUrl,
           depth: depth, site: site,
           isProduct: isProduct, additives: additives, E: E };
})();
