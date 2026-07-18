"""Server-group domain helpers shared by startup and server writes."""
import re

from extensions import db
from models.models import Server, ServerGroup
from utils.errors import ValidationError

DEFAULT_GROUP_NAME = "默认分组"
_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def normalize_group_name(value):
    name = " ".join(str(value or "").split())
    if not name or len(name) > 64:
        raise ValidationError("分组名称不能为空且最多 64 个字符", field="name")
    return name


def normalize_group_fields(data, existing=None):
    name = normalize_group_name(data["name"] if "name" in data else existing.name)
    purpose = str(data.get("purpose", existing.purpose if existing else "") or "").strip()
    color = str(data.get("color", existing.color if existing else "") or "").strip()
    try:
        sort_order = int(data.get("sort_order", existing.sort_order if existing else 0))
    except (TypeError, ValueError):
        raise ValidationError("sort_order 必须是整数", field="sort_order")
    if len(purpose) > 160:
        raise ValidationError("purpose 最多 160 个字符", field="purpose")
    if color and not _COLOR_RE.fullmatch(color):
        raise ValidationError("color 必须为 #RRGGBB 或为空", field="color")
    return name, purpose, color, sort_order


def find_group_by_name(name):
    normalized = normalize_group_name(name)
    return ServerGroup.query.filter(db.func.lower(ServerGroup.name) == normalized.lower()).first()


def get_or_create_legacy_group(name):
    normalized = normalize_group_name(name)
    group = find_group_by_name(normalized)
    if group is None:
        group = ServerGroup(name=normalized)
        db.session.add(group)
        db.session.flush()
    return group


def assign_server_group(server, data):
    if "group_id" in data and data["group_id"] not in (None, ""):
        try:
            group_id = int(data["group_id"])
        except (TypeError, ValueError):
            raise ValidationError("group_id 必须是整数", field="group_id")
        group = db.session.get(ServerGroup, group_id)
        if group is None:
            raise ValidationError("group_id 不存在", field="group_id")
    elif "group" in data or "group_name" in data:
        group = get_or_create_legacy_group(data.get("group") or data.get("group_name"))
    else:
        group = get_or_create_legacy_group(DEFAULT_GROUP_NAME)
    server.group = group
    server.group_name = group.name


def backfill_server_groups():
    """Idempotently create groups for legacy values and connect legacy rows."""
    get_or_create_legacy_group(DEFAULT_GROUP_NAME)
    for server in Server.query.order_by(Server.id).all():
        if server.group_id:
            if server.group:
                server.group_name = server.group.name
            continue
        raw_name = str(server.group_name or "").strip() or DEFAULT_GROUP_NAME
        group = get_or_create_legacy_group(raw_name)
        server.group = group
        server.group_name = group.name
    db.session.commit()
