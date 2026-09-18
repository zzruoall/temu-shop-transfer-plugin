# 本机紫鸟工人

读取已打开的目标店后，由本机工人核验页面店名并检测 10.3.1 以上插件。人工上传任务的完整商品快照由目标店插件自己领取，工人不代领、不填写、不上传、不发布。

```powershell
cd worker
node .\worker.mjs
```

日常使用优先在 `hub` 目录执行 `npm run start:all`，它会同时启动中转仓和本工人，防止网页重启后在线店铺状态过期。

默认监听 `http://127.0.0.1:18380`。中转仓有令牌时设置 `SHOP_HUB_TOKEN`。允许的命令只有 `store list`、`store open`、`page visit`、`page content`。
本机访问中转仓时可不带令牌；紫鸟内插件仍必须带直推令牌。
