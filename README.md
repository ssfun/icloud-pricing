# iCloud+ 地区价格对比

采集 Apple 官方支持页的 50 GB、200 GB、2 TB、6 TB、12 TB 月费，并按 ExchangeRate-API 的 USD 基准汇率换算成人民币。换算值用于比较，不代表实际结算价。德国和法国沿用 Apple 的欧元区价格表，以保留现有地区筛选。

## 更新与校验

需要 Node.js 20.18.1 或更高版本。

```sh
npm ci
npm test
npm run fetch -- --dry-run  # 在线验证，但不更新快照
npm run fetch              # 更新 data/prices.json
```

GitHub Actions 每周一 UTC 00:00 更新；主分支也支持手动触发。Apple 页面解析失败、缺少既有地区、价格列异常或汇率不可用时，任务失败并保留原文件。新出现的 Apple 地区名称须先核对并录入 `data/apple-region-codes.json`，不按货币猜测地区。

- `priceVerifiedAt`：从 Apple 成功核对价目表的时间。
- `fxUpdatedAt`：汇率提供方的更新时间。
- `lastUpdated`：快照生成时间，保留给旧客户端。

## Alfred

`scripts/icloud.js` 是 macOS JXA Script Filter。把脚本和 `data/prices.json` 放入工作流的对应目录。脚本每小时尝试更新价格；离线时优先使用最近核对过的本地快照。旧版未经核对的数据会单独标注。已经安装的工作流需要更新其脚本才能使用这个刷新策略。
