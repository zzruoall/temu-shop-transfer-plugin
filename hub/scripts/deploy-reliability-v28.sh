#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v27"
release="$base/releases/v28"
node="$base/runtime/bin/node"
# 检查现网基线，避免覆盖其他发布；只叠加本轮修改，不同步本地数据与凭证。
test "$(readlink -f "$base/current")" = "$previous"
test ! -e "$release"
printf '%s  %s\n' \
a62ec2f3a0c865681c622bcf52da6421bafb711b61a8680e87c49020fbbb28f3 "$previous/hub/lib/job-queue.mjs" \
2db5483cf3a04b66a998b9671c90fccb15552efd140c8f9f841f12e4e3c17dfd "$previous/hub/lib/mysql-job-repository.mjs" \
ad81042651af7b743bd00f5e8f8feab63df47cebf6369568df61751ef186d310 "$previous/hub/lib/store.mjs" \
5cb04d7ff39b7e69a46c99923c5aebef54374385f367bdf5f0461c96e8219681 "$previous/hub/public/app.js" \
66cd8214b47861c568db41b49ca3c699e59dc63c8652e53feef9bbe779460261 "$previous/hub/server.mjs" \
c0ec85a7f122a36a7938d8d5e6889767f993df15065b6363f852d412fe95e5c4 "$previous/hub/lib/mysql-inventory.mjs" \
59fe82d324d0338515e705d776d1bb7bde026d7cc782ad6b28c38390abdf6d0d "$previous/hub/lib/mysql-schema.mjs" \
538972153b243caa121404a9aa1c71e1fdc425c53b868826af1ef52b78da917e "$previous/hub/public/styles.css" | sha256sum -c -
mkdir "$release"
cp -a "$previous/hub" "$release/hub"
tar -xzf /tmp/temu-reliability-v28.tar.gz -C "$release"
chown -R root:temu-transfer "$release"
find "$release" -type d -exec chmod 0750 {} +
find "$release" -type f -exec chmod 0640 {} +
for file in server.mjs lib/job-queue.mjs lib/mysql-job-repository.mjs lib/job-idempotency.mjs lib/bulk-dispatch.mjs lib/mysql-inventory.mjs lib/mysql-schema.mjs lib/store.mjs public/app.js; do
    "$node" --check "$release/hub/$file"
done
# DDL仅新增表，原有商品、回执、任务凭证不变；应用账号不需要新增DDL权限。
mysql temu_transfer_v24 < "$release/hub/scripts/bulk-schema-v28.sql"
export TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json"
export ZINIAO_DATA_ROOT="$base/shared"
export TEMU_CREDENTIALS="$base/shared/credentials.json"
cd "$release/hub"
"$node" scripts/smoke-mysql-release.mjs
"$node" scripts/repair-job-projections-v28.mjs
ln -s "$release" "$base/current-reliability-v28"
mv -Tf "$base/current-reliability-v28" "$base/current"
# 新版未接流量前失败则回退代码；数据库新增表保留，不回滚业务数据。
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer || ! curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null; then
    ln -s "$previous" "$base/current-reliability-rollback-v28"
    mv -Tf "$base/current-reliability-rollback-v28" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
# 重算历史投影不重排队、不重新发送；用服务账号保留现有文件权限边界。
sudo -u temu-transfer env TEMU_MYSQL_CONFIG="$TEMU_MYSQL_CONFIG" ZINIAO_DATA_ROOT="$ZINIAO_DATA_ROOT" "$node" scripts/repair-job-projections-v28.mjs --apply
printf 'deployed=%s\n' "$release"
