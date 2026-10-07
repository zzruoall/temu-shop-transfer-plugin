#!/usr/bin/env bash
# 用户明确授权清除十条旧任务后发布；先副本恢复演练，正式停服后再次完整备份。
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
stage=${1:?missing-stage}
test "$(readlink -f "$base/current")" = "$base/releases/v34"
test "$stage" = /tmp/temu-v35-20260929
release="$base/releases/v35"
test ! -e "$release"
node="$base/runtime/bin/node"
export PATH="$base/runtime/bin:$PATH"
mkdir "$release"
tar -xzf "$stage/release.tar.gz" -C "$release"
cd "$release/hub"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
find lib workers scripts -name '*.mjs' -print0 | xargs -0 -n1 "$node" --check
"$node" --check server.mjs
backup=$(mktemp -d "$base/backups/account-v35-XXXXXXXX")
echo "backup=$backup"
mysqldump --single-transaction --hex-blob --routines --triggers --set-gtid-purged=OFF temu_transfer_v24 > "$backup/preview.sql"
test "$(mysql -N -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='temu_v35_restore_check'")" = 0
mysql -e 'CREATE DATABASE temu_v35_restore_check CHARACTER SET utf8mb4 COLLATE utf8mb4_bin'
mysql temu_v35_restore_check < "$backup/preview.sql"
cp -a "$base/shared" "$stage/preview-data"
"$node" scripts/release-account-v35.mjs preview temu_v35_restore_check "$stage/preview-data" "$stage/preview-mysql.json"
env TEMU_MYSQL_CONFIG="$stage/preview-mysql.json" ZINIAO_DATA_ROOT="$stage/preview-data" TEMU_CREDENTIALS="$stage/preview-data/credentials.json" ZINIAO_ACCOUNT_PROCESS_MODE=on ZINIAO_SERVICE_MEMORY_BYTES=805306368 "$node" scripts/smoke-mysql-release.mjs
mysql -e 'DROP DATABASE temu_v35_restore_check'
chown -R root:temu-transfer "$release"
chmod -R g+rX "$release"

# 只在演练成功后暂停生产，停服后的备份才是本次删除的权威恢复点。
systemctl stop temu-transfer
test "$(systemctl is-active temu-transfer || true)" = inactive
mysqldump --single-transaction --hex-blob --routines --triggers --set-gtid-purged=OFF temu_transfer_v24 > "$backup/production.sql"
cp -a "$base/shared" "$backup/shared"
cp -a /etc/systemd/system/temu-transfer.service.d "$backup/systemd-dropins"
sha256sum "$backup/production.sql" > "$backup/production.sql.sha256"
echo "authoritative_backup=$backup"

# 开放新服务前失败才能恢复旧库；开放后不自动回滚，避免丢失新受理的任务或重复执行。
opened=0
recover_before_open() {
    code=$?
    if [ "$opened" = 0 ]; then
        mysql temu_transfer_v24 < "$backup/production.sql"
        rm -f /etc/systemd/system/temu-transfer.service.d/account-v35.conf
        ln -s "$base/releases/v34" "$base/current-rollback-v35"
        mv -Tf "$base/current-rollback-v35" "$base/current"
        systemctl daemon-reload
        systemctl start temu-transfer
    else
        systemctl stop temu-transfer
        echo 'post-open failure: service stopped; preserve new database and reconcile before rollback' >&2
    fi
    exit "$code"
}
trap recover_before_open ERR
"$node" scripts/release-account-v35.mjs production temu_transfer_v24 "$base/shared"
env TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json" "$node" scripts/preflight-account-cutover.mjs
env TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json" ZINIAO_DATA_ROOT="$base/shared" TEMU_CREDENTIALS="$base/shared/credentials.json" ZINIAO_ACCOUNT_PROCESS_MODE=on ZINIAO_SERVICE_MEMORY_BYTES=805306368 "$node" scripts/smoke-mysql-release.mjs
printf '[Service]\nEnvironment=ZINIAO_ACCOUNT_PROCESS_MODE=on\n' > /etc/systemd/system/temu-transfer.service.d/account-v35.conf
ln -s "$release" "$base/current-v35"
mv -Tf "$base/current-v35" "$base/current"
systemctl daemon-reload
opened=1
systemctl start temu-transfer
systemctl is-active --quiet temu-transfer
curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null
echo "deployed=$release"
echo "backup=$backup"
