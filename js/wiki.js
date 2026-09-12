/* Sightline - Wikipedia + Wikidata.
   Both are CORS-open and keyless, so every call here runs straight from the
   browser: no quota, no cost, nothing proxied.

   This module owns the rule that keeps the people feature honest:
   a name is only ever shown if Wikidata says the subject is a HUMAN (P31=Q5),
   has NO date of death (P570), and has a real Wikipedia article. A lookalike
   matched against a historical figure is therefore dropped rather than drawn. */
'use strict';

var WIKI = (function () {

  var WP = 'https://en.wikipedia.org/w/api.php';
  var WD = 'https://www.wikidata.org/wiki/Special:EntityData/';

  var pageCache = U.Cache('wiki', 150);
  var entCache  = U.Cache('wd', 150);

  /* ---- Wikipedia page: extract, thumbnail, and the Wikidata id ---- */
  function page(title) {
    var key = String(title).toLowerCase();
    var hit = pageCache.get(key);
    if (hit) return Promise.resolve(hit);

    var url = WP + '?action=query&format=json&origin=*&redirects=1' +
      '&prop=extracts|pageimages|pageprops' +
      '&exintro=1&explaintext=1&piprop=thumbnail&pithumbsize=640&ppprop=wikibase_item' +
      '&titles=' + encodeURIComponent(title);

    return U.jget(url, 9000).then(function (j) {
      var pages = (j && j.query && j.query.pages) || {};
      var ids = Object.keys(pages);
      if (!ids.length) return null;
      var p = pages[ids[0]];
      if (!p || p.missing !== undefined) return null;
      var out = {
        title: p.title,
        extract: p.extract || '',
        thumb: (p.thumbnail && p.thumbnail.source) || '',
        qid: (p.pageprops && p.pageprops.wikibase_item) || '',
        url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(p.title).replace(/ /g, '_'))
      };
      pageCache.set(key, out);
      return out;
    }).catch(function () { return null; });
  }

  /* ---- Free-text search, for when the model's phrasing is not a page title ---- */
  function search(q) {
    var url = WP + '?action=query&format=json&origin=*&list=search&srlimit=1&srsearch=' +
      encodeURIComponent(q);
    return U.jget(url, 9000).then(function (j) {
      var hits = (j && j.query && j.query.search) || [];
      return hits.length ? hits[0].title : null;
    }).catch(function () { return null; });
  }

  /* Try the name as a title first; fall back to search. */
  function resolve(name) {
    return page(name).then(function (p) {
      if (p) return p;
      return search(name).then(function (t) { return t ? page(t) : null; });
    });
  }

  /* ---- Wikidata claims ---- */
  function claim(ent, prop) {
    var c = ent && ent.claims && ent.claims[prop];
    return (c && c.length) ? c : null;
  }
  function claimIds(ent, prop) {
    var c = claim(ent, prop);
    if (!c) return [];
    return c.map(function (s) {
      var v = s.mainsnak && s.mainsnak.datavalue && s.mainsnak.datavalue.value;
      return (v && v.id) || null;
    }).filter(Boolean);
  }
  function claimValue(ent, prop) {
    var c = claim(ent, prop);
    if (!c) return null;
    var v = c[0].mainsnak && c[0].mainsnak.datavalue && c[0].mainsnak.datavalue.value;
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (v.time) return v.time;
    if (v.text) return v.text;
    if (v.amount) return v.amount;
    return null;
  }

  function entity(qid) {
    if (!qid) return Promise.resolve(null);
    var hit = entCache.get(qid);
    if (hit) return Promise.resolve(hit);
    return U.jget(WD + encodeURIComponent(qid) + '.json', 9000).then(function (j) {
      var e = j && j.entities && j.entities[qid];
      if (!e) return null;
      entCache.set(qid, e);
      return e;
    }).catch(function () { return null; });
  }

  function yearOf(timeStr) {
    if (!timeStr) return null;
    var m = /^([+-])(\d{4})/.exec(timeStr);
    if (!m) return null;
    var y = parseInt(m[2], 10);
    return m[1] === '-' ? -y : y;
  }

  /* labelsFor answers a LIST with the misses dropped, which is fine when
     every id is the same kind of thing and useless when they are not - you
     cannot tell an occupation from a film in the result. This answers a
     map, so each group can be picked out by its own ids. */
  function labelsBy(qids) {
    if (!qids.length) return Promise.resolve({});
    var url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*' +
      '&props=labels&languages=en&ids=' + qids.slice(0, 12).join('|');
    return U.jget(url, 9000).then(function (j) {
      var ents = (j && j.entities) || {}, out = {};
      qids.forEach(function (q) {
        var e = ents[q];
        var v = e && e.labels && e.labels.en && e.labels.en.value;
        if (v) out[q] = v;
      });
      return out;
    }).catch(function () { return {}; });
  }

  function labelsFor(qids) {
    if (!qids.length) return Promise.resolve([]);
    var url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*' +
      '&props=labels&languages=en&ids=' + qids.slice(0, 12).join('|');
    return U.jget(url, 9000).then(function (j) {
      var ents = (j && j.entities) || {};
      return qids.map(function (q) {
        var e = ents[q];
        return (e && e.labels && e.labels.en && e.labels.en.value) || null;
      }).filter(Boolean);
    }).catch(function () { return []; });
  }

  /* ---- THE PERSON GATE ----
     Returns { ok:true, ... } only for a living human with an article.
     Every other outcome carries a `reason`, so the UI can say why nothing
     was drawn instead of silently showing a bare box. */
  function person(name) {
    return resolve(name).then(function (p) {
      if (!p) return { ok: false, reason: 'no-article' };
      return entity(p.qid).then(function (e) {
        if (!e) return { ok: false, reason: 'no-entity' };

        var isHuman = claimIds(e, 'P31').indexOf('Q5') !== -1;
        if (!isHuman) return { ok: false, reason: 'not-a-person', page: p };

        /* P570 = date of death. Present at all means we do not label. */
        var died = claimValue(e, 'P570');
        if (died) {
          return { ok: false, reason: 'deceased', diedYear: yearOf(died), page: p, name: p.title };
        }
        /* A birth year older than any living human is a data error, not a living person. */
        var born = yearOf(claimValue(e, 'P569'));
        var thisYear = new Date().getUTCFullYear();
        if (born != null && (thisYear - born) > 120) {
          return { ok: false, reason: 'deceased', page: p, name: p.title };
        }

        /* WHAT SOMEBODY POINTING A CAMERA AT AN ACTOR ACTUALLY WANTS.

           "must be able to easily identify movie stars" - and a name on
           its own barely answers that. The films are the recognition:
           nine times out of ten the question behind the question is "what
           do I know them from". P800 is notable works, P166 awards, P27
           nationality. All three are one extra call, batched into the
           label lookup that was already being made. */
        var jobIds = claimIds(e, 'P106').slice(0, 3);
        var workIds = claimIds(e, 'P800').slice(0, 4);
        var awardIds = claimIds(e, 'P166').slice(0, 3);
        var natIds = claimIds(e, 'P27').slice(0, 1);
        var all = jobIds.concat(workIds, awardIds, natIds);
        return labelsBy(all).then(function (byId) {
          var pick = function (ids) {
            return ids.map(function (q) { return byId[q]; }).filter(Boolean);
          };
          return {
            ok: true,
            name: p.title,
            qid: p.qid,
            extract: p.extract,
            thumb: p.thumb,
            url: p.url,
            bornYear: born,
            occupations: pick(jobIds),
            knownFor: pick(workIds),
            awards: pick(awardIds),
            country: pick(natIds)[0] || null,
            website: claimValue(e, 'P856') || ''
          };
        });
      });
    }).catch(function () { return { ok: false, reason: 'error' }; });
  }

  /* ---- Species: adds taxon facts on top of the article ---- */
  function taxon(name) {
    return resolve(name).then(function (p) {
      if (!p) return null;
      return entity(p.qid).then(function (e) {
        var out = {
          name: p.title, extract: p.extract, thumb: p.thumb, url: p.url, qid: p.qid,
          scientific: '', rank: '', conservation: '', parent: '', common: ''
        };
        if (!e) return out;
        out.scientific = claimValue(e, 'P225') || '';
        /* The four facts that answer "what kind of tree is this" once
           something has given it a name. All from Wikidata, which has no key
           and no quota worth the name - it is the one part of species
           identification that really is unlimited. */
        return Promise.all([
          labelsFor(claimIds(e, 'P105')),   // taxon rank: species, genus, family
          labelsFor(claimIds(e, 'P141')),   // IUCN conservation status
          labelsFor(claimIds(e, 'P171'))    // parent taxon - the genus, or the family
        ]).then(function (r) {
          out.rank = r[0][0] || '';
          out.conservation = r[1][0] || '';
          out.parent = r[2][0] || '';
          out.common = claimValue(e, 'P1843') || '';   // its common name, per Wikidata
          return out;
        });
      });
    }).catch(function () { return null; });
  }

  /* ---- Anything else: a plain article plus a one-line description ---- */
  function thing(name) {
    return resolve(name).then(function (p) {
      if (!p) return null;
      return entity(p.qid).then(function (e) {
        var out = { name: p.title, extract: p.extract, thumb: p.thumb, url: p.url, qid: p.qid, maker: '', from: '' };
        if (!e) return out;
        return labelsFor(claimIds(e, 'P176')).then(function (makers) {   // manufacturer
          out.maker = makers[0] || '';
          var start = yearOf(claimValue(e, 'P571'));                     // inception
          out.from = start ? String(start) : '';
          return out;
        });
      });
    }).catch(function () { return null; });
  }

  return { page: page, search: search, resolve: resolve, entity: entity,
           person: person, taxon: taxon, thing: thing, yearOf: yearOf };
})();
