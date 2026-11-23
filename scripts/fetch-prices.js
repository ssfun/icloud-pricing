#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { load } = require('cheerio');
const regionCodes = require('../data/apple-region-codes.json');

const APPLE = 'https://support.apple.com/en-us/108047';
const APPLE_TR = 'https://support.apple.com/tr-tr/108047';
const FX = 'https://api.exchangerate-api.com/v4/latest/USD';
const OUTPUT = path.join(__dirname, '../data/prices.json');
const PLANS = ['50GB', '200GB', '2TB', '6TB', '12TB'];
// Explicit floor prevents a partial scrape from becoming the baseline.
const MIN_REGIONS = 150;
const REQUIRED = 'TR EG BR NG RU PK VN PH IN CL KR ID PE ZA SE CN CA TW MX NZ JP MY US SG PL AU HK CO TH DK SA AE DE FR CH IL NO GB'.split(' ');

function parsePrice(value) {
  if (/[-−]/.test(value)) throw new Error(`无效价格: ${value}`);
  const numeric = value.match(/\d[\d.,\s\u00a0\u202f]*\d|\d/g);
  if (!numeric || numeric.length !== 1) throw new Error(`无效价格: ${value}`);
  const raw = numeric[0].replace(/\s/g, '');
  // The Apple tables use a two-digit fractional part and three-digit groups.
  const decimal = /[.,]\d{2}$/.test(raw) ? raw.length - 3 : -1;
  const whole = decimal < 0 ? raw : raw.slice(0, decimal);
  if (!/^\d+$/.test(whole) && !/^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/.test(whole)) {
    throw new Error(`无效价格分隔符: ${value}`);
  }
  const amount = Number(whole.replace(/[.,]/g, '') + (decimal < 0 ? '' : '.' + raw.slice(-2)));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`无效价格: ${value}`);
  return amount;
}

function parseApplePricing(html, locale = 'en') {
  const $ = load(html);
  const regions = new Map();
  $('table').each((_, table) => {
    const rows = $(table).find('tr').toArray();
    if (!rows.length) return;
    const planHeaders = $(rows[0]).children('th, td').slice(1)
      .map((_, cell) => $(cell).text().replace(/\s/g, '').toUpperCase()).get();
    if (planHeaders.length !== PLANS.length || new Set(planHeaders).size !== PLANS.length ||
        !PLANS.every(plan => planHeaders.includes(plan))) return;

    for (const row of rows.slice(1)) {
      const cells = $(row).children('th, td').map((_, cell) => $(cell).text().trim()).get();
      const label = cells[0]?.match(/^(.+?)\s*\(([A-Z]{3}|Euro)\)$/);
      if (locale === 'tr' && label?.[2] !== 'TRY') continue;
      if (!label || cells.length !== PLANS.length + 1) throw new Error(`无效 Apple 价格行: ${cells[0]}`);
      const name = label[1].replace(/[\d¹²³⁴⁵⁶⁷⁸⁹⁰𝄒?\s]+$/u, '');
      const iso = Object.hasOwn(regionCodes, name) ? regionCodes[name] : undefined;
      if (!iso || (locale === 'tr' && iso !== 'TR')) throw new Error(`未识别 Apple 地区: ${name}`);
      if (regions.has(iso)) throw new Error(`重复 Apple 地区: ${iso}`);
      const byPlan = new Map(planHeaders.map((plan, i) => [plan, parsePrice(cells[i + 1])]));
      const plans = PLANS.map(Name => ({ Name, Price: byPlan.get(Name) }));
      if (plans.some((plan, i) => i && plan.Price <= plans[i - 1].Price)) {
        throw new Error(`Apple 套餐价格顺序异常: ${name}`);
      }
      regions.set(iso, {
        CountryISO: iso,
        Country: ({ CN: 'China mainland', KR: 'South Korea', TR: 'Türkiye', EU: 'Euro area' })[iso] || name,
        Currency: label[2] === 'Euro' ? 'EUR' : label[2],
        Plans: plans
      });
    }
  });
  return regions;
}

function buildSnapshot(regions, fx, sources, now, previousRegions = []) {
  // Apple Support lists one EUR price row. Keep the existing DE / FR filters
  // on that schedule unless Apple begins listing a market separately.
  const euro = regions.get('EU');
  for (const [id, name] of [['DE', 'Germany'], ['FR', 'France']]) {
    if (euro && !regions.has(id)) regions.set(id, { ...euro, CountryISO: id, Country: name, PriceRegionISO: 'EU' });
  }
  const missing = [...new Set([...REQUIRED, ...previousRegions.map(r => r.CountryISO)])]
    .filter(id => !regions.has(id));
  if (regions.size < MIN_REGIONS || missing.length) {
    throw new Error(`Apple 地区覆盖不足：${regions.size} 行；缺少 ${missing.join(', ') || '其他地区'}。保留原快照。`);
  }
  const rates = fx.rates || {};
  const rateDate = new Date(fx.time_last_updated * 1000);
  if (fx.base !== 'USD' || rates.USD !== 1 || !Number.isFinite(+rateDate) ||
      +now - +rateDate > 7 * 86400000 || +rateDate - +now > 86400000) {
    throw new Error('汇率来源、基准或更新时间无效，保留原快照。');
  }
  for (const c of new Set(['CNY', ...[...regions.values()].map(r => r.Currency)])) {
    if (!Number.isFinite(rates[c]) || rates[c] <= 0) throw new Error(`缺少有效汇率: ${c}`);
  }
  return {
    lastUpdated: now.toISOString(),
    priceVerifiedAt: now.toISOString(),
    fxUpdatedAt: rateDate.toISOString(),
    source: 'Apple Support + ExchangeRate-API',
    appleSources: sources,
    regions: [...regions.values()].map(region => ({
      ...region,
      Plans: region.Plans.map(plan => ({
        ...plan,
        PriceInCNY: Math.round(plan.Price * rates.CNY / rates[region.Currency] * 100) / 100
      }))
    })).sort((a, b) => a.Plans[0].PriceInCNY - b.Plans[0].PriceInCNY ||
      a.CountryISO.localeCompare(b.CountryISO, 'en'))
  };
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

async function refresh({ read = fetchText, output = OUTPUT, dryRun = false, now = null } = {}) {
  let previous;
  try {
    previous = JSON.parse(await fs.readFile(output, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const [html, fxText] = await Promise.all([read(APPLE), read(FX)]);
  const regions = parseApplePricing(html);
  const sources = [APPLE];
  if (!regions.has('TR')) {
    const turkey = parseApplePricing(await read(APPLE_TR), 'tr').get('TR');
    if (turkey) {
      regions.set('TR', turkey);
      sources.push(APPLE_TR);
    }
  }
  const snapshot = buildSnapshot(regions, JSON.parse(fxText), sources, now || new Date(), previous?.regions);
  if (!dryRun) {
    const temp = `${output}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
      await fs.rename(temp, output);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  return snapshot;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  refresh({ dryRun }).then(snapshot => {
    console.log(`${dryRun ? '仅验证' : '已更新'} ${snapshot.regions.length} 个地区，汇率时间：${snapshot.fxUpdatedAt}`);
  }).catch(err => {
    console.error(`更新失败，未发布新快照：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parsePrice, parseApplePricing, buildSnapshot, refresh };
