#!/usr/bin/env bash
# v32：执行轮次协议（服务端）+ 外部终止清除任务。
# 在 v31 的精确基线上增量发布：先校验未改动文件仍是上一版，再覆盖三个业务文件。
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v31"
release="$base/releases/v32"
node="$base/runtime/bin/node"
stage=/tmp/temu-execution-run-v32.hckq

# 1) 精确基线：current 必须是 v31，且未改动文件与上一版一致，避免覆盖他人部署。
test "$(readlink -f "$base/current")" = "$previous"
test ! -e "$release"
cd "$previous/hub"
sha256sum -c <<'HASHES'
0090c40c037a8cf1fa64bab2761bea6f9ce9cf40bc2193d01af6e3ddc23d5f82  lib/job-queue.mjs
72fd385ce0876dfa2440a09909653399b49a4e84f7a6d643b769679eb7d441f4  lib/mysql-job-repository.mjs
33e3ae9ab15984a1cdefaf98fb043fb3499653c8c300c2fae3aca3dc18b337d7  server.mjs
8c480b1e129b33cf5b453bf1ee9d3ea37f48df4f2a56c72438b484195692bf22  public/app.js
HASHES

# 2) 建新版本目录：整份复制 v31，再用暂存包覆盖本次改动。
mkdir "$release"
cp -a "$previous/hub" "$release/hub"
tar -xzf "$stage/execution-run-v32.tar.gz" -C "$release/hub"
chown -R root:temu-transfer "$release"
find "$release" -type d -exec chmod 0750 {} +

# 3) 语法检查后再放行；语法错误必须在切换软链之前暴露。
cd "$release/hub"
for file in server.mjs lib/job-queue.mjs lib/mysql-job-repository.mjs; do
    chmod 0640 "$file"
    "$node" --check "$file"
done

# 4) 只读冒烟：不写业务数据，只确认服务能起来并响应。
export TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json"
export ZINIAO_DATA_ROOT="$base/shared"
export TEMU_CREDENTIALS="$base/shared/credentials.json"
"$node" scripts/smoke-mysql-release.mjs

# 5) 切换软链并重启；健康检查失败立即回滚到 v31。
ln -s "$release" "$base/current-execution-run-v32"
mv -Tf "$base/current-execution-run-v32" "$base/current"
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer \
    || ! curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null; then
    ln -s "$previous" "$base/current-execution-run-rollback-v32"
    mv -Tf "$base/current-execution-run-rollback-v32" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
printf 'deployed=%s\n' "$release"
