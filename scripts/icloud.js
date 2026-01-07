#!/usr/bin/osascript -l JavaScript
/**
 * iCloud+ Pricing Comparison - Alfred Workflow
 * 使用 JXA (JavaScript for Automation) 实现
 */

// ObjC 桥接
ObjC.import('Foundation');

/**
 * 配置
 */
const CONFIG = {
  // 数据源 URL (部署到 GitHub Pages 后替换)
  dataURL: 'https://raw.githubusercontent.com/YOUR_USERNAME/icloud-pricing/main/data/prices.json',
  // 本地数据备份路径
  localDataPath: './data/prices.json',
  // 缓存有效期 (毫秒)
  cacheTTL: 3600 * 1000,
  // 请求超时 (秒)
  timeout: 5
};

/**
 * 套餐类型
 */
const PLAN_TYPES = ['50gb', '200gb', '2tb', '6tb', '12tb'];

/**
 * 获取国旗 emoji
 */
function getFlag(iso) {
  return iso.toUpperCase().split('').map(function(c) {
    return String.fromCodePoint(c.charCodeAt(0) + 127397);
  }).join('');
}

/**
 * 获取缓存目录
 */
function getCacheDir() {
  var env = $.NSProcessInfo.processInfo.environment;
  var cacheDir = env.objectForKey('alfred_workflow_cache');
  if (cacheDir && cacheDir.js) {
    return cacheDir.js;
  }
  // 备用缓存目录
  return $.NSTemporaryDirectory().js + 'icloud-pricing';
}

/**
 * 获取工作流目录
 */
function getWorkflowDir() {
  var env = $.NSProcessInfo.processInfo.environment;
  // 首先尝试 alfred_preferences (Alfred workflow 目录)
  var alfredPrefs = env.objectForKey('alfred_preferences');
  var workflowUid = env.objectForKey('alfred_workflow_uid');
  if (alfredPrefs && alfredPrefs.js && workflowUid && workflowUid.js) {
    return alfredPrefs.js + '/workflows/' + workflowUid.js;
  }
  // 备用: 使用脚本所在目录的父目录
  var args = $.NSProcessInfo.processInfo.arguments;
  if (args.count > 1) {
    var scriptPath = ObjC.unwrap(args.objectAtIndex(1));
    if (scriptPath && scriptPath.indexOf('/scripts/') !== -1) {
      return scriptPath.replace(/\/scripts\/[^\/]+$/, '');
    }
  }
  // 最后备用: 当前工作目录
  return ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
}

/**
 * 确保目录存在
 */
function ensureDir(path) {
  var fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(path)) {
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
      path, true, $(), $()
    );
  }
}

/**
 * 读取文件
 */
function readFile(path) {
  var fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(path)) {
    return null;
  }
  var content = $.NSString.stringWithContentsOfFileEncodingError(
    path, $.NSUTF8StringEncoding, $()
  );
  return content ? content.js : null;
}

/**
 * 写入文件
 */
function writeFile(path, content) {
  var nsString = $.NSString.alloc.initWithUTF8String(content);
  nsString.writeToFileAtomicallyEncodingError(
    path, true, $.NSUTF8StringEncoding, $()
  );
}

/**
 * 获取文件修改时间
 */
function getFileMtime(path) {
  var fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(path)) return 0;
  try {
    var attrs = ObjC.unwrap(fm.attributesOfItemAtPathError(path, $()));
    if (!attrs) return 0;
    var mdate = attrs['NSFileModificationDate'];
    return mdate ? mdate.timeIntervalSince1970 * 1000 : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 使用 curl 获取远程数据
 */
function fetchRemote(url) {
  var task = $.NSTask.alloc.init;
  task.launchPath = '/usr/bin/curl';
  task.arguments = $(['-s', '-m', String(CONFIG.timeout), '-L', url]);

  var pipe = $.NSPipe.pipe;
  task.standardOutput = pipe;
  task.standardError = $.NSPipe.pipe;

  task.launch;
  task.waitUntilExit;

  if (task.terminationStatus !== 0) {
    return null;
  }

  var data = pipe.fileHandleForReading.readDataToEndOfFile;
  var output = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return output ? output.js : null;
}

/**
 * 获取价格数据 (带缓存)
 */
function getPriceData() {
  var cacheDir = getCacheDir();
  var cachePath = cacheDir + '/prices.json';

  ensureDir(cacheDir);

  // 检查缓存
  var now = Date.now();
  var mtime = getFileMtime(cachePath);
  if (mtime && (now - mtime) < CONFIG.cacheTTL) {
    var cached = readFile(cachePath);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // 缓存损坏，继续获取新数据
      }
    }
  }

  // 优先尝试读取本地数据文件 (workflow 自带的数据)
  var workflowDir = getWorkflowDir();
  var localPath = workflowDir + '/data/prices.json';
  var local = readFile(localPath);
  if (local) {
    try {
      var localData = JSON.parse(local);
      // 将本地数据写入缓存
      writeFile(cachePath, local);
      return localData;
    } catch (e) {
      // 解析失败，继续尝试远程
    }
  }

  // 尝试从远程获取
  var remote = fetchRemote(CONFIG.dataURL);
  if (remote) {
    try {
      var data = JSON.parse(remote);
      writeFile(cachePath, remote);
      return data;
    } catch (e) {
      // 解析失败
    }
  }

  // 尝试读取过期缓存
  var expiredCache = readFile(cachePath);
  if (expiredCache) {
    try {
      return JSON.parse(expiredCache);
    } catch (e) {}
  }

  return null;
}

/**
 * 过滤地区
 */
function filterRegions(regions, query) {
  if (!query) return regions;
  query = query.toUpperCase();
  return regions.filter(function(r) {
    return r.CountryISO.toUpperCase().indexOf(query) !== -1 ||
           r.Country.toUpperCase().indexOf(query) !== -1;
  });
}

/**
 * 按 CNY 价格排序
 */
function sortByPrice(regions, planName) {
  return regions.slice().sort(function(a, b) {
    var planA = a.Plans.find(function(p) { return p.Name === planName; });
    var planB = b.Plans.find(function(p) { return p.Name === planName; });
    var priceA = planA ? planA.PriceInCNY : Infinity;
    var priceB = planB ? planB.PriceInCNY : Infinity;
    return priceA - priceB;
  });
}

/**
 * 生成 Alfred 输出项
 */
function createItem(region, plan, planName, rank) {
  var flag = getFlag(region.CountryISO);
  var priceStr = plan.Price % 1 === 0 ? plan.Price.toString() : plan.Price.toFixed(2);
  var cnyStr = plan.PriceInCNY.toFixed(2);

  return {
    uid: region.CountryISO + '-' + planName,
    title: flag + ' ' + region.Country + ' | ' + priceStr + ' ' + region.Currency + ' ≈ ¥' + cnyStr,
    subtitle: '#' + rank + ' | ' + planName + ' 套餐',
    arg: '¥' + cnyStr,
    icon: { path: 'icon.png' },
    mods: {
      cmd: {
        valid: true,
        arg: priceStr + ' ' + region.Currency,
        subtitle: '⌘ 复制原始价格'
      },
      alt: {
        valid: true,
        arg: 'https://support.apple.com/zh-cn/108047',
        subtitle: '⌥ 打开 Apple 支持页面'
      }
    },
    text: {
      copy: '¥' + cnyStr,
      largetype: flag + ' ' + region.Country + '\n' + planName + ': ' + priceStr + ' ' + region.Currency + ' ≈ ¥' + cnyStr
    }
  };
}

/**
 * 生成错误输出
 */
function errorOutput(message) {
  return JSON.stringify({
    items: [{
      title: '获取数据失败',
      subtitle: message,
      valid: false,
      icon: { path: 'icon.png' }
    }]
  });
}

/**
 * 生成帮助输出
 */
function helpOutput() {
  return JSON.stringify({
    items: [
      {
        title: '用法: icloud [套餐] [地区]',
        subtitle: '套餐: 50gb, 200gb, 2tb, 6tb, 12tb | 地区: 国家代码或名称',
        valid: false,
        icon: { path: 'icon.png' }
      },
      {
        title: '示例: icloud 2tb',
        subtitle: '查看所有地区 2TB 套餐价格排名',
        valid: false,
        icon: { path: 'icon.png' }
      },
      {
        title: '示例: icloud us',
        subtitle: '查看美国所有套餐价格',
        valid: false,
        icon: { path: 'icon.png' }
      },
      {
        title: '示例: icloud 50gb jp',
        subtitle: '查看日本 50GB 套餐价格',
        valid: false,
        icon: { path: 'icon.png' }
      }
    ]
  });
}

/**
 * 主函数
 */
function run(argv) {
  var query = argv.join(' ').toLowerCase().trim();

  // 显示帮助
  if (query === 'help' || query === '?') {
    return helpOutput();
  }

  // 解析查询参数
  var parts = query.split(/\s+/).filter(function(p) { return p.length > 0; });
  var selectedPlan = null;
  var searchQuery = null;

  parts.forEach(function(part) {
    if (PLAN_TYPES.indexOf(part) !== -1) {
      selectedPlan = part.toUpperCase();
    } else if (part.length >= 2) {
      searchQuery = part;
    }
  });

  // 默认套餐
  if (!selectedPlan) {
    selectedPlan = '50GB';
  }

  // 获取数据
  var data = getPriceData();
  if (!data || !data.regions || data.regions.length === 0) {
    return errorOutput('无法加载价格数据');
  }

  var regions = data.regions;

  // 过滤地区
  var filtered = filterRegions(regions, searchQuery);

  if (filtered.length === 0) {
    return JSON.stringify({
      items: [{
        title: '未找到匹配的地区',
        subtitle: '尝试使用其他关键词，如 US, JP, CN',
        valid: false,
        icon: { path: 'icon.png' }
      }]
    });
  }

  // 根据场景决定显示方式
  var items = [];

  if (searchQuery && filtered.length === 1) {
    // 精确匹配单个地区时，显示所有套餐
    var region = filtered[0];
    region.Plans.forEach(function(plan) {
      items.push(createItem(region, plan, plan.Name, '-'));
    });
  } else {
    // 显示选定套餐的排名
    var sorted = sortByPrice(filtered, selectedPlan);
    sorted.forEach(function(region, idx) {
      var plan = region.Plans.find(function(p) { return p.Name === selectedPlan; });
      if (plan) {
        items.push(createItem(region, plan, selectedPlan, idx + 1));
      }
    });
  }

  // 添加更新时间信息
  if (data.lastUpdated) {
    var updateDate = new Date(data.lastUpdated);
    var dateStr = updateDate.toLocaleDateString('zh-CN');
    items.push({
      title: '数据更新时间: ' + dateStr,
      subtitle: '按 ⌥ + Enter 查看 Apple 官方页面',
      valid: false,
      icon: { path: 'icon.png' },
      mods: {
        alt: {
          valid: true,
          arg: 'https://support.apple.com/zh-cn/108047',
          subtitle: '⌥ 打开 Apple 支持页面'
        }
      }
    });
  }

  return JSON.stringify({ items: items });
}
