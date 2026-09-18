@echo off
cd /d "%~dp0"
echo 本机工人打开目标店后代领核验，不填写、不发布。
echo 默认监听 http://127.0.0.1:18380
echo 如中转仓有令牌，先设置 SHOP_HUB_TOKEN。
node worker.mjs
pause
