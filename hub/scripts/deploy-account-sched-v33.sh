#!/usr/bin/env bash
# v33：账户公平调度（上传准入按认领账号）+ 准入/分发接入调度器。
# 在 v32 的精确基线上增量发布：先校验未改动文件与上一版一致，再覆盖 4 个业务文件。
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v32"
release="$base/releases/v33"
node="$base/runtime/bin/node"
stage=/tmp/temu-account-sched-v33.hckq

test "$(readlink -f "$base/current")" = "$previous"
test ! -e "$release"
cd "$previous/hub"
sha256sum -c <<'HASHES'
12ac8e1d3a8bdb48c9e3fe47b0d9ba19a42a283bcd9265a6b6394d8039ab2fad  lib/ingest-admission.mjs
b89ef05fa3690ad13d8800fce44b3d65c163abc95339d38822f977da6996b821  lib/ingest-protocol.mjs
90c0931aa262eccc132de1bf6f4b5a155d17a22b9fe2c5391bfbf9bc8b9e2901  lib/bulk-dispatch.mjs
f9d8c50213f2d190a82aa8293cfad042260b2cb74bb9ea3beab42f3f179004cd  server.mjs
HASHES

mkdir "$release"
cp -a "$previous/hub" "$release/hub"
tar -xzf "$stage/account-sched-v33.tar.gz" -C "$release/hub"
chown -R root:temu-transfer "$release"
find "$release" -type d -exec chmod 0750 {} +

cd "$release/hub"
for file in server.mjs lib/account-scheduler.mjs lib/ingest-admission.mjs lib/ingest-protocol.mjs lib/bulk-dispatch.mjs lib/job-queue.mjs lib/mysql-job-repository.mjs; do
    chmod 0640 "$file"
    "$node" --check "$file"
done

export TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json"
export ZINIAO_DATA_ROOT="$base/shared"
export TEMU_CREDENTIALS="$base/shared/credentials.json"
"$node" scripts/smoke-mysql-release.mjs

ln -s "$release" "$base/current-account-sched-v33"
mv -Tf "$base/current-account-sched-v33" "$base/current"
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer \
    || ! curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null; then
    ln -s "$previous" "$base/current-account-sched-rollback-v33"
    mv -Tf "$base/current-account-sched-rollback-v33" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
printf 'deployed=%s\n' "$release"
