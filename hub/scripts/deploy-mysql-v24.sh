#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
stage=/tmp/temu-mysql.hckqH8
release="$base/releases/v24"
shared="$base/shared"
node="$base/runtime/bin/node"
export PATH="$base/runtime/bin:$PATH"

# 上线前核对旧版本，禁止覆盖另一位维护者在此期间发布的内容。
test "$(readlink -f "$base/current")" = "$base/releases/v23"
cd "$base/current/hub"
printf '%s\n' '205812d52b595d610bcb8cbc6fb802cb4886c7d97955027b7cb2603fe2ef2094  server.mjs' 'b6191654fdbaed0178cdfcc519f4febe19f8e2fd477eceb549ba35805d96a430  lib/store.mjs' 'acc6ee66828f76914745d9028a89378077f5a9c9e114ab72ebe52596b528a2ce  lib/job-queue.mjs' | sha256sum -c -
test ! -e "$release"
test "$(mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='temu_transfer_v24'")" = 0
mkdir "$release"
cp -a "$base/current/hub" "$release/hub"
tar -xzf "$stage/mysql-v24.tar.gz" -C "$release/hub"
cd "$release/hub"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R root:temu-transfer "$release"
chmod -R g+rX "$release"

# 只有未放行新版本真实写入时才允许自动恢复旧服务；公开切换后不能回退过时 JSON。
exposed=0
stopped=0
on_error() {
    if [ "$stopped" = 1 ] && [ "$exposed" = 0 ]; then systemctl start temu-transfer; fi
}
trap on_error ERR
systemctl stop temu-transfer
stopped=1
backup=$(mktemp -d "$base/backups/mysql-v24-XXXXXXXX")
cp -a "$shared" "$backup/shared"
printf 'backup=%s\n' "$backup"
runuser -u temu-transfer -- env TEMU_MYSQL_CONFIG="$shared/mysql-v24.json" "$node" scripts/migrate-mysql.mjs --source "$shared" --confirm-offline

# 迁移工具完成 DDL 后，运行账号只保留业务读写权限，不允许再建表删表。
mysql <<'SQL'
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'temu_transfer_v24'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON temu_transfer_v24.* TO 'temu_transfer_v24'@'localhost';
SQL
runuser -u temu-transfer -- env TEMU_MYSQL_CONFIG="$shared/mysql-v24.json" TEMU_CREDENTIALS="$shared/credentials.json" ZINIAO_DATA_ROOT="$shared" TEMU_BASE_PATH=/temu "$node" scripts/smoke-mysql-release.mjs

mkdir -p /etc/systemd/system/temu-transfer.service.d
printf '[Service]\nEnvironment=TEMU_MYSQL_CONFIG=%s/mysql-v24.json\n' "$shared" > /etc/systemd/system/temu-transfer.service.d/mysql.conf
ln -s "$release" "$base/current-mysql-v24"
mv -Tf "$base/current-mysql-v24" "$base/current"
systemctl daemon-reload
exposed=1
systemctl start temu-transfer
systemctl is-active temu-transfer
printf 'release=%s\n' "$release"
