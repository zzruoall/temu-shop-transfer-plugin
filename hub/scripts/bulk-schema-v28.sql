-- 仅新增批量分发清单，不修改或删除现有商品、店铺和执行回执。
CREATE TABLE IF NOT EXISTS hub_bulk_dispatch (
    id CHAR(64) PRIMARY KEY, owner_id VARCHAR(255) NOT NULL, input_hash CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL, created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
    next_run_at VARCHAR(30) NOT NULL, lease_until VARCHAR(30) NOT NULL, lease_id VARCHAR(40) NOT NULL,
    manifest JSON NOT NULL, state JSON NOT NULL,
    INDEX(status,next_run_at), INDEX(owner_id,created_at), INDEX(created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
