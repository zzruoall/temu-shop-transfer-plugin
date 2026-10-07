#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v28"
release="$base/releases/v29"
node="$base/runtime/bin/node"
# 仅叠加本轮三个服务端文件，不同步本地数据、不覆盖其他版本发布。
test "$(readlink -f "$base/current")" = "$previous"
test ! -e "$release"
printf '%s  %s\n' \
65dd9a2f75b54b0a40bef5329de1785529a3c021494d3f39d31af2ce54160954 "$previous/hub/server.mjs" \
328f1637305ec3f71ec32c665fe7c5f155325f21c5e246a1b551e850318f8aa7 "$previous/hub/lib/job-queue.mjs" \
185cd6ebcfa6b7fbfb2b12a4430ccf997d2094e483c2d3879e9cba88c4dee1c7 "$previous/hub/lib/mysql-job-repository.mjs" | sha256sum -c -
mkdir "$release"
cp -a "$previous/hub" "$release/hub"
tar -xzf /tmp/temu-receive-recovery-v29.tar.gz -C "$release"
chown -R root:temu-transfer "$release"
chmod 0750 "$release"
for file in server.mjs lib/job-queue.mjs lib/mysql-job-repository.mjs; do
    chmod 0640 "$release/hub/$file"
    "$node" --check "$release/hub/$file"
done
export TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json"
export ZINIAO_DATA_ROOT="$base/shared"
export TEMU_CREDENTIALS="$base/shared/credentials.json"
cd "$release/hub"
# 随机回环端口的只读冒烟关闭分发与失联维护，不向真实店铺发送任何任务。
"$node" scripts/smoke-mysql-release.mjs
ln -s "$release" "$base/current-receive-v29"
mv -Tf "$base/current-receive-v29" "$base/current"
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer || ! curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null; then
    ln -s "$previous" "$base/current-receive-rollback-v29"
    mv -Tf "$base/current-receive-rollback-v29" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
printf 'deployed=%s\n' "$release"
