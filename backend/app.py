"""
VPS 星图 · Flask 后端入口
"""
from flask import Flask
from flask_cors import CORS
from extensions import db, redis_client, jwt
from api.servers   import servers_bp
from api.auth      import auth_bp
from api.probe     import probe_bp
from api.telegram  import telegram_bp
from api.geo       import geo_bp
from api.traffic   import traffic_bp
from config import Config

def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    # Extensions
    db.init_app(app)
    CORS(app, origins=app.config["CORS_ORIGINS"], supports_credentials=True)
    jwt.init_app(app)

    # Blueprints
    app.register_blueprint(auth_bp,     url_prefix="/api/auth")
    app.register_blueprint(servers_bp,  url_prefix="/api/servers")
    app.register_blueprint(probe_bp,    url_prefix="/api/probe")
    app.register_blueprint(telegram_bp, url_prefix="/api/telegram")
    app.register_blueprint(geo_bp,      url_prefix="/api/geo")
    app.register_blueprint(traffic_bp,  url_prefix="/api/traffic")

    with app.app_context():
        db.create_all()

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=True)
