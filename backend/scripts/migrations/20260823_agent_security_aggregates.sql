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
);

ALTER TABLE ops_events ADD COLUMN classification VARCHAR(32) NULL;
CREATE INDEX ix_ops_events_classification ON ops_events (classification);
