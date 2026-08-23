-- MySQL 8.0 production migration. Run before deploying the application code.
-- The table and guarded ops_events changes are safe to rerun. DDL errors other
-- than the explicitly checked pre-existing column/index are allowed to fail.
CREATE TABLE IF NOT EXISTS agent_security_aggregates (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bucket_start DATETIME NOT NULL,
  source_hash VARCHAR(64) NOT NULL,
  endpoint VARCHAR(120) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  status INT NOT NULL,
  request_count INT NOT NULL DEFAULT 0,
  unique_uuid_count INT NOT NULL DEFAULT 0,
  uuid_bitmap BIGINT NOT NULL DEFAULT 0,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  sample_uuid VARCHAR(24) NULL,
  known_agent BOOLEAN NOT NULL DEFAULT FALSE,
  server_id INT NULL,
  CONSTRAINT uq_agent_sec_aggregate UNIQUE (bucket_start, source_hash, endpoint, reason, status),
  INDEX ix_agent_sec_bucket (bucket_start),
  INDEX ix_agent_sec_server (server_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER //
DROP PROCEDURE IF EXISTS migrate_agent_security_aggregates//
CREATE PROCEDURE migrate_agent_security_aggregates()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'ops_events'
      AND column_name = 'classification'
  ) THEN
    ALTER TABLE ops_events ADD COLUMN classification VARCHAR(32) NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'ops_events'
      AND index_name = 'ix_ops_events_classification'
  ) THEN
    CREATE INDEX ix_ops_events_classification ON ops_events (classification);
  END IF;
END//
CALL migrate_agent_security_aggregates()//
DROP PROCEDURE migrate_agent_security_aggregates//
DELIMITER ;
