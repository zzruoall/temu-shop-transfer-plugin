#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v24"
release="$base/releases/v25"
node="$base/runtime/bin/node"
# 基线逐文件锁定，避免覆盖其他维护者在检查后发布的改动。
test "$(readlink -f "$base/current")" = "$previous"
printf '%s  %s\n' \
1bb47250aed6952053b14358252fe6bb1567f0516d57a825bdf83210495d3d4b "$previous/hub/server.mjs" \
ce2a9a6bf8228c000d4cac5b154ef4f58683eaabc9c3821c8a63c952ca2c338f "$previous/hub/public/app.js" \
b7199de35c1bc6287409978612ec3bd9fa7271f50219c0d7b9c19f5fe8cc2f05 "$previous/hub/lib/job-queue.mjs" \
d84871c00c8945b772c8e5ff37e7fd10e100cdf4489286d3cb7070687454cd11 "$previous/hub/lib/store.mjs" \
5f250d4ab3687dcf77b89e402d5be9a02c6890fa8156eae898b52f3492318b5f "$previous/hub/lib/mysql-inventory.mjs" \
1e39f1aa82c398f4375f582450af3e36ac82e554f6a1072df13ad7388b18da15 "$previous/hub/lib/parse-capture.mjs" | sha256sum -c -
if test ! -e "$release"; then
    mkdir "$release"
    cp -a "$previous/hub" "$release/hub"
else
    # 仅复用本次校验中止后留下、从未接流量的候选；现网基线仍须先全部通过。
    test -f "$release/hub/lib/transfer-integrity.mjs"
fi
tar -xzf /tmp/temu-integrity-v25.tar.gz -C "$release"
chown -R root:temu-transfer "$release"
chmod 0750 "$release"
for file in server.mjs public/app.js lib/job-queue.mjs lib/store.mjs lib/mysql-inventory.mjs lib/parse-capture.mjs lib/transfer-integrity.mjs scripts/verify-stored-transfer-readonly.mjs; do
    chmod 0640 "$release/hub/$file"
    "$node" --check "$release/hub/$file"
done
cd "$release/hub"
# 无数据库迁移；原商品只读核验及随机回环端口检查通过后才切换网站进程。
runuser -u temu-transfer -- env TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json" ZINIAO_DATA_ROOT="$base/shared" "$node" scripts/verify-stored-transfer-readonly.mjs cc080f7e
runuser -u temu-transfer -- env TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json" TEMU_CREDENTIALS="$base/shared/credentials.json" ZINIAO_DATA_ROOT="$base/shared" TEMU_BASE_PATH=/temu "$node" scripts/smoke-mysql-release.mjs
ln -s "$release" "$base/current-integrity-v25"
mv -Tf "$base/current-integrity-v25" "$base/current"
# 重启失败只回退代码链接，不切回旧 JSON，也不回滚正在使用的 MySQL 数据。
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer; then
    ln -s "$previous" "$base/current-integrity-rollback"
    mv -Tf "$base/current-integrity-rollback" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
printf 'deployed=%s\n' "$release"
