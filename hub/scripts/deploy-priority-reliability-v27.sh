#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v26"
release="$base/releases/v27"
node="$base/runtime/bin/node"
# 锁定四个文件的现网基线，不覆盖检查之后其他人发布的代码。
test "$(readlink -f "$base/current")" = "$previous"
test ! -e "$release"
printf '%s  %s\n' \
07e2fc7268936be878d6c3955d760c35e24679138c29f36a52854b66c5f6b2c5 "$previous/hub/lib/job-queue.mjs" \
8e78b06a4d7bc3b459c96156214f67f13b77698fccb7df6c703ae3d505a5856a "$previous/hub/lib/mysql-job-repository.mjs" \
b0e0e5a9eda1a1489b2bedd59b29d76af59a7fa7dac740bfec357fcf449d5de5 "$previous/hub/lib/store.mjs" \
1d76e765a68c9bd55c1a5058887add646510ea162976904f12bbfff9046a6304 "$previous/hub/public/app.js" | sha256sum -c -
mkdir "$release"
cp -a "$previous/hub" "$release/hub"
tar -xzf /tmp/temu-priority-reliability-v27.tar.gz -C "$release"
printf '%s  %s\n' \
a62ec2f3a0c865681c622bcf52da6421bafb711b61a8680e87c49020fbbb28f3 "$release/hub/lib/job-queue.mjs" \
2db5483cf3a04b66a998b9671c90fccb15552efd140c8f9f841f12e4e3c17dfd "$release/hub/lib/mysql-job-repository.mjs" \
ad81042651af7b743bd00f5e8f8feab63df47cebf6369568df61751ef186d310 "$release/hub/lib/store.mjs" \
5cb04d7ff39b7e69a46c99923c5aebef54374385f367bdf5f0461c96e8219681 "$release/hub/public/app.js" | sha256sum -c -
chown -R root:temu-transfer "$release"
chmod 0750 "$release"
for file in lib/job-queue.mjs lib/mysql-job-repository.mjs lib/store.mjs public/app.js; do
    chmod 0640 "$release/hub/$file"
    "$node" --check "$release/hub/$file"
done
ln -s "$release" "$base/current-reliability-v27"
mv -Tf "$base/current-reliability-v27" "$base/current"
# 失败只回退代码，不回滚 MySQL 中已经收到的任务和执行回执。
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer || ! curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null; then
    ln -s "$previous" "$base/current-reliability-rollback-v27"
    mv -Tf "$base/current-reliability-rollback-v27" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
printf 'deployed=%s\n' "$release"
