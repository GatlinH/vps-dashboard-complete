from pathlib import Path

from models.models import AgentSecurityAggregate, OpsEvent


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'scripts' / 'migrations' / '20260823_agent_security_aggregates.sql'


def test_migration_is_rerunnable_without_swallowing_ddl_errors():
    sql = MIGRATION.read_text(encoding='utf-8')
    assert 'CREATE TABLE IF NOT EXISTS agent_security_aggregates' in sql
    assert "information_schema.columns" in sql
    assert "column_name = 'classification'" in sql
    assert "information_schema.statistics" in sql
    assert "index_name = 'ix_ops_events_classification'" in sql
    assert 'DECLARE CONTINUE HANDLER' not in sql
    assert 'CALL migrate_agent_security_aggregates()' in sql
    assert 'DROP PROCEDURE migrate_agent_security_aggregates' in sql


def test_migration_schema_matches_models_and_production_ordering():
    sql = MIGRATION.read_text(encoding='utf-8').lower()
    for column in AgentSecurityAggregate.__table__.columns:
        assert column.name.lower() in sql
    assert OpsEvent.__table__.c.classification.name in sql

    app_source = (ROOT / 'app.py').read_text(encoding='utf-8')
    assert 'if os.getenv("FLASK_ENV") != "production":' in app_source
    assert 'db.create_all()' in app_source
    assert 'Run before deploying the application code' in MIGRATION.read_text(encoding='utf-8')
