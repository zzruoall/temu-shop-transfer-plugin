# Temu 商品转移上架插件

- 网站服务版本：`v37`（2026-09-29 线上快照）
- 插件版本：`10.10.68`
- 版本以 `plugin/manifest.json` 为准；插件包内 README 顶部仍为历史文案 `10.10.65`，为保留已发布包的原始哈希，本次未改写包内文件。
- 扩展 ID：`efojbbfhfniieifmppafmigfmndbledc`
- 用途：采集 Temu 店铺商品，通过中转仓下发到目标店铺并完成商品创建

## 仓库内容

- `plugin/`：Chrome Manifest V3 扩展源码
- `hub/`：店铺中转仓和商品队列服务源码
- `worker/`：本机紫鸟工人，用于核验目标店页面身份与插件状态
- `hub/public/downloads/temu-transfer-plugin-10.10.68.crx`：当前已签名插件
- `hub/public/downloads/temu-transfer-plugin-10.10.68.zip`：同版本插件源码安装包
- `docs/release-v37.md`：版本边界、弹性调度配置和验证说明
- 根目录的 `temu-shop-transfer-10.10.47.crx` 是历史文件，不是当前版本

## 安装插件

下载 [10.10.68 CRX](hub/public/downloads/temu-transfer-plugin-10.10.68.crx) 或 [10.10.68 ZIP](hub/public/downloads/temu-transfer-plugin-10.10.68.zip)。在 Chrome 或 Edge 的扩展管理页面开启“开发者模式”，将 CRX 文件拖入页面；浏览器不允许直接安装时，解压 ZIP 并选择“加载已解压的扩展程序”。

## 运行中转仓

建议使用 Node.js 22 或更高版本。默认本地调试地址为 `http://127.0.0.1:18380`；生产账户执行与弹性调度需要 MySQL 8.x 和可读取服务 cgroup 限额的 Linux 环境。

```powershell
cd hub
npm ci
npm start
```

开发环境也可以将 `plugin/` 作为未打包扩展加载，便于查看实时修改。

默认启动不等于启用生产弹性调度。数据库必须先完成迁移，凭证及数据目录由部署环境单独配置；不要直接在有在途任务的生产库运行迁移。详见 [v37 发布说明](docs/release-v37.md)。

插件的 `direct-adapter.js` 是 `worker/direct-create-prepare.js` 与 `worker/direct-integrity.js` 的构建产物，
修改这两个源文件后需在 `plugin/` 目录执行 `node build-direct-adapter.mjs` 重新生成，不要直接改产物。

## 校验

```powershell
cd hub
npm run verify
```

覆盖入库解析、任务队列、提交与回查、用户隔离、分页及资源预算等规则。弹性专项可运行 `node scripts/verify-elastic-allocation.mjs` 和 `node scripts/verify-elastic-ingest.mjs`；真实数据库专项需要隔离测试 MySQL，不应使用生产库。

## 判定责任边界

- **能否创建由目标店平台判定**：插件不再用本地规则预判“目标店要哪些必填项”。本地模板规则一旦比平台严，就会造出平台上并不存在的失败，因此缺少必填项等只记为备注，由平台返回的错误作为真实原因。
- **传输完整性不等于固定商品模板校验**：核对来源数据的传输及身份，不把所有商品强行套入同一结构。
- **单次人工点击的重复传输与重新提交分开处理**：同次投递应避免重复接收；人工重新点击产生新操作。未知平台结果必须保留证据，不能当作明确未提交后无限重投。
- **标红可人工解除**：商品库支持按标红状态筛选，也可对选中的标红商品执行“解除标红”。

## 数据与凭据

本次同步不包含服务器凭证、插件令牌、私钥、运行日志或生产数据库。原仓库已有 `hub/fixtures/` 测试样本，本次未新增或替换这些样本。运行产生的 `hub/data/`、`plugin-tokens.json`、证书和本地环境配置均应留在部署环境，禁止提交。
