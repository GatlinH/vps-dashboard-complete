-- ─────────────────────────────────────────────────────────────
-- VPS 星图 · MySQL 初始化脚本
-- 执行：mysql -u root -p < init_db.sql
-- ─────────────────────────────────────────────────────────────

CREATE DATABASE IF NOT EXISTS vps_dashboard
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'vps_user'@'localhost' IDENTIFIED BY '强密码请修改';
GRANT ALL PRIVILEGES ON vps_dashboard.* TO 'vps_user'@'localhost';
FLUSH PRIVILEGES;

USE vps_dashboard;

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL UNIQUE,
  password_hash VARCHAR(256) NOT NULL,
  role          VARCHAR(16)  NOT NULL DEFAULT 'admin',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login    DATETIME,
  INDEX idx_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 默认管理员（密码 admin123，首次启动 Flask 会自动创建）
-- INSERT INTO users (username, password_hash, role)
-- VALUES ('admin', '<werkzeug_hash>', 'admin');

-- 服务器表
CREATE TABLE IF NOT EXISTS servers (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(128) NOT NULL,
  group_name VARCHAR(64)  NOT NULL DEFAULT '默认分组',
  flag       VARCHAR(8)   NOT NULL DEFAULT '🌐',
  location   VARCHAR(128) NOT NULL DEFAULT '',
  ip         VARCHAR(45)  NOT NULL DEFAULT '',
  cpu_cores  SMALLINT     NOT NULL DEFAULT 1,
  ram_gb     FLOAT        NOT NULL DEFAULT 1.0,
  disk_gb    INT          NOT NULL DEFAULT 20,
  bandwidth  VARCHAR(64)  NOT NULL DEFAULT '不限',
  probe_url  VARCHAR(512) NOT NULL DEFAULT '',
  note       TEXT,

  price      FLOAT        NOT NULL DEFAULT 0,
  period     VARCHAR(16)  NOT NULL DEFAULT 'monthly',
  expiry     DATE,

  cpu_use    FLOAT        NOT NULL DEFAULT 0,
  ram_use    FLOAT        NOT NULL DEFAULT 0,
  disk_use   FLOAT        NOT NULL DEFAULT 0,
  net_up     FLOAT        NOT NULL DEFAULT 0,
  net_down   FLOAT        NOT NULL DEFAULT 0,
  status     VARCHAR(16)  NOT NULL DEFAULT 'unknown',
  uptime     VARCHAR(16)  NOT NULL DEFAULT '',

  -- Traffic accounting
  traffic_limit_gb  FLOAT      NOT NULL DEFAULT 0,
  traffic_up_gb     FLOAT      NOT NULL DEFAULT 0,
  traffic_down_gb   FLOAT      NOT NULL DEFAULT 0,
  traffic_used_gb   FLOAT      NOT NULL DEFAULT 0,
  traffic_reset_day TINYINT    NOT NULL DEFAULT 1,

  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_group (group_name),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 探针历史表（分区按月，便于大量数据时归档）
CREATE TABLE IF NOT EXISTS probe_results (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  server_id  INT UNSIGNED NOT NULL,
  probed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cpu_use    FLOAT,
  ram_use    FLOAT,
  disk_use   FLOAT,
  net_up     FLOAT,
  net_down   FLOAT,
  latency_ms FLOAT,
  status     VARCHAR(16),
  INDEX idx_server_time (server_id, probed_at),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 告警规则表
CREATE TABLE IF NOT EXISTS alert_rules (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  server_id   INT UNSIGNED,              -- NULL = 全局规则
  rule_type   VARCHAR(32) NOT NULL,      -- cpu|ram|disk|offline|expiry
  threshold   FLOAT       NOT NULL DEFAULT 90,
  enabled     TINYINT(1)  NOT NULL DEFAULT 1,
  last_fired  DATETIME,
  cool_down_s INT         NOT NULL DEFAULT 300,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 默认全局告警规则
INSERT INTO alert_rules (rule_type, threshold, enabled) VALUES
  ('cpu',     90, 1),
  ('ram',     90, 1),
  ('disk',    85, 1),
  ('offline',  0, 1),
  ('expiry',   7, 1),
  ('traffic_warn', 80, 1),
  ('traffic_crit', 95, 1);

-- Telegram 配置表（单行）
CREATE TABLE IF NOT EXISTS telegram_config (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bot_token  VARCHAR(256) NOT NULL DEFAULT '',
  chat_id    VARCHAR(64)  NOT NULL DEFAULT '',
  prefix     VARCHAR(64)  NOT NULL DEFAULT '【VPS星图】',
  enabled    TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO telegram_config (bot_token, chat_id, prefix, enabled) VALUES ('', '', '【VPS星图】', 0);

-- ── 示例数据（可选）────────────────────────────────────────────────────────────
INSERT INTO servers (name, group_name, flag, location, ip, cpu_cores, ram_gb, disk_gb,
  bandwidth, price, period, expiry, status,
  traffic_limit_gb, traffic_up_gb, traffic_down_gb, traffic_used_gb, traffic_reset_day)
VALUES
  ('LA-Pro-01',     '生产环境', '🇺🇸', '美国洛杉矶',        '104.21.45.67', 4, 8,  100, '1Gbps不限', 99,  'yearly',  '2026-06-15', 'online',  0,    342.5,  1820.3, 2162.8, 1),
  ('HK-Node-02',    '香港节点', '🇭🇰', '香港 CMI',          '43.155.88.12', 2, 2,   40, '200GB/月',  68,  'monthly', '2026-04-10', 'warn',    200,   62.1,   125.3,  187.4,  1),
  ('JP-Sakura-03',  '日本节点', '🇯🇵', '日本东京 SoftBank', '27.0.234.55',  8, 16, 200, '10Gbps共享', 288, 'yearly',  '2026-12-01', 'online',  0,    128.7,   534.2,  662.9,  1),
  ('DE-Hetzner-04', '欧洲节点', '🇩🇪', '德国法兰克福',      '95.216.12.88', 6, 12, 240, '不限',       45,  'monthly', '2026-05-20', 'online',  0,     89.3,   412.6,  501.9,  1),
  ('SG-Linode-05',  '东南亚',   '🇸🇬', '新加坡',            '172.104.55.99',1, 1,   25, '1TB/月',    30,  'monthly', '2026-04-05', 'offline', 1024, 201.3,   433.5,  634.8, 15);
