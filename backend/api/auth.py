"""
/api/auth  —  登录 / 刷新 / 登出 / 修改密码
"""
from datetime import datetime
from flask import Blueprint, request, jsonify
from flask_jwt_extended import (
    create_access_token, create_refresh_token,
    jwt_required, get_jwt_identity, get_jwt,
)
from werkzeug.security import generate_password_hash, check_password_hash
from extensions import db
from models.models import User

auth_bp = Blueprint("auth", __name__)

# ── 辅助 ────────────────────────────────────────────────────────────────────

def _get_or_create_default_admin():
    """首次启动自动创建 admin / admin123"""
    u = User.query.filter_by(username="admin").first()
    if not u:
        u = User(
            username="admin",
            password_hash=generate_password_hash("admin123"),
            role="admin",
        )
        db.session.add(u)
        db.session.commit()
    return u


# ── 路由 ────────────────────────────────────────────────────────────────────

@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not username or not password:
        return jsonify(msg="用户名和密码不能为空"), 400

    _get_or_create_default_admin()
    user = User.query.filter_by(username=username).first()

    if not user or not check_password_hash(user.password_hash, password):
        return jsonify(msg="用户名或密码错误"), 401

    user.last_login = datetime.utcnow()
    db.session.commit()

    access  = create_access_token(identity=str(user.id),
                                   additional_claims={"role": user.role})
    refresh = create_refresh_token(identity=str(user.id))

    return jsonify(
        access_token=access,
        refresh_token=refresh,
        user=user.to_dict(),
    )


@auth_bp.post("/refresh")
@jwt_required(refresh=True)
def refresh():
    uid     = get_jwt_identity()
    user    = User.query.get(int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    access  = create_access_token(identity=uid,
                                   additional_claims={"role": user.role})
    return jsonify(access_token=access)


@auth_bp.get("/me")
@jwt_required()
def me():
    uid  = get_jwt_identity()
    user = User.query.get(int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    return jsonify(user=user.to_dict())


@auth_bp.post("/change-password")
@jwt_required()
def change_password():
    uid  = get_jwt_identity()
    user = User.query.get(int(uid))
    data = request.get_json(silent=True) or {}
    old  = data.get("old_password", "")
    new  = data.get("new_password", "")

    if not check_password_hash(user.password_hash, old):
        return jsonify(msg="原密码错误"), 400
    if len(new) < 6:
        return jsonify(msg="新密码至少 6 位"), 400

    user.password_hash = generate_password_hash(new)
    db.session.commit()
    return jsonify(msg="密码已更新")
