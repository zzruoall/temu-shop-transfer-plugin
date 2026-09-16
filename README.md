# Temu 商品转移上架插件

- 当前版本：`10.10.42`
- 扩展 ID：`efojbbfhfniieifmppafmigfmndbledc`
- 用途：采集 Temu 店铺商品，通过中转仓下发到目标店铺并完成商品创建

## 仓库内容

- `plugin/`：Chrome Manifest V3 扩展源码
- `hub/`：店铺中转仓和商品队列服务源码
- `temu-shop-transfer-10.10.42.crx`：可供 Chrome/Edge 安装的最新版插件

## 安装插件

下载 `temu-shop-transfer-10.10.42.crx`，在 Chrome 或 Edge 的扩展管理页面开启“开发者模式”，然后将 CRX 文件拖入页面完成安装。

## 运行中转仓

中转仓需要 Node.js 18 或更高版本，并默认运行在 `http://127.0.0.1:18380`。

```powershell
cd hub
npm start
```

开发环境也可以将 `plugin/` 作为未打包扩展加载，便于查看实时修改。

## 数据与凭据

本仓库不包含服务器凭证、插件令牌、私钥、运行日志或商品业务数据。运行产生的 `hub/data/`、`plugin-tokens.json`、证书和本地环境配置均已被 `.gitignore` 排除，请在实际部署环境中单独配置。
