-- ─────────────────────────────────────────────────────────────
-- VPS 星图 · MySQL 初始化脚本 (增强版)
-- 执行：mysql -u root -p < init_db.sql
-- 或通过环境变量：mysql -u root -p$MYSQL_PASSWORD < init_db.sql
-- ─────────────────────────────────────────────────────────────

-- ===== 数据库创建与初始化 =====

CREATE DATABASE IF NOT EXISTS vps_dashboard
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE vps_dashboard;

-- ===== 用户权限设置 =====
-- Docker MySQL 镜像已通过 MYSQL_USER / MYSQL_PASSWORD 环境变量自动创建应用用户
-- 此处只需补充授权，无需手动 CREATE USER

-- 兼容处理：若用户未被 Docker 自动创建，则手动创建（密码占位，Docker 会覆盖）
CREATE USER IF NOT EXISTS 'vps_user'@'%' IDENTIFIED WITH mysql_native_password BY '';
GRANT ALL PRIVILEGES ON vps_dashboard.* TO 'vps_user'@'%';

-- 备份用户（仅读取）
CREATE USER IF NOT EXISTS 'vps_backup'@'localhost' IDENTIFIED WITH mysql_native_password BY 'backup_secure_2024x';
GRANT SELECT, LOCK TABLES ON vps_dashboard.* TO 'vps_backup'@'localhost';

-- 监控用户（仅读取统计）
CREATE USER IF NOT EXISTS 'vps_monitor'@'localhost' IDENTIFIED WITH mysql_native_password BY 'monitor_secure_2024x';
GRANT SELECT ON vps_dashboard.* TO 'vps_monitor'@'localhost';

FLUSH PRIVILEGES;

-- ===== 表结构定义 =====

-- ① 用户表
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '用户ID',
  username      VARCHAR(64)  NOT NULL UNIQUE COMMENT '用户名（唯一）',
  password_hash VARCHAR(256) NOT NULL COMMENT 'bcrypt 密码哈希',
  role          VARCHAR(16)  NOT NULL DEFAULT 'admin' COMMENT '角色：admin|user',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  last_login    DATETIME COMMENT '最后登录时间',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '账户是否激活',
  
  INDEX idx_username (username),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户账户表';

-- ② 服务器表
CREATE TABLE IF NOT EXISTS servers (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '服务器ID',
  
  -- 基本信息
  name       VARCHAR(128) NOT NULL COMMENT '服务器名称',
  group_name VARCHAR(64)  NOT NULL DEFAULT '默认分组' COMMENT '分组名',
  flag       VARCHAR(8)   NOT NULL DEFAULT '🌐' COMMENT '国旗或标记',
  location   VARCHAR(128) NOT NULL DEFAULT '' COMMENT '服务器位置',
  ip         VARCHAR(45)  NOT NULL DEFAULT '' COMMENT 'IPv4 或 IPv6 地址',
  
  -- 硬件配置
  cpu_cores  SMALLINT     NOT NULL DEFAULT 1 COMMENT 'CPU 核心数',
  ram_gb     FLOAT        NOT NULL DEFAULT 1.0 COMMENT '内存 GB',
  disk_gb    INT          NOT NULL DEFAULT 20 COMMENT '磁盘 GB',
  bandwidth  VARCHAR(64)  NOT NULL DEFAULT '不限' COMMENT '带宽配置',
  
  -- 探针配置
  probe_url  VARCHAR(512) NOT NULL DEFAULT '' COMMENT '探针数据接口 URL',
  note       TEXT COMMENT '备注信息',
  
  -- 价格与周期
  price      FLOAT        NOT NULL DEFAULT 0 COMMENT '价格',
  period     VARCHAR(16)  NOT NULL DEFAULT 'monthly' COMMENT '周期：monthly|yearly|custom',
  expiry     DATE COMMENT '过期日期',
  
  -- 实时指标
  cpu_use    FLOAT        NOT NULL DEFAULT 0 COMMENT 'CPU 使用率 (0-100)',
  ram_use    FLOAT        NOT NULL DEFAULT 0 COMMENT '内存使用率 (0-100)',
  disk_use   FLOAT        NOT NULL DEFAULT 0 COMMENT '磁盘使用率 (0-100)',
  net_up     FLOAT        NOT NULL DEFAULT 0 COMMENT '网络上行 (Mbps)',
  net_down   FLOAT        NOT NULL DEFAULT 0 COMMENT '网络下行 (Mbps)',
  status     VARCHAR(16)  NOT NULL DEFAULT 'unknown' COMMENT '状态：online|offline|warn|unknown',
  uptime     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '运行时间',
  
  -- 流量统计
  traffic_limit_gb  FLOAT      NOT NULL DEFAULT 0 COMMENT '流量限制 GB (0=无限)',
  traffic_up_gb     FLOAT      NOT NULL DEFAULT 0 COMMENT '已用上行流量 GB',
  traffic_down_gb   FLOAT      NOT NULL DEFAULT 0 COMMENT '已用下行流量 GB',
  traffic_used_gb   FLOAT      NOT NULL DEFAULT 0 COMMENT '总已用流量 GB',
  traffic_reset_day TINYINT    NOT NULL DEFAULT 1 COMMENT '流量重置日期（1-31）',
  
  -- 时间戳
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  
  INDEX idx_group (group_name),
  INDEX idx_status (status),
  INDEX idx_name (name),
  INDEX idx_expiry (expiry),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='VPS 服务器表';

-- ③ 探针结果历史表（按日分区，MySQL 8.0+ RANGE COLUMNS 方案）
--
-- 分区设计：
--   - 分区键：created_at（UTC DATETIME）
--   - 分区策略：RANGE COLUMNS(created_at)，按日粒度
--   - 命名规则：pYYYYMMDD（如 p20260503）
--   - 兜底分区 pmax 防止未预建分区时写入失败
--
-- MySQL 约束：RANGE COLUMNS 分区表不支持 FOREIGN KEY，
--   服务器级联删除由应用层负责（delete_server API）。
--
-- !!! 重要：下方若出现按日分区日期（如 2026-05-01..2026-05-10），它们只是占位示例，不是安全默认值。
-- !!! 如果直接执行而不改成“实际部署日期附近”的分区范围，新写入数据会立刻落入 pmax，破坏“按日分区”的预期。
-- !!! 初始化前必须重新生成这些日期；生产环境应依赖定时分区维护任务持续向前预建。分区管理命令见 docs/probe_partition_ops.md。
CREATE TABLE IF NOT EXISTS probe_results (
  id         BIGINT UNSIGNED AUTO_INCREMENT,
  server_id  INT UNSIGNED NOT NULL COMMENT '服务器ID（无外键约束，由应用层管理级联）',

  -- 指标数据
  cpu_use    FLOAT COMMENT 'CPU 使用率',
  ram_use    FLOAT COMMENT '内存使用率',
  disk_use   FLOAT COMMENT '磁盘使用率',
  net_up     FLOAT COMMENT '网络上行',
  net_down   FLOAT COMMENT '网络下行',
  latency_ms FLOAT COMMENT '延迟（毫秒）',
  status     VARCHAR(16) COMMENT '状态快照',

  -- 时间戳（分区键，UTC）
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()) COMMENT '探测时间（UTC）',

  -- 主键必须包含分区键（MySQL 分区规则）
  PRIMARY KEY (id, created_at),
  INDEX idx_server_time (server_id, created_at),
  INDEX idx_created_at  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='探针结果历史表（按日分区）'
PARTITION BY RANGE COLUMNS(created_at) (
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

-- ④ 告警规则表
CREATE TABLE IF NOT EXISTS alert_rules (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '规则ID',
  
  -- 规则定义
  server_id   INT UNSIGNED COMMENT '服务器ID (NULL=全局规则)',
  rule_type   VARCHAR(32) NOT NULL COMMENT '告警类型：cpu|ram|disk|offline|expiry|traffic',
  threshold   FLOAT       NOT NULL DEFAULT 90 COMMENT '告警阈值',
  enabled     TINYINT(1)  NOT NULL DEFAULT 1 COMMENT '是否启用',
  
  -- 冷却与控制
  cool_down_s INT         NOT NULL DEFAULT 1800 COMMENT '冷却时间（秒）',
  last_fired  DATETIME COMMENT '最后触发时间',
  
  created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  
  INDEX idx_server_type (server_id, rule_type),
  INDEX idx_enabled (enabled),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='告警规则表';

-- ⑤ Telegram 配置表（单行配置）
CREATE TABLE IF NOT EXISTS telegram_config (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '配置ID',
  
  -- Telegram Bot 信息
  bot_token  VARCHAR(256) NOT NULL DEFAULT '' COMMENT 'Bot Token',
  chat_id    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'Chat ID',
  
  -- 配置项
  prefix     VARCHAR(64)  NOT NULL DEFAULT '【VPS星图】' COMMENT '消息前缀',
  enabled    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '是否启用',
  
  -- 时间戳
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Telegram 配置表 (单行)';

-- ⑥ 审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '日志ID',
  
  -- 操作者信息
  user_id       INT UNSIGNED COMMENT '用户ID',
  username      VARCHAR(64) NOT NULL COMMENT '用户名',
  
  -- 操作信息
  action        VARCHAR(32) NOT NULL COMMENT '操作类型：CREATE|READ|UPDATE|DELETE|LOGIN|ALERT',
  resource_type VARCHAR(32) NOT NULL COMMENT '资源类型：Server|User|Alert',
  resource_id   VARCHAR(128) COMMENT '资源ID',
  
  -- 请求信息
  method        VARCHAR(16) COMMENT 'HTTP 方法',
  endpoint      VARCHAR(256) COMMENT '端点路径',
  
  -- 结果信息
  status_code   INT COMMENT 'HTTP 状态码',
  success       TINYINT(1)  NOT NULL DEFAULT 1 COMMENT '是否成功',
  error_message TEXT COMMENT '错误信息',
  
  -- 安全信息
  ip_address    VARCHAR(45) COMMENT '客户端 IP',
  user_agent    VARCHAR(256) COMMENT '用户代理',
  
  -- 变更追踪
  old_values    JSON COMMENT '变更前数据',
  new_values    JSON COMMENT '变更后数据',
  
  -- 时间戳
  created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  
  INDEX idx_user (user_id),
  INDEX idx_action (action),
  INDEX idx_resource (resource_type, resource_id),
  INDEX idx_created_at (created_at),
  INDEX idx_success (success),
  CONSTRAINT fk_audit_logs_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审计日志表';

-- ===== 初始数据插入 =====

-- ① 默认管理员用户（密码: admin123 → bcrypt）
INSERT INTO users (username, password_hash, role) VALUES
('admin', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5YmMxSUByW46m', 'admin');

-- ② 默认全局告警规则
INSERT INTO alert_rules (server_id, rule_type, threshold, enabled, cool_down_s) VALUES
(NULL, 'cpu',     90, 1, 1800),
(NULL, 'ram',     90, 1, 1800),
(NULL, 'disk',    85, 1, 1800),
(NULL, 'offline',  0, 1, 300),
(NULL, 'expiry',   7, 1, 86400),
(NULL, 'traffic',  80, 1, 3600);

-- ③ Telegram 配置（初始空配置）
INSERT INTO telegram_config (bot_token, chat_id, prefix, enabled) VALUES
('', '', '【VPS星图】', 0);

-- ④ 示例数据（可选，用于演示）
INSERT INTO servers (
  name, group_name, flag, location, ip, cpu_cores, ram_gb, disk_gb,
  bandwidth, price, period, expiry, status,
  traffic_limit_gb, traffic_up_gb, traffic_down_gb, traffic_used_gb, traffic_reset_day
) VALUES
('LA-Pro-01',      '生产环境', '🇺🇸', '美国洛杉矶',        '104.21.45.67',   4, 8,  100, '1Gbps不限',      99,  'yearly',  '2026-06-15', 'online',  0,    342.5,  1820.3, 2162.8, 1),
('HK-Node-02',     '香港节点', '🇭🇰', '香港 CMI',          '43.155.88.12',   2, 2,  40,  '200GB/月',       68,  'monthly', '2026-04-10', 'warn',    200,  62.1,   125.3,  187.4,  1),
('JP-Sakura-03',   '日本节点', '🇯🇵', '日本东京',          '27.0.234.55',    8, 16, 200, '10Gbps共享',     288, 'yearly',  '2026-12-01', 'online',  0,    128.7,  534.2,  662.9,  1),
('DE-Hetzner-04',  '欧洲节点', '🇩🇪', '德国法兰克福',      '95.216.12.88',   6, 12, 240, '不限',           45,  'monthly', '2026-05-20', 'online',  0,    89.3,   412.6,  501.9,  1),
('SG-Linode-05',   '东南亚',   '🇸🇬', '新加坡',            '172.104.55.99',  1, 1,  25,  '1TB/月',         30,  'monthly', '2026-04-05', 'offline', 1024, 201.3,  433.5,  634.8,  15);

-- ===== 索引优化 =====

-- 创建复合索引以优化常见查询
ALTER TABLE servers ADD INDEX idx_status_group (status, group_name);
ALTER TABLE audit_logs ADD INDEX idx_user_action (user_id, action, created_at);

-- ===== 统计信息更新 =====

-- 更新表统计信息（便于查询优化器）
ANALYZE TABLE users;
ANALYZE TABLE servers;
ANALYZE TABLE probe_results;
ANALYZE TABLE alert_rules;
ANALYZE TABLE telegram_config;
ANALYZE TABLE audit_logs;

-- ===== 完成提示 =====

SELECT '✅ VPS Dashboard 数据库初始化完成！' AS status;
SELECT '📊 数据库版本：' AS info, VERSION() AS version;
SELECT COUNT(*) AS user_count FROM users;
SELECT COUNT(*) AS server_count FROM servers;
SELECT COUNT(*) AS rule_count FROM alert_rules;
