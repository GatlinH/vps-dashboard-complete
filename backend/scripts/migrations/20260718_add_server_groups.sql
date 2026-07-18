-- MySQL production migration. Run after backup and before deploying code.
-- It is additive only; verify the FK/index names do not already exist before rerunning.
CREATE TABLE IF NOT EXISTS server_groups (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  purpose VARCHAR(160) NOT NULL DEFAULT '',
  color VARCHAR(7) NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_server_groups_name (name),
  KEY ix_server_groups_sort_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE servers ADD COLUMN group_id INT NULL;
ALTER TABLE servers ADD KEY ix_servers_group_id (group_id);
ALTER TABLE servers ADD CONSTRAINT fk_servers_group_id
  FOREIGN KEY (group_id) REFERENCES server_groups(id) ON DELETE SET NULL;
