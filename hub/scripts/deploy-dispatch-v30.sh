#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/ylx/apps/temu-transfer
previous="$base/releases/v29"
release="$base/releases/v30"
node="$base/runtime/bin/node"
# 仅部署已核验基线上的本轮文件，保留共享资料和历史版本，不覆盖未知线上改动。
test "$(readlink -f "$base/current")" = "$previous"
test ! -e "$release"
printf '%s  %s\n' \
c6a88eb1620e12ae98c3ef1a89b3cda6f5eaf67578c9146cf939426aecd4e9d9 "$previous/hub/server.mjs" \
3d76488cf29ac7308af16141b2fe9a5b96f3d25191370e7cd19d31ea4050cb36 "$previous/hub/lib/bulk-dispatch.mjs" \
b3d136ca370e49d39c9550ddb5da77c0f31a8a438f3ad948aebbfacf8a8653b3 "$previous/hub/lib/job-queue.mjs" \
6fc3cb8c4c3d85392305475d986069cc497aa22c19df56a6ac6a4aa417ae8d61 "$previous/hub/lib/mysql-job-repository.mjs" \
e1a67cb9c7dfb5bce88ef67e13ee7d7e8c2c83d9b6642e249d6d28718c3b351b "$previous/hub/lib/store.mjs" \
246b8bf0db284a8fcec1ab6d7adb0b7e76801f60aa4015351de84526422145ea "$previous/hub/lib/store-names.mjs" \
9b04e0253463daaefb2b3d96a362934025adef6a4e8ee48e6a12c08a6ce78037 "$previous/hub/lib/mysql-schema.mjs" \
0eacbc80d28f67388614cf835f0842cc1d961ee2dce1e0dfa19b86421c1994bd "$previous/hub/public/app.js" | sha256sum -c -
mkdir "$release"
cp -a "$previous/hub" "$release/hub"
tar -xzf /tmp/temu-dispatch-v30.tar.gz -C "$release"
chown -R root:temu-transfer "$release"
chmod 0750 "$release"
for file in server.mjs lib/bulk-dispatch.mjs lib/job-queue.mjs lib/mysql-job-repository.mjs lib/store.mjs lib/store-names.mjs lib/mysql-schema.mjs public/app.js scripts/migrate-dispatch-v30.mjs; do
    chmod 0640 "$release/hub/$file"
    "$node" --check "$release/hub/$file"
done
cd "$release/hub"
# 新表是增量DDL，旧版本可继续运行；应用账号不增加DDL权限。
"$node" scripts/migrate-dispatch-v30.mjs --schema-sql | mysql temu_transfer_v24
export TEMU_MYSQL_CONFIG="$base/shared/mysql-v24.json"
export ZINIAO_DATA_ROOT="$base/shared"
export TEMU_CREDENTIALS="$base/shared/credentials.json"
"$node" scripts/smoke-mysql-release.mjs
ln -s "$release" "$base/current-dispatch-v30"
mv -Tf "$base/current-dispatch-v30" "$base/current"
if ! systemctl restart temu-transfer || ! systemctl is-active --quiet temu-transfer || ! curl --fail --silent --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:18480/temu/ -o /dev/null; then
    ln -s "$previous" "$base/current-dispatch-rollback-v30"
    mv -Tf "$base/current-dispatch-rollback-v30" "$base/current"
    systemctl restart temu-transfer
    exit 1
fi
# 仅对明确因旧版离线计次而暂停的清单恢复等待，取消及权限暂停不自动恢复。
"$node" scripts/migrate-dispatch-v30.mjs
printf 'deployed=%s\n' "$release"
