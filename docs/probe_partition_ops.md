# ProbeResult 分区运维手册

> **适用范围**：MySQL 8.0+  
> **仅 MySQL 生效**：SQLite 及其他非 MySQL 环境会安全跳过所有分区 DDL，回退为 DELETE 清理。

---

## 分区方案

| 项目 | 说明 |
|------|------|
| 表名 | `probe_results` |
| 分区策略 | `RANGE COLUMNS(created_at)` |
| 分区粒度 | **按日**（pYYYYMMDD，如 `p20260503`） |
| 分区键 | `created_at`（UTC DATETIME） |
| 时区 | 统一 UTC，与写入路径一致，消除时区边界偏差 |
| 兜底分区 | `pmax`（`VALUES LESS THAN (MAXVALUE)`），永不删除 |
| 主键 | `(id, created_at)`（MySQL 分区规则要求主键包含分区键） |
| 外键 | **无**（MySQL 分区表不支持 FK），级联删除由应用层负责 |

### 为什么按日而非按月？

- 按日可精确控制保留粒度（默认 30 天），误删窗口仅 1 天。
- 按月清理粒度为 1 个月，保留期边界可能误删/误留。
- 每天 86400 秒探针写入量可控，单日分区大小合理。

---

## 自动化维护

调度器（`services/scheduler.py`）注册了两个分区维护任务：

| 任务 ID | 时间 | 功能 |
|---------|------|------|
| `probe_partition_maintain` | 每天 01:30 | 预创建未来 N 天分区（默认 30 天） |
| `cleanup` | 每天 02:00 | DROP 过期分区（MySQL），或 DELETE 旧行（非 MySQL） |

### 配置项

在 `.env` 中可调整：

```ini
# 历史数据保留天数（超过此时间的分区将被删除）
PROBE_RESULT_RETENTION_DAYS=30

# 每次预创建的未来分区天数
PROBE_RESULT_PARTITION_DAYS_AHEAD=30
```

---

## 运维命令示例

### 查看当前分区

```sql
-- 查看 probe_results 所有分区及行数
SELECT
    PARTITION_NAME,
    PARTITION_DESCRIPTION,
    TABLE_ROWS,
    PARTITION_ORDINAL_POSITION
FROM INFORMATION_SCHEMA.PARTITIONS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'probe_results'
  AND PARTITION_NAME IS NOT NULL
ORDER BY PARTITION_ORDINAL_POSITION;
```

### 手动预创建分区

将新分区插入到 pmax 之前（通过 REORGANIZE PARTITION）：

```sql
-- 示例：手动创建 2026-06-01 的分区
ALTER TABLE probe_results REORGANIZE PARTITION pmax INTO (
    PARTITION p20260601 VALUES LESS THAN ('2026-06-02'),
    PARTITION pmax      VALUES LESS THAN (MAXVALUE)
);
```

也可通过 Python 调用工具函数：

```python
from services.probe_partition import ensure_future_partitions
from extensions import db

# 预创建未来 30 天分区
created = ensure_future_partitions(db.engine, days_ahead=30)
print(f"Created: {created}")
```

### 手动清理过期分区

```sql
-- 示例：删除 p20260401 分区（包含该天所有行，操作为元数据操作，极快）
ALTER TABLE probe_results DROP PARTITION p20260401;
```

Python dry_run 预览（不执行 DDL）：

```python
from services.probe_partition import drop_expired_partitions
from extensions import db

# 预览将删除哪些分区（不实际执行）
to_drop = drop_expired_partitions(db.engine, retention_days=30, dry_run=True)
print(f"Would drop: {to_drop}")

# 实际执行
dropped = drop_expired_partitions(db.engine, retention_days=30)
print(f"Dropped: {dropped}")
```

### 验证分区裁剪（Partition Pruning）

```sql
-- 确认查询能命中正确分区（EXPLAIN PARTITIONS）
EXPLAIN SELECT * FROM probe_results
WHERE server_id = 1
  AND created_at >= '2026-05-01'
  AND created_at <  '2026-05-03';
-- 期望：partitions 列显示 p20260501,p20260502
```

---

## 迁移方案

### 新部署

使用 `backend/init_db.sql` 初始化数据库，其中包含按日 RANGE COLUMNS 分区的 `probe_results` 表定义。

### 现有库升级

见 `backend/scripts/migrations/p3_3_probe_result_partition.sql`，步骤概述：

1. 创建新分区表 `probe_results_new`
2. 回填历史数据（大表建议分批，每批 10 万行，低峰时段执行）
3. 行数校验（`COUNT(*)` 一致后再切换）
4. `RENAME TABLE` 原子切换（瞬时元数据锁，对在线写入影响极小）
5. 保留旧表 `probe_results_old` 至少 24 小时

### 停机窗口评估

| 步骤 | 锁类型 | 说明 |
|------|--------|------|
| 建新表 | 无锁 | 空表 DDL |
| 回填 | 读锁 | INSERT ... SELECT，不阻塞写入 |
| RENAME | 元数据锁（< 1ms） | 在线流量影响极小 |

> 对于 > 500 万行的大表，建议使用 `pt-online-schema-change` 或 `gh-ost` 实现在线迁移。

---

## 回滚方案

### 场景 A：旧表 `probe_results_old` 仍存在

```sql
RENAME TABLE probe_results     TO probe_results_failed,
             probe_results_old TO probe_results;
```

### 场景 B：旧表已删除

从备份恢复（见 `BACKUP_AND_ROLLBACK.md`）。

### 分区方案回退（恢复无分区表）

```sql
-- 1. 创建无分区的普通表
CREATE TABLE probe_results_nop LIKE probe_results;
ALTER TABLE probe_results_nop REMOVE PARTITIONING;

-- 2. 回填数据
INSERT INTO probe_results_nop SELECT * FROM probe_results;

-- 3. 切换
RENAME TABLE probe_results     TO probe_results_partitioned,
             probe_results_nop TO probe_results;
```

---

## 性能对比（定性）

| 指标 | 旧方案（海量 DELETE） | 新方案（DROP PARTITION） |
|------|----------------------|--------------------------|
| 执行时间（100 万行） | 分钟级（逐行扫描）| 毫秒级（元数据操作）|
| I/O 压力 | 高（undo log、binlog、索引重建）| 极低 |
| 锁类型 | 行锁（可能升级表锁）| 元数据锁（< 1ms） |
| Binlog 体积 | 大（每行 DELETE 事件）| 极小（单个 DDL 事件）|
| 对在线请求影响 | 中等（锁等待、I/O 竞争）| 可忽略 |

---

## 限制与注意事项

1. **仅 MySQL 8.0+**：SQLite 测试环境自动跳过分区 DDL，回退为 DELETE。
2. **无外键约束**：MySQL 分区表不支持 FK。服务器删除时，`probe_results` 中的历史行不会自动级联删除；这些孤儿行会在保留期后由分区清理任务自动删除，不影响业务语义。
3. **主键变更**：从 `PRIMARY KEY (id)` 变更为 `PRIMARY KEY (id, created_at)`。应用层按 `id` 查询时，MySQL 会进行分区扫描（若不带 created_at 条件）；历史查询主要按 `server_id + created_at` 过滤，不受影响。
4. **时区**：分区键 `created_at` 统一 UTC 写入，清理计算也基于 UTC。若应用层时区配置变更（`SCHEDULER_TIMEZONE`），清理边界仅影响调度触发时间，不影响 UTC 分区边界。
5. **pmax 兜底**：若分区维护任务失败，数据写入 pmax 分区。这不影响写入功能，但 pmax 中的数据无法通过 DROP PARTITION 清理（需手动 DELETE 或等待下次分区预建后迁移）。
6. **分区数量**：按日分区，保留 30 天 = 30 个分区 + pmax，MySQL 支持上限（8192）远超此需求。
