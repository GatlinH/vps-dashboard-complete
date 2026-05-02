-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: P2-3  AuditLog.user_id FK → ON DELETE SET NULL
-- Purpose   : When a User row is deleted the corresponding audit_log rows must
--             be RETAINED, with user_id silently set to NULL.  Without this
--             change, deleting a user either raises an FK violation (InnoDB
--             default) or silently removes audit history.
-- Dialect   : MySQL / MariaDB (InnoDB)
-- Safe for  : tables with existing data – no rows are touched
-- Lock      : brief metadata lock while ALTER runs; for large tables consider
--             running during a maintenance window or using pt-online-schema-change
-- ─────────────────────────────────────────────────────────────────────────────

-- ── UPGRADE ──────────────────────────────────────────────────────────────────

-- 1. Discover and drop the existing FK (if any).
--    MySQL auto-generates FK names such as "audit_logs_ibfk_1"; we drop by
--    the conventional name used in init_db.sql.  If your schema uses a
--    different name, replace the constraint name below.
--    The IF-guard avoids an error when the FK was never created (e.g. fresh
--    SQLAlchemy-managed deployments that never ran init_db.sql directly).

SET @fk_exists = (
    SELECT COUNT(*)
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME        = 'audit_logs'
      AND CONSTRAINT_NAME   = 'fk_audit_logs_user_id'
      AND CONSTRAINT_TYPE   = 'FOREIGN KEY'
);

-- Also probe the legacy auto-named FK used before this migration
SET @fk_legacy = (
    SELECT COUNT(*)
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME        = 'audit_logs'
      AND CONSTRAINT_NAME   = 'audit_logs_ibfk_1'
      AND CONSTRAINT_TYPE   = 'FOREIGN KEY'
);

-- Drop whichever FK exists (only one should; both guards are safe to run)
SET @drop_named  = IF(@fk_exists > 0,
    'ALTER TABLE audit_logs DROP FOREIGN KEY fk_audit_logs_user_id',
    'SELECT 1');
SET @drop_legacy = IF(@fk_legacy > 0,
    'ALTER TABLE audit_logs DROP FOREIGN KEY audit_logs_ibfk_1',
    'SELECT 1');

PREPARE stmt FROM @drop_named;  EXECUTE stmt; DEALLOCATE PREPARE stmt;
PREPARE stmt FROM @drop_legacy; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Add the new FK with ON DELETE SET NULL
--    (user_id is already nullable=True in the table DDL)
ALTER TABLE audit_logs
    ADD CONSTRAINT fk_audit_logs_user_id
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- ── DOWNGRADE ────────────────────────────────────────────────────────────────
-- To roll back: drop the new FK and re-add the plain FK (no cascade action).
-- This restores RESTRICT behaviour, which will error if referenced users still
-- have audit_log rows (ensure no user deletion has occurred since upgrade, or
-- first null-out user_id manually).
--
-- ROLLBACK SCRIPT (do not run during upgrade):
-- ─────────────────────────────────────────────
-- ALTER TABLE audit_logs DROP FOREIGN KEY fk_audit_logs_user_id;
-- ALTER TABLE audit_logs
--     ADD CONSTRAINT fk_audit_logs_user_id
--         FOREIGN KEY (user_id) REFERENCES users(id);
-- ─────────────────────────────────────────────────────────────────────────────

-- Verify
SELECT
    kcu.CONSTRAINT_NAME,
    kcu.COLUMN_NAME,
    kcu.REFERENCED_TABLE_NAME,
    kcu.REFERENCED_COLUMN_NAME,
    rc.DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE kcu
JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON  rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
    AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
WHERE kcu.TABLE_SCHEMA  = DATABASE()
  AND kcu.TABLE_NAME    = 'audit_logs'
  AND kcu.COLUMN_NAME   = 'user_id';
-- Expected: DELETE_RULE = 'SET NULL'
