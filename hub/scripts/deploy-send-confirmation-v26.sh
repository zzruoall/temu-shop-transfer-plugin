#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v25"
release="$base/releases/v26"
node="$base/runtime/bin/node"
# 只替换确认交互的静态资源；基线不一致即停止，保留现网其他修改。
test "$(readlink -f "$base/current")" = "$previous"
test ! -e "$release"
printf '%s  %s\n' \
f0885d58bcb294b053174cf0063f82eb1d2062b6555fb454b6cdb9284db88995 "$previous/hub/public/app.js" \
3d13417a0f5ee4631c1272be371df66b7fa46fefd67559949da359108983ae8d "$previous/hub/public/styles.css" | sha256sum -c -
mkdir "$release"
cp -a "$previous/hub" "$release/hub"
tar -xzf /tmp/temu-send-confirmation-v26.tar.gz -C "$release"
printf '%s  %s\n' \
1d76e765a68c9bd55c1a5058887add646510ea162976904f12bbfff9046a6304 "$release/hub/public/app.js" \
538972153b243caa121404a9aa1c71e1fdc425c53b868826af1ef52b78da917e "$release/hub/public/styles.css" | sha256sum -c -
chown -R root:temu-transfer "$release"
chmod 0750 "$release"
chmod 0640 "$release/hub/public/app.js" "$release/hub/public/styles.css"
"$node" --check "$release/hub/public/app.js"
ln -s "$release" "$base/current-send-confirmation-v26"
mv -Tf "$base/current-send-confirmation-v26" "$base/current"
# 失败仅回退代码，不改动 MySQL、商品、插件或任务记录。
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer || ! curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null; then
    ln -s "$previous" "$base/current-send-confirmation-rollback-v26"
    mv -Tf "$base/current-send-confirmation-rollback-v26" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
printf 'deployed=%s\n' "$release"
