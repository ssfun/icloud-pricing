'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parsePrice, parseApplePricing, buildSnapshot, refresh } = require('../scripts/fetch-prices');

const en = fs.readFileSync(path.join(__dirname, 'fixtures/apple-prices.html'), 'utf8');
const tr = fs.readFileSync(path.join(__dirname, 'fixtures/apple-prices-tr.html'), 'utf8');
const now = new Date('2026-11-23T09:00:00Z');
const fx = {
  base: 'USD', time_last_updated: Date.parse('2026-11-23T00:00:00Z') / 1000,
  rates: { USD: 1, CNY: 7, BRL: 5, EGP: 50, EUR: 0.9, TRY: 45 }
};

test('table uses plan headers, preserves separate USD markets, parses footnotes and locale prices', () => {
  const regions = parseApplePricing(en);
  assert.deepEqual([...regions.keys()], ['US', 'BS', 'BR', 'EG', 'EU', 'CN']);
  assert.equal(regions.get('US').Currency, 'USD');
  assert.equal(regions.get('BS').Currency, 'USD');
  assert.equal(regions.get('BR').Plans[2].Price, 66.9);
  assert.equal(regions.get('EG').Plans[2].Price, 599.99);
  assert.equal(regions.get('CN').Plans[2].Price, 68);
  assert.equal(regions.get('EU').Currency, 'EUR');
  const turkey = parseApplePricing(tr, 'tr');
  assert.deepEqual([...turkey.keys()], ['TR']);
  assert.deepEqual(turkey.get('TR').Plans.map(p => p.Price), [49.99, 169.99, 549.99, 1699.99, 3399.99]);
  const reordered = en.replace('<th>50 GB</th><th>200 GB</th>', '<th>200 GB</th><th>50 GB</th>');
  assert.throws(() => parseApplePricing(reordered), /价格顺序异常/);
});

test('parses grouping and rejects malformed, empty, or negative amounts', () => {
  for (const [input, expected] of [['¥1,800', 1800], ['89.900 TSh', 89900], ['1,699.99 TL', 1699.99],
    ['1.699,99 TL', 1699.99], ['12\u202f900', 12900], ['Rs 749', 749]]) {
    assert.equal(parsePrice(input), expected);
  }
  for (const input of ['—', '-12', '0.00', '1,2,3', '$1 or $2']) assert.throws(() => parsePrice(input));
});

test('does not guess region identity or silently accept duplicates or incomplete rows', () => {
  assert.throws(() => parseApplePricing(en.replace('Bahamas', 'Unmapped')), /未识别/);
  assert.throws(() => parseApplePricing(en.replace('Bahamas²𝄒³', 'United States')), /重复/);
  assert.throws(() => parseApplePricing(en.replace('<td>¥398</td>', '')), /无效 Apple/);
});

function fullFixture() {
  const regions = parseApplePricing(en);
  const turkey = parseApplePricing(tr, 'tr').get('TR');
  regions.set('TR', turkey);
  const ids = new Set(Object.values(require('../data/apple-region-codes.json')));
  for (const id of ids) if (!regions.has(id)) regions.set(id, { ...regions.get('US'), CountryISO: id });
  return regions;
}

test('keeps distinct price/FX timestamps, preserves legacy coverage, rejects stale or missing FX', () => {
  const snapshot = buildSnapshot(fullFixture(), fx, ['apple'], now);
  assert.equal(snapshot.priceVerifiedAt, now.toISOString());
  assert.equal(snapshot.fxUpdatedAt, '2026-11-23T00:00:00.000Z');
  assert.equal(snapshot.regions.find(r => r.CountryISO === 'CN').Plans[2].PriceInCNY, 68);
  assert.equal(snapshot.regions.find(r => r.CountryISO === 'DE').PriceRegionISO, 'EU');
  assert.throws(() => buildSnapshot(fullFixture(), fx, [], now, [{ CountryISO: 'ZZ' }]), /缺少 ZZ/);
  assert.throws(() => buildSnapshot(fullFixture(), { ...fx, rates: { ...fx.rates, TRY: 0 } }, [], now), /汇率: TRY/);
  assert.throws(() => buildSnapshot(fullFixture(), { ...fx, time_last_updated: 1 }, [], now), /更新时间无效/);
});

test('partial Apple response or network error never changes the existing snapshot', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'prices.json');
  const original = '{"regions":[]}\n';
  fs.writeFileSync(output, original);
  await assert.rejects(refresh({ output, now, read: async url =>
    url.includes('exchangerate') ? JSON.stringify(fx) : url.includes('tr-tr') ? tr : en }), /覆盖不足/);
  await assert.rejects(refresh({ output, now, read: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(fs.readFileSync(output, 'utf8'), original);
});
