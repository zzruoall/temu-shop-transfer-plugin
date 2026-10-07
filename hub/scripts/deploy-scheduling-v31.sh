#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v30"
release="$base/releases/v31"
node="$base/runtime/bin/node"
# 在精确基线上增量发布；不覆盖共享资料、凭证或其他人部署的版本。
test "$(readlink -f "$base/current")" = "$previous"
test ! -e "$release"
cd "$previous/hub"
sha256sum -c <<'HASHES'
dcb45f2188de4b754813ed9945612741ac94a9ca1034428a2e70310026e46d4a  server.mjs
744778cfecde21135d8869833031da9ace5523adb04a9af52f05f15203c3cefc  cloud-auth.mjs
3b82abb69df57161332f5ce8382075c920bf25380b395cd9a265bd2d90e714e8  lib/bulk-dispatch.mjs
d548adc33fb3b34472f132260e5b6d859d284e467996db931adffb1d94b94050  lib/job-queue.mjs
13eefe6161e71da569b6af9bc8a12c2b4172958875e17c90e562fb82901d0d8e  lib/mysql-job-repository.mjs
f50f9a28188efcf1a83db0a79497dc3eee0f6f8293ed36089ad971f06229e99a  lib/mysql-database.mjs
8ab35cf977e1f960e0407c3acb9743b95a4a957dc3569bddddeac40fe345a0d4  lib/mysql-inventory.mjs
e810f698979b01e11522671490461c9d85a253960e7e023c527bca4b4e84dc9d  lib/mysql-schema.mjs
80b5274a7a1deaf0090af53594628e394175fcdbfc46d127ee47320c30c6afe9  lib/store.mjs
42a9bb66a422a7397b59f424fb77a059274d8f5f059d61db40e14b4b4640e0c3  lib/ingest-admission.mjs
HASHES
mkdir "$release"
cp -a "$previous/hub" "$release/hub"
tar -xzf /tmp/temu-scheduling-v31.tar.gz -C "$release"
chown -R root:temu-transfer "$release"
find "$release" -type d -exec chmod 0750 {} +
cd "$release/hub"
for file in server.mjs cloud-auth.mjs lib/bulk-dispatch.mjs lib/job-queue.mjs lib/mysql-job-repository.mjs lib/mysql-database.mjs lib/mysql-inventory.mjs lib/mysql-schema.mjs lib/store.mjs lib/ingest-admission.mjs lib/ingest-protocol.mjs lib/scheduling.mjs scripts/scheduling-schema-v31.mjs; do
    chmod 0640 "$file"
    "$node" --check "$file"
done
# 两张新表为兼容增量，旧版本不会误执行新版插件的扩展调度协议。
"$node" scripts/scheduling-schema-v31.mjs | mysql temu_transfer_v24
export TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json"
export ZINIAO_DATA_ROOT="$base/shared"
export TEMU_CREDENTIALS="$base/shared/credentials.json"
"$node" scripts/smoke-mysql-release.mjs
ln -s "$release" "$base/current-scheduling-v31"
mv -Tf "$base/current-scheduling-v31" "$base/current"
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer || ! curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null; then
    ln -s "$previous" "$base/current-scheduling-rollback-v31"
    mv -Tf "$base/current-scheduling-rollback-v31" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
printf 'deployed=%s\n' "$release"
