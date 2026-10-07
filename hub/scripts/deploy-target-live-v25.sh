#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v24"
release="$base/releases/v25"
node="$base/runtime/bin/node"
# 只发布目标店实时目录修复；校验基线，避免覆盖其他维护者刚发布的代码。
test "$(readlink -f "$base/current")" = "$previous"
printf '%s  %s\n' a7594b997020a0bb5412cfcf372b94592d49dd99749e9510b4e4037bf0f5be4a "$previous/hub/public/app.js" 419204f86181a65ddc09f434d9b4129f082624d6ad8e180636bdb60fb2fc22f6 "$previous/hub/lib/job-queue.mjs" | sha256sum -c -
test ! -e "$release"
mkdir "$release"
cp -a "$previous/hub" "$release/hub"
install -o root -g temu-transfer -m 0640 /tmp/temu-target-live-app-20260923.js "$release/hub/public/app.js"
install -o root -g temu-transfer -m 0640 /tmp/temu-target-live-queue-20260923.mjs "$release/hub/lib/job-queue.mjs"
chown root:temu-transfer "$release"
chmod 0750 "$release"
"$node" --check "$release/hub/public/app.js"
"$node" --check "$release/hub/lib/job-queue.mjs"
# 无数据库结构变化；只读启动检查通过后再切换，旧发布目录保留供代码回退。
cd "$release/hub"
runuser -u temu-transfer -- env TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json" TEMU_CREDENTIALS="$base/shared/credentials.json" ZINIAO_DATA_ROOT="$base/shared" TEMU_BASE_PATH=/temu "$node" scripts/smoke-mysql-release.mjs
ln -s "$release" "$base/current-v25"
mv -Tf "$base/current-v25" "$base/current"
systemctl restart temu-transfer
systemctl is-active temu-transfer
printf 'release=%s\n' "$release"
