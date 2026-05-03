-- =============================================================================
-- P3-3: probe_results 表迁移至按日 RANGE COLUMNS 分区
-- =============================================================================
--
-- 目标：将 probe_results 从无分区（或旧 RANGE(YEAR) 分区）迁移到
--       按日 RANGE COLUMNS(created_at) 分区方案，并移除与分区不兼容的 FK。
--
-- 停机 / 锁影响说明：
--   - STEP 1（建新表）：建空表，无锁。
--   - STEP 2（回填）：INSERT INTO ... SELECT，持续读锁（无写锁），
--     建议在低峰窗口分批执行（每批 10 万行），时间视表大小而定。
--   - STEP 3（原子切换）：RENAME TABLE，瞬时元数据锁（< 1ms）。
--   - STEP 4（验证）：SELECT COUNT(*)，无锁。
--
-- 数据完整性校验：
--   迁移后执行 SELECT COUNT(*) 对比新旧表行数。
--   建议迁移前对 probe_results 建快照或导出计数。
--
-- 大表安全建议：
--   - 若表超过 1 千万行，推荐使用 pt-online-schema-change 或 gh-ost。
--   - 分批回填时使用 LIMIT + ORDER BY id，每批后 SLEEP 0.1s 降低 I/O 压力。
--   - 迁移期间监控主从复制延迟。
--
-- 前提条件：MySQL 8.0+，当前数据库用户有 ALTER/CREATE TABLE 权限。
-- =============================================================================

-- 注意：不要在此脚本中硬编码 USE <database>;
-- 请在执行脚本前由调用方/迁移工具显式选择目标数据库。

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: 创建新的按日分区表
--
-- ⚠ 分区范围设置指引（重要）：
--   初始分区应覆盖从 "最早历史数据日期" 到 "今天 + days_ahead" 的完整区间，
--   以确保所有历史数据落入命名分区（而非 pmax），从而支持精确的 DROP PARTITION 清理。
--
--   推荐做法：
--     1. 查询历史最早日期：SELECT DATE(MIN(created_at)) FROM probe_results;
--     2. 使用以下辅助查询生成连续分区 DDL（以 Python 为例）：
--          from datetime import date, timedelta
--          start = date(2025, 1, 1)          # 替换为最早历史数据日期
--          days_ahead = 30
--          today = date.today()
--          d = start
--          while d <= today + timedelta(days=days_ahead):
--              upper = d + timedelta(days=1)
--              print(f"  PARTITION p{d.strftime('%Y%m%d')} VALUES LESS THAN ('{upper}'),")
--              d += timedelta(days=1)
--     3. 将生成的分区列表粘贴到下方 CREATE TABLE 语句中（替换示例分区）。
--
--   注意：若初始分区仅覆盖近期，历史数据全部落入第一个分区，
--   导致该分区在保留期后仍包含大量历史数据，DROP PARTITION 清理精度受损。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS probe_results_new (
  id         BIGINT UNSIGNED AUTO_INCREMENT,
  server_id  INT UNSIGNED NOT NULL COMMENT '服务器ID（无外键约束，应用层管理级联删除）',

  cpu_use    FLOAT        COMMENT 'CPU 使用率',
  ram_use    FLOAT        COMMENT '内存使用率',
  disk_use   FLOAT        COMMENT '磁盘使用率',
  net_up     FLOAT        COMMENT '网络上行',
  net_down   FLOAT        COMMENT '网络下行',
  latency_ms FLOAT        COMMENT '延迟（毫秒）',
  status     VARCHAR(16)  COMMENT '状态快照',
  created_at DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()) COMMENT '探测时间（UTC）',

  -- 主键必须包含分区键（MySQL RANGE COLUMNS 规则）
  PRIMARY KEY (id, created_at),
  INDEX idx_server_time (server_id, created_at),
  INDEX idx_created_at  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='探针结果历史表（按日分区）'
PARTITION BY RANGE COLUMNS(created_at) (
  -- ⚠ 示例分区仅覆盖 2026-05 前 10 天，请按上方指引替换为实际日期范围。
  -- 至少应从 (历史最早日期) 到 (今天 + PROBE_RESULT_PARTITION_DAYS_AHEAD)。
  PARTITION p20260501 VALUES LESS THAN ('2026-05-02'),
  PARTITION p20260502 VALUES LESS THAN ('2026-05-03'),
  PARTITION p20260503 VALUES LESS THAN ('2026-05-04'),
  PARTITION p20260504 VALUES LESS THAN ('2026-05-05'),
  PARTITION p20260505 VALUES LESS THAN ('2026-05-06'),
  PARTITION p20260506 VALUES LESS THAN ('2026-05-07'),
  PARTITION p20260507 VALUES LESS THAN ('2026-05-08'),
  PARTITION p20260508 VALUES LESS THAN ('2026-05-09'),
  PARTITION p20260509 VALUES LESS THAN ('2026-05-10'),
  PARTITION p20260510 VALUES LESS THAN ('2026-05-11'),
  PARTITION pmax      VALUES LESS THAN (MAXVALUE)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: 回填历史数据
--         ⚠ 大表（> 500 万行）建议分批执行：
--           每次执行以下 INSERT，递增 @min_id：
--             INSERT INTO probe_results_new
--               SELECT * FROM probe_results
--               WHERE id >= @min_id AND id < @min_id + 100000
--               ORDER BY id;
--           重复直至 @min_id 超过 MAX(id)。
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO probe_results_new
  SELECT id, server_id, cpu_use, ram_use, disk_use,
         net_up, net_down, latency_ms, status, created_at
  FROM probe_results;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: 数据完整性校验（迁移前记录原表行数，迁移后对比）
-- ─────────────────────────────────────────────────────────────────────────────
-- 迁移前执行并记录：
--   SELECT COUNT(*) AS original_rows FROM probe_results;
-- 迁移后校验：
--   SELECT
--     (SELECT COUNT(*) FROM probe_results)     AS old_count,
--     (SELECT COUNT(*) FROM probe_results_new) AS new_count;
-- 确认 old_count == new_count 后再执行 STEP 4。

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: 原子切换（瞬时元数据锁，线上流量影响极小）
-- ─────────────────────────────────────────────────────────────────────────────
RENAME TABLE
  probe_results     TO probe_results_old,
  probe_results_new TO probe_results;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: 验证新表可读写后删除旧表
--         建议保留 probe_results_old 至少 24 小时以备回滚，确认无误后执行：
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP TABLE probe_results_old;

-- ─────────────────────────────────────────────────────────────────────────────
-- 回滚方案（若需回滚）：
--   1. 若 probe_results_old 仍存在：
--        RENAME TABLE probe_results TO probe_results_failed,
--                     probe_results_old TO probe_results;
--   2. 若 probe_results_old 已删除：
--        从备份恢复（见 BACKUP_AND_ROLLBACK.md）。
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 索引验证（迁移后确认查询计划）
-- ─────────────────────────────────────────────────────────────────────────────
-- EXPLAIN SELECT * FROM probe_results
--   WHERE server_id = 1
--     AND created_at >= NOW() - INTERVAL 7 DAY;
-- 期望：type = range, possible_keys 包含 idx_server_time。
