#!/usr/bin/env node
/**
 * iCloud+ 价格数据采集脚本
 * 从 Apple 官方支持页面爬取各地区价格，并转换为 CNY
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// 配置
const CONFIG = {
  appleURL: 'https://support.apple.com/en-us/108047',
  exchangeAPI: 'https://api.exchangerate-api.com/v4/latest/USD',
  outputPath: path.join(__dirname, '../data/prices.json'),
  timeout: 15000
};

// ISO 代码映射 (货币 -> 国家)
const CURRENCY_TO_ISO = {
  'USD': 'US', 'CAD': 'CA', 'MXN': 'MX', 'BRL': 'BR', 'CLP': 'CL',
  'COP': 'CO', 'PEN': 'PE', 'EUR': 'EU', 'GBP': 'GB', 'CHF': 'CH',
  'SEK': 'SE', 'NOK': 'NO', 'DKK': 'DK', 'PLN': 'PL', 'CZK': 'CZ',
  'HUF': 'HU', 'RON': 'RO', 'BGN': 'BG', 'HRK': 'HR', 'RUB': 'RU',
  'TRY': 'TR', 'ILS': 'IL', 'AED': 'AE', 'SAR': 'SA', 'ZAR': 'ZA',
  'EGP': 'EG', 'NGN': 'NG', 'KES': 'KE', 'AUD': 'AU', 'NZD': 'NZ',
  'JPY': 'JP', 'CNY': 'CN', 'HKD': 'HK', 'TWD': 'TW', 'KRW': 'KR',
  'SGD': 'SG', 'MYR': 'MY', 'THB': 'TH', 'IDR': 'ID', 'PHP': 'PH',
  'VND': 'VN', 'INR': 'IN', 'PKR': 'PK', 'BDT': 'BD', 'LKR': 'LK'
};

// 国家名称到 ISO 代码映射
const COUNTRY_TO_ISO = {
  'United States': 'US', 'Canada': 'CA', 'Mexico': 'MX', 'Brazil': 'BR',
  'Chile': 'CL', 'Colombia': 'CO', 'Peru': 'PE', 'Argentina': 'AR',
  'Bahamas': 'BS', 'Barbados': 'BB', 'Suriname': 'SR',
  'United Kingdom': 'GB', 'Germany': 'DE', 'France': 'FR', 'Italy': 'IT',
  'Spain': 'ES', 'Netherlands': 'NL', 'Belgium': 'BE', 'Austria': 'AT',
  'Switzerland': 'CH', 'Sweden': 'SE', 'Norway': 'NO', 'Denmark': 'DK',
  'Finland': 'FI', 'Ireland': 'IE', 'Portugal': 'PT', 'Poland': 'PL',
  'Czech Republic': 'CZ', 'Czechia': 'CZ', 'Hungary': 'HU', 'Romania': 'RO',
  'Bulgaria': 'BG', 'Croatia': 'HR', 'Greece': 'GR', 'Slovakia': 'SK',
  'Slovenia': 'SI', 'Estonia': 'EE', 'Latvia': 'LV', 'Lithuania': 'LT',
  'Luxembourg': 'LU', 'Malta': 'MT', 'Cyprus': 'CY', 'Iceland': 'IS',
  'Russia': 'RU', 'Ukraine': 'UA', 'Turkey': 'TR', 'Türkiye': 'TR',
  'Israel': 'IL', 'United Arab Emirates': 'AE', 'Saudi Arabia': 'SA',
  'Qatar': 'QA', 'Kuwait': 'KW', 'Bahrain': 'BH', 'Oman': 'OM',
  'South Africa': 'ZA', 'Egypt': 'EG', 'Nigeria': 'NG', 'Kenya': 'KE',
  'Morocco': 'MA', 'Tunisia': 'TN', 'Algeria': 'DZ',
  'Australia': 'AU', 'New Zealand': 'NZ', 'Japan': 'JP',
  'China': 'CN', 'China mainland': 'CN', 'Hong Kong': 'HK', 'Taiwan': 'TW',
  'South Korea': 'KR', 'Korea': 'KR', 'Singapore': 'SG', 'Malaysia': 'MY',
  'Thailand': 'TH', 'Indonesia': 'ID', 'Philippines': 'PH', 'Vietnam': 'VN',
  'India': 'IN', 'Pakistan': 'PK', 'Bangladesh': 'BD', 'Sri Lanka': 'LK',
  'Nepal': 'NP', 'Cambodia': 'KH', 'Laos': 'LA', 'Myanmar': 'MM'
};

/**
 * HTTPS GET 请求
 */
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: CONFIG.timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * 获取汇率数据
 */
async function getExchangeRates() {
  console.log('📊 获取汇率数据...');
  const data = await fetchURL(CONFIG.exchangeAPI);
  const json = JSON.parse(data);
  return json.rates;
}

/**
 * 解析价格字符串
 */
function parsePrice(priceStr) {
  // 移除货币符号和空格，处理各种格式
  const cleaned = priceStr
    .replace(/[^\d.,]/g, '')
    .replace(/,/g, '.');

  // 处理欧洲格式 (1.234,56 -> 1234.56)
  const parts = cleaned.split('.');
  if (parts.length > 2) {
    const last = parts.pop();
    return parseFloat(parts.join('') + '.' + last);
  }

  return parseFloat(cleaned);
}

/**
 * 从 HTML 解析价格数据
 */
async function parseApplePricing(html) {
  // 动态导入 cheerio
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);

  const regions = [];

  // Apple 支持页面的价格通常在特定结构中
  // 尝试多种选择器来匹配页面结构

  // 方法1: 查找包含价格的列表
  $('h3, h4, strong').each((_, header) => {
    const headerText = $(header).text().trim();

    // 匹配 "Country (CURRENCY)" 格式
    const countryMatch = headerText.match(/^(.+?)\s*\((\w{3})\)$/);
    if (!countryMatch) return;

    const [, countryName, currency] = countryMatch;
    const countryISO = COUNTRY_TO_ISO[countryName.trim()] || CURRENCY_TO_ISO[currency] || currency.substring(0, 2);

    // 查找后续的价格列表
    const priceList = $(header).next('ul, ol').find('li');
    if (priceList.length === 0) return;

    const plans = [];
    priceList.each((_, li) => {
      const text = $(li).text().trim();
      // 匹配 "50 GB: $0.99" 或 "50GB $0.99" 格式
      const planMatch = text.match(/(\d+)\s*(GB|TB)[:\s]+(.+)/i);
      if (planMatch) {
        const [, size, unit, priceStr] = planMatch;
        const name = `${size}${unit.toUpperCase()}`;
        const price = parsePrice(priceStr);
        if (!isNaN(price)) {
          plans.push({ Name: name, Price: price });
        }
      }
    });

    if (plans.length > 0) {
      regions.push({
        CountryISO: countryISO,
        Country: countryName.trim(),
        Currency: currency,
        Plans: plans
      });
    }
  });

  // 方法2: 如果上面没找到，尝试解析表格
  if (regions.length === 0) {
    $('table').each((_, table) => {
      $(table).find('tr').each((_, row) => {
        const cells = $(row).find('td, th');
        if (cells.length >= 2) {
          // 表格解析逻辑
        }
      });
    });
  }

  return regions;
}

/**
 * 备用：使用硬编码的价格数据
 * 当爬取失败时使用这些数据
 */
function getFallbackData() {
  return [
    { CountryISO: 'US', Country: 'United States', Currency: 'USD', Plans: [
      { Name: '50GB', Price: 0.99 }, { Name: '200GB', Price: 2.99 },
      { Name: '2TB', Price: 9.99 }, { Name: '6TB', Price: 29.99 }, { Name: '12TB', Price: 59.99 }
    ]},
    { CountryISO: 'CN', Country: 'China', Currency: 'CNY', Plans: [
      { Name: '50GB', Price: 6 }, { Name: '200GB', Price: 21 },
      { Name: '2TB', Price: 68 }, { Name: '6TB', Price: 198 }, { Name: '12TB', Price: 398 }
    ]},
    { CountryISO: 'JP', Country: 'Japan', Currency: 'JPY', Plans: [
      { Name: '50GB', Price: 150 }, { Name: '200GB', Price: 450 },
      { Name: '2TB', Price: 1500 }, { Name: '6TB', Price: 4500 }, { Name: '12TB', Price: 9000 }
    ]},
    { CountryISO: 'GB', Country: 'United Kingdom', Currency: 'GBP', Plans: [
      { Name: '50GB', Price: 0.99 }, { Name: '200GB', Price: 2.99 },
      { Name: '2TB', Price: 8.99 }, { Name: '6TB', Price: 26.99 }, { Name: '12TB', Price: 54.99 }
    ]},
    { CountryISO: 'DE', Country: 'Germany', Currency: 'EUR', Plans: [
      { Name: '50GB', Price: 0.99 }, { Name: '200GB', Price: 2.99 },
      { Name: '2TB', Price: 9.99 }, { Name: '6TB', Price: 29.99 }, { Name: '12TB', Price: 59.99 }
    ]},
    { CountryISO: 'FR', Country: 'France', Currency: 'EUR', Plans: [
      { Name: '50GB', Price: 0.99 }, { Name: '200GB', Price: 2.99 },
      { Name: '2TB', Price: 9.99 }, { Name: '6TB', Price: 29.99 }, { Name: '12TB', Price: 59.99 }
    ]},
    { CountryISO: 'AU', Country: 'Australia', Currency: 'AUD', Plans: [
      { Name: '50GB', Price: 1.49 }, { Name: '200GB', Price: 4.49 },
      { Name: '2TB', Price: 14.99 }, { Name: '6TB', Price: 44.99 }, { Name: '12TB', Price: 89.99 }
    ]},
    { CountryISO: 'CA', Country: 'Canada', Currency: 'CAD', Plans: [
      { Name: '50GB', Price: 1.29 }, { Name: '200GB', Price: 3.99 },
      { Name: '2TB', Price: 12.99 }, { Name: '6TB', Price: 39.99 }, { Name: '12TB', Price: 79.99 }
    ]},
    { CountryISO: 'KR', Country: 'South Korea', Currency: 'KRW', Plans: [
      { Name: '50GB', Price: 1100 }, { Name: '200GB', Price: 3300 },
      { Name: '2TB', Price: 11000 }, { Name: '6TB', Price: 33000 }, { Name: '12TB', Price: 66000 }
    ]},
    { CountryISO: 'HK', Country: 'Hong Kong', Currency: 'HKD', Plans: [
      { Name: '50GB', Price: 8 }, { Name: '200GB', Price: 23 },
      { Name: '2TB', Price: 78 }, { Name: '6TB', Price: 233 }, { Name: '12TB', Price: 468 }
    ]},
    { CountryISO: 'TW', Country: 'Taiwan', Currency: 'TWD', Plans: [
      { Name: '50GB', Price: 30 }, { Name: '200GB', Price: 90 },
      { Name: '2TB', Price: 300 }, { Name: '6TB', Price: 900 }, { Name: '12TB', Price: 1800 }
    ]},
    { CountryISO: 'SG', Country: 'Singapore', Currency: 'SGD', Plans: [
      { Name: '50GB', Price: 1.28 }, { Name: '200GB', Price: 3.98 },
      { Name: '2TB', Price: 12.98 }, { Name: '6TB', Price: 38.98 }, { Name: '12TB', Price: 78.98 }
    ]},
    { CountryISO: 'IN', Country: 'India', Currency: 'INR', Plans: [
      { Name: '50GB', Price: 75 }, { Name: '200GB', Price: 219 },
      { Name: '2TB', Price: 749 }, { Name: '6TB', Price: 2249 }, { Name: '12TB', Price: 4499 }
    ]},
    { CountryISO: 'RU', Country: 'Russia', Currency: 'RUB', Plans: [
      { Name: '50GB', Price: 59 }, { Name: '200GB', Price: 149 },
      { Name: '2TB', Price: 599 }, { Name: '6TB', Price: 1790 }, { Name: '12TB', Price: 3590 }
    ]},
    { CountryISO: 'TR', Country: 'Turkey', Currency: 'TRY', Plans: [
      { Name: '50GB', Price: 14.99 }, { Name: '200GB', Price: 44.99 },
      { Name: '2TB', Price: 149.99 }, { Name: '6TB', Price: 449.99 }, { Name: '12TB', Price: 899.99 }
    ]},
    { CountryISO: 'BR', Country: 'Brazil', Currency: 'BRL', Plans: [
      { Name: '50GB', Price: 3.50 }, { Name: '200GB', Price: 10.90 },
      { Name: '2TB', Price: 34.90 }, { Name: '6TB', Price: 104.90 }, { Name: '12TB', Price: 209.90 }
    ]},
    { CountryISO: 'MX', Country: 'Mexico', Currency: 'MXN', Plans: [
      { Name: '50GB', Price: 17 }, { Name: '200GB', Price: 49 },
      { Name: '2TB', Price: 179 }, { Name: '6TB', Price: 529 }, { Name: '12TB', Price: 1049 }
    ]},
    { CountryISO: 'ID', Country: 'Indonesia', Currency: 'IDR', Plans: [
      { Name: '50GB', Price: 15000 }, { Name: '200GB', Price: 45000 },
      { Name: '2TB', Price: 149000 }, { Name: '6TB', Price: 449000 }, { Name: '12TB', Price: 899000 }
    ]},
    { CountryISO: 'TH', Country: 'Thailand', Currency: 'THB', Plans: [
      { Name: '50GB', Price: 35 }, { Name: '200GB', Price: 99 },
      { Name: '2TB', Price: 349 }, { Name: '6TB', Price: 1049 }, { Name: '12TB', Price: 2099 }
    ]},
    { CountryISO: 'MY', Country: 'Malaysia', Currency: 'MYR', Plans: [
      { Name: '50GB', Price: 3.90 }, { Name: '200GB', Price: 11.90 },
      { Name: '2TB', Price: 39.90 }, { Name: '6TB', Price: 119.90 }, { Name: '12TB', Price: 239.90 }
    ]},
    { CountryISO: 'PH', Country: 'Philippines', Currency: 'PHP', Plans: [
      { Name: '50GB', Price: 49 }, { Name: '200GB', Price: 149 },
      { Name: '2TB', Price: 499 }, { Name: '6TB', Price: 1490 }, { Name: '12TB', Price: 2990 }
    ]},
    { CountryISO: 'VN', Country: 'Vietnam', Currency: 'VND', Plans: [
      { Name: '50GB', Price: 19000 }, { Name: '200GB', Price: 59000 },
      { Name: '2TB', Price: 199000 }, { Name: '6TB', Price: 599000 }, { Name: '12TB', Price: 1190000 }
    ]},
    { CountryISO: 'AE', Country: 'United Arab Emirates', Currency: 'AED', Plans: [
      { Name: '50GB', Price: 3.99 }, { Name: '200GB', Price: 10.99 },
      { Name: '2TB', Price: 36.99 }, { Name: '6TB', Price: 109.99 }, { Name: '12TB', Price: 219.99 }
    ]},
    { CountryISO: 'SA', Country: 'Saudi Arabia', Currency: 'SAR', Plans: [
      { Name: '50GB', Price: 3.99 }, { Name: '200GB', Price: 10.99 },
      { Name: '2TB', Price: 36.99 }, { Name: '6TB', Price: 109.99 }, { Name: '12TB', Price: 219.99 }
    ]},
    { CountryISO: 'ZA', Country: 'South Africa', Currency: 'ZAR', Plans: [
      { Name: '50GB', Price: 14.99 }, { Name: '200GB', Price: 44.99 },
      { Name: '2TB', Price: 149.99 }, { Name: '6TB', Price: 449.99 }, { Name: '12TB', Price: 899.99 }
    ]},
    { CountryISO: 'IL', Country: 'Israel', Currency: 'ILS', Plans: [
      { Name: '50GB', Price: 3.90 }, { Name: '200GB', Price: 10.90 },
      { Name: '2TB', Price: 34.90 }, { Name: '6TB', Price: 109.90 }, { Name: '12TB', Price: 219.90 }
    ]},
    { CountryISO: 'PL', Country: 'Poland', Currency: 'PLN', Plans: [
      { Name: '50GB', Price: 3.99 }, { Name: '200GB', Price: 11.99 },
      { Name: '2TB', Price: 39.99 }, { Name: '6TB', Price: 119.99 }, { Name: '12TB', Price: 239.99 }
    ]},
    { CountryISO: 'SE', Country: 'Sweden', Currency: 'SEK', Plans: [
      { Name: '50GB', Price: 9 }, { Name: '200GB', Price: 29 },
      { Name: '2TB', Price: 99 }, { Name: '6TB', Price: 299 }, { Name: '12TB', Price: 599 }
    ]},
    { CountryISO: 'NO', Country: 'Norway', Currency: 'NOK', Plans: [
      { Name: '50GB', Price: 12 }, { Name: '200GB', Price: 35 },
      { Name: '2TB', Price: 119 }, { Name: '6TB', Price: 355 }, { Name: '12TB', Price: 709 }
    ]},
    { CountryISO: 'DK', Country: 'Denmark', Currency: 'DKK', Plans: [
      { Name: '50GB', Price: 7 }, { Name: '200GB', Price: 19 },
      { Name: '2TB', Price: 69 }, { Name: '6TB', Price: 199 }, { Name: '12TB', Price: 399 }
    ]},
    { CountryISO: 'CH', Country: 'Switzerland', Currency: 'CHF', Plans: [
      { Name: '50GB', Price: 1 }, { Name: '200GB', Price: 3 },
      { Name: '2TB', Price: 10 }, { Name: '6TB', Price: 30 }, { Name: '12TB', Price: 60 }
    ]},
    { CountryISO: 'NZ', Country: 'New Zealand', Currency: 'NZD', Plans: [
      { Name: '50GB', Price: 1.69 }, { Name: '200GB', Price: 4.99 },
      { Name: '2TB', Price: 16.99 }, { Name: '6TB', Price: 49.99 }, { Name: '12TB', Price: 99.99 }
    ]},
    { CountryISO: 'CL', Country: 'Chile', Currency: 'CLP', Plans: [
      { Name: '50GB', Price: 800 }, { Name: '200GB', Price: 2500 },
      { Name: '2TB', Price: 7900 }, { Name: '6TB', Price: 23900 }, { Name: '12TB', Price: 47900 }
    ]},
    { CountryISO: 'CO', Country: 'Colombia', Currency: 'COP', Plans: [
      { Name: '50GB', Price: 3400 }, { Name: '200GB', Price: 10900 },
      { Name: '2TB', Price: 34900 }, { Name: '6TB', Price: 104900 }, { Name: '12TB', Price: 209900 }
    ]},
    { CountryISO: 'PE', Country: 'Peru', Currency: 'PEN', Plans: [
      { Name: '50GB', Price: 2.90 }, { Name: '200GB', Price: 9.90 },
      { Name: '2TB', Price: 34.90 }, { Name: '6TB', Price: 99.90 }, { Name: '12TB', Price: 199.90 }
    ]},
    { CountryISO: 'EG', Country: 'Egypt', Currency: 'EGP', Plans: [
      { Name: '50GB', Price: 24.99 }, { Name: '200GB', Price: 74.99 },
      { Name: '2TB', Price: 249.99 }, { Name: '6TB', Price: 749.99 }, { Name: '12TB', Price: 1499.99 }
    ]},
    { CountryISO: 'NG', Country: 'Nigeria', Currency: 'NGN', Plans: [
      { Name: '50GB', Price: 900 }, { Name: '200GB', Price: 2900 },
      { Name: '2TB', Price: 9900 }, { Name: '6TB', Price: 29900 }, { Name: '12TB', Price: 59900 }
    ]},
    { CountryISO: 'PK', Country: 'Pakistan', Currency: 'PKR', Plans: [
      { Name: '50GB', Price: 200 }, { Name: '200GB', Price: 600 },
      { Name: '2TB', Price: 2000 }, { Name: '6TB', Price: 6000 }, { Name: '12TB', Price: 12000 }
    ]}
  ];
}

/**
 * 将价格转换为 CNY
 */
function convertToCNY(price, currency, rates) {
  if (currency === 'CNY') return price;

  // 先转换为 USD，再转换为 CNY
  const usdRate = rates[currency];
  const cnyRate = rates['CNY'];

  if (!usdRate || !cnyRate) {
    console.warn(`⚠️ 未找到汇率: ${currency}`);
    return price; // 返回原价
  }

  // API 返回的是 1 USD = X Currency 的汇率
  const priceInUSD = price / usdRate;
  return priceInUSD * cnyRate;
}

/**
 * 主函数
 */
async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('🚀 开始获取 iCloud+ 价格数据...\n');

  try {
    // 获取汇率
    const rates = await getExchangeRates();
    console.log(`✅ 汇率获取成功 (1 USD = ${rates.CNY.toFixed(4)} CNY)\n`);

    // 获取价格数据
    let regions;
    try {
      console.log('📄 获取 Apple 支持页面...');
      const html = await fetchURL(CONFIG.appleURL);
      regions = await parseApplePricing(html);

      if (regions.length === 0) {
        console.log('⚠️ 页面解析结果为空，使用备用数据');
        regions = getFallbackData();
      } else {
        console.log(`✅ 解析到 ${regions.length} 个地区的价格数据\n`);
      }
    } catch (err) {
      console.log(`⚠️ 页面获取失败: ${err.message}，使用备用数据`);
      regions = getFallbackData();
    }

    // 转换为 CNY
    const result = {
      lastUpdated: new Date().toISOString(),
      source: 'Apple Support + ExchangeRate-API',
      regions: regions.map(region => ({
        ...region,
        Plans: region.Plans.map(plan => ({
          ...plan,
          PriceInCNY: Math.round(convertToCNY(plan.Price, region.Currency, rates) * 100) / 100
        }))
      }))
    };

    // 按 50GB 价格排序
    result.regions.sort((a, b) => {
      const priceA = a.Plans.find(p => p.Name === '50GB')?.PriceInCNY || Infinity;
      const priceB = b.Plans.find(p => p.Name === '50GB')?.PriceInCNY || Infinity;
      return priceA - priceB;
    });

    if (isDryRun) {
      console.log('📋 Dry run 模式，输出数据预览:\n');
      console.log(JSON.stringify(result, null, 2).substring(0, 2000) + '...\n');
      console.log(`共 ${result.regions.length} 个地区`);
    } else {
      // 确保目录存在
      const dir = path.dirname(CONFIG.outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 写入文件
      fs.writeFileSync(CONFIG.outputPath, JSON.stringify(result, null, 2));
      console.log(`✅ 数据已保存到: ${CONFIG.outputPath}`);
      console.log(`📊 共 ${result.regions.length} 个地区的价格数据`);
    }

  } catch (err) {
    console.error('❌ 错误:', err.message);
    process.exit(1);
  }
}

main();
