from sqlalchemy import text
from app import create_app
from extensions import db

app = create_app()
DDL = {
    'name': "ALTER TABLE alert_rules ADD COLUMN name VARCHAR(128) NOT NULL DEFAULT '' AFTER server_id",
    'notify_repeat': "ALTER TABLE alert_rules ADD COLUMN notify_repeat TINYINT(1) NOT NULL DEFAULT 1 AFTER cool_down_s",
    'target_chat_id': "ALTER TABLE alert_rules ADD COLUMN target_chat_id VARCHAR(64) NOT NULL DEFAULT '' AFTER notify_repeat",
    'note': "ALTER TABLE alert_rules ADD COLUMN note TEXT NULL AFTER target_chat_id",
}

with app.app_context():
    existing = {
        row[0] for row in db.session.execute(text(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules'"
        ))
    }
    for col, ddl in DDL.items():
        if col not in existing:
            db.session.execute(text(ddl))
    db.session.commit()
    cols = [
        row[0] for row in db.session.execute(text(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' ORDER BY ORDINAL_POSITION"
        ))
    ]
    print(cols)
