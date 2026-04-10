"""
utils/logging_config.py — 结构化日志配置

生产环境输出 JSON 格式，便于 ELK/Loki 采集；
开发环境输出可读的文本格式。
"""
import logging
import json
import os
from datetime import datetime, timezone


class JsonFormatter(logging.Formatter):
    """生产环境 JSON 结构化日志，便于 ELK/Loki 采集"""
    def format(self, record):
        log_data = {
            "time": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "line": record.lineno,
        }
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_data, ensure_ascii=False)


def setup_logging(app):
    """根据环境选择日志格式：生产用 JSON，开发用普通文本"""
    flask_env = os.getenv("FLASK_ENV", "development")
    log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
    log_level = getattr(logging, log_level_str, logging.INFO)

    handler = logging.StreamHandler()
    if flask_env == "production":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter(
            '[%(asctime)s] %(levelname)s in %(module)s: %(message)s'
        ))

    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers = [handler]

    # 抑制第三方库的冗余日志
    for noisy in ("apscheduler", "werkzeug", "sqlalchemy.engine"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
