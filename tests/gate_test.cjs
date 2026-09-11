/* The living-person gate, driven by recorded Wikidata/Wikipedia response
   shapes. The sandbox cannot reach either host, so the network is replaced
   with fixtures that match the real payloads field for field. */
const fs = require('fs');
const vm = require('vm');

const WP_PAGE = (title, qid, extract) => ({
  query: { pages: { '1': {
    pageid: 1, title,
    extract: extract || (title + ' was a thing.'),
    thumbnail: { source: 'https://upload.wikimedia.org/x.jpg' },
    pageprops: { wikibase_item: qid }
  } } }
});
const WP_MISSING = { query: { pages: { '-1': { title: 'x', missing: '' } } } };

const snakId = id => ({ mainsnak: { datavalue: { value: { id } } } });
const snakTime = t => ({ mainsnak: { datavalue: { value: { time: t } } } });
const snakStr = s => ({ mainsnak: { datavalue: { value: s } } });

const ENT = (qid, claims) => ({ entities: { [qid]: { id: qid, claims } } });

/* Real-world shapes: Mozart Q254 (human, died 1791), a living athlete,
   a statue (not a human), and an oak (a taxon). */
const FIX = {
  'titles=Wolfgang%20Amadeus%20Mozart': WP_PAGE('Wolfgang Amadeus Mozart', 'Q254'),
  'Q254.json': ENT('Q254', {
    P31:  [snakId('Q5')],
    P569: [snakTime('+1756-01-27T00:00:00Z')],
    P570: [snakTime('+1791-12-05T00:00:00Z')],
    P106: [snakId('Q36834')]
  }),
  'titles=Living%20Athlete': WP_PAGE('Living Athlete', 'Q1000'),
  'Q1000.json': ENT('Q1000', {
    P31:  [snakId('Q5')],
    P569: [snakTime('+1981-09-26T00:00:00Z')],
    P106: [snakId('Q11513337')],
    P856: [snakStr('https://example.org')]
  }),
  'titles=Venus%20de%20Milo': WP_PAGE('Venus de Milo', 'Q1900'),
  'Q1900.json': ENT('Q1900', { P31: [snakId('Q860861')] }),
  'titles=Ghost%20Person': WP_PAGE('Ghost Person', 'Q2000'),
  'Q2000.json': ENT('Q2000', { P31: [snakId('Q5')], P569: [snakTime('+1830-01-01T00:00:00Z')] }),
  'titles=Recently%20Died': WP_PAGE('Recently Died', 'Q3000'),
  'Q3000.json': ENT('Q3000', {
    P31:  [snakId('Q5')],
    P569: [snakTime('+1960-04-02T00:00:00Z')],
    P570: [snakTime('+2020-08-11T00:00:00Z')],
    P106: [snakId('Q11513337')]
  }),
  'titles=Quercus%20robur': WP_PAGE('Quercus robur', 'Q165145'),
  'Q165145.json': ENT('Q165145', {
    P225: [snakStr('Quercus robur')],
    P105: [snakId('Q7432')],
    P141: [snakId('Q211005')]
  }),
  'titles=Nobody%20At%20All': WP_MISSING,
  'wbgetentities': { entities: {
    Q36834:    { labels: { en: { value: 'composer' } } },
    Q11513337: { labels: { en: { value: 'athlete' } } },
    Q7432:     { labels: { en: { value: 'species' } } },
    Q211005:   { labels: { en: { value: 'Least Concern' } } }
  } },
  'list=search': { query: { search: [] } }
};

function fixtureFor(url) {
  for (const k of Object.keys(FIX)) if (url.indexOf(k) !== -1) return FIX[k];
  return null;
}

const sandbox = { console, setTimeout, clearTimeout, Promise, Date, Math, JSON, encodeURIComponent, parseInt, parseFloat, String, Number, Object, Array };
sandbox.window = sandbox;
sandbox.sessionStorage = { getItem: () => null, setItem: () => {} };
sandbox.document = { querySelector: () => null };
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(require('path').join(__dirname,'..','js','util.js'), 'utf8'), sandbox);

/* Replace only the network, nothing else. */
let calls = 0;
sandbox.U.jget = function (url) {
  calls++;
  const f = fixtureFor(url);
  return f ? Promise.resolve(f) : Promise.reject(new Error('unfixtured: ' + url.slice(0, 90)));
};

vm.runInContext(fs.readFileSync(require('path').join(__dirname,'..','js','wiki.js'), 'utf8'), sandbox);

const R = [];
const t = (n, c, x) => R.push({ n, p: !!c, x: x === undefined ? '' : JSON.stringify(x) });

(async () => {
  const W = sandbox.WIKI;

  const moz = await W.person('Wolfgang Amadeus Mozart');
  t('Mozart refused as deceased', moz.ok === false && moz.reason === 'deceased', moz);
  t('Mozart death year parsed', moz.diedYear === 1791, moz.diedYear);
  t('Mozart name kept for the explanation', moz.name === 'Wolfgang Amadeus Mozart', moz.name);

  const liv = await W.person('Living Athlete');
  t('living human passes', liv.ok === true, { ok: liv.ok, name: liv.name });
  t('occupation resolved to a label', (liv.occupations || [])[0] === 'athlete', liv.occupations);
  t('official website carried', liv.website === 'https://example.org', liv.website);
  t('birth year parsed', liv.bornYear === 1981, liv.bornYear);

  const statue = await W.person('Venus de Milo');
  t('a statue is not a person', statue.ok === false && statue.reason === 'not-a-person', statue.reason);

  const ghost = await W.person('Ghost Person');
  t('born 1830 with no death date is still refused', ghost.ok === false && ghost.reason === 'deceased', ghost.reason);

  /* THE discriminator for the date-of-death check specifically: born inside
     the 120-year window, so the age fallback cannot refuse them. Only P570 can. */
  const recent = await W.person('Recently Died');
  t('recently deceased refused BY THE DEATH DATE', recent.ok === false && recent.reason === 'deceased', recent.reason);
  t('recent death year parsed', recent.diedYear === 2020, recent.diedYear);

  const none = await W.person('Nobody At All');
  t('missing article is refused', none.ok === false && none.reason === 'no-article', none.reason);

  const oak = await W.taxon('Quercus robur');
  t('taxon binomial read', oak && oak.scientific === 'Quercus robur', oak && oak.scientific);
  t('taxon rank label read', oak && oak.rank === 'species', oak && oak.rank);
  t('conservation status read', oak && oak.conservation === 'Least Concern', oak && oak.conservation);

  /* Control: the gate must not be refusing everything. If this fails, the
     "Mozart refused" result above is meaningless. */
  t('CONTROL - the gate lets someone through', liv.ok === true);
  t('CONTROL - fixtures were actually consulted', calls > 8, calls);

  const bad = R.filter(r => !r.p);
  R.forEach(r => console.log((r.p ? 'PASS  ' : 'FAIL  ') + r.n + (r.x ? '   ' + r.x : '')));
  console.log('\n' + (R.length - bad.length) + '/' + R.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})();
