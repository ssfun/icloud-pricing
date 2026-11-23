'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '../scripts/icloud.js'), 'utf8');
const region = {
  CountryISO: 'TR', Country: 'Türkiye', Currency: 'TRY',
  Plans: ['50GB', '200GB', '2TB', '6TB', '12TB']
    .map((Name, i) => ({ Name, Price: i + 1, PriceInCNY: i + 1 }))
};
const verified = (date) => JSON.stringify({ lastUpdated: date, priceVerifiedAt: date, regions: [region] });
const legacy = JSON.stringify({ lastUpdated: '2026-11-24T00:00:00Z', regions: [region] });

function run({ remote, local, cached, recent = false }) {
  let requests = 0;
  let written = null;
  const context = vm.createContext({
    ObjC: { import() {} }
  });
  vm.runInContext(code, context);
  Object.assign(context, {
    getCacheDir: () => '/cache',
    getWorkflowDir: () => '/workflow',
    getFileMtime: () => recent ? Date.now() : 1,
    ensureDir: () => {},
    readFile: file => file.startsWith('/cache') ? cached : local,
    fetchRemote: url => {
      assert.equal(url, 'https://raw.githubusercontent.com/ssfun/icloud-pricing/main/data/prices.json');
      requests++;
      if (remote instanceof Error) throw remote;
      return remote;
    },
    writeFile: (_, value) => { written = value; }
  });
  const data = context.getPriceData();
  return { data, requests, written };
}

test('Alfred refreshes an expired or unverified cache from the real repository before using bundle', () => {
  const remote = verified('2026-11-23T00:00:00Z');
  const result = run({ remote, local: legacy, cached: legacy, recent: true });
  assert.equal(result.requests, 1);
  assert.equal(result.written, remote);
});

test('Alfred keeps verified cache even if invalid, older, or unverified remote appears fresher', () => {
  const cached = verified('2026-11-23T00:00:00Z');
  for (const remote of ['{"regions":[{}]}', legacy, new Error('offline'), verified('2026-11-10T00:00:00Z')]) {
    const result = run({ remote, cached });
    assert.equal(result.data.priceVerifiedAt, '2026-11-23T00:00:00Z');
    assert.equal(result.written, null);
  }
  assert.equal(run({ cached, recent: true }).requests, 0);
  assert.equal(run({ local: legacy, remote: new Error('offline') }).data.priceVerifiedAt, undefined);
});
