#!/usr/bin/env bash
# v34：账户维度调度（账户内店铺串行、账户间并行）+ 面板取消本店待传任务。
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v33"
release="$base/releases/v34"
node="$base/runtime/bin/node"
stage=/tmp/temu-cancel-v34.hckq

test "$(readlink -f "$base/current")" = "$previous"
test ! -e "$release"
cd "$previous/hub"
sha256sum -c <<'HASHES'
65a56e66a9f6cb13328b83d9601ea1968b976d825f936ba0a758bf3c9c2d067d  lib/ingest-admission.mjs
3eca0f61a4fb7ae0aa95110b4bc94b730b3af634842bd0dc6e4b9c29a7acce4f  lib/ingest-protocol.mjs
93cf670746bb6d8a024adb7547f79619c8c5342332ab5ea143cf12a40b5c1d79  lib/bulk-dispatch.mjs
ae16f91ef9fe19937893d93273074d4c9a7ba70c5294eed925f7b65701081947  server.mjs
98f762a3f86b6cf4b987fc143d1e492c52724a3bd47fb68ffff8ff6e39ea4964  lib/job-queue.mjs
ce6acf428cd7f57f6f4f0963bd3d72df13e075d922abf7e1cf8719cdbfe060ba  lib/mysql-job-repository.mjs
HASHES

mkdir "$release"
cp -a "$previous/hub" "$release/hub"
tar -xzf "$stage/cancel-v34.tar.gz" -C "$release/hub"
chown -R root:temu-transfer "$release"
find "$release" -type d -exec chmod 0750 {} +

cd "$release/hub"
for file in server.mjs lib/account-scheduler.mjs lib/account-resolver.mjs lib/ingest-admission.mjs lib/ingest-protocol.mjs lib/bulk-dispatch.mjs lib/job-queue.mjs lib/mysql-job-repository.mjs; do
    chmod 0640 "$file"
    "$node" --check "$file"
done

export TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json"
export ZINIAO_DATA_ROOT="$base/shared"
export TEMU_CREDENTIALS="$base/shared/credentials.json"
"$node" scripts/smoke-mysql-release.mjs

ln -s "$release" "$base/current-cancel-v34"
mv -Tf "$base/current-cancel-v34" "$base/current"
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer \
    || ! curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null; then
    ln -s "$previous" "$base/current-cancel-rollback-v34"
    mv -Tf "$base/current-cancel-rollback-v34" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
printf 'deployed=%s\n' "$release"
