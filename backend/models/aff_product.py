from datetime import datetime
from extensions import db


class AffProduct(db.Model):
    __tablename__ = "aff_products"
    id = db.Column(db.Integer, primary_key=True)
    provider = db.Column(db.String(128), nullable=False, index=True)
    stock = db.Column(db.String(16), default="avail", index=True)
    cpu = db.Column(db.String(32), default="")
    ram = db.Column(db.String(32), default="")
    disk = db.Column(db.String(32), default="")
    bandwidth = db.Column(db.String(64), default="")
    location = db.Column(db.String(128), default="")
    price = db.Column(db.Float, default=0)
    currency = db.Column(db.String(8), default="CNY")
    period = db.Column(db.String(16), default="monthly")
    buy_url = db.Column(db.String(512), default="")
    review_url = db.Column(db.String(512), default="")
    note = db.Column(db.Text, default="")
    sort_order = db.Column(db.Integer, default=100, index=True)
    enabled = db.Column(db.Boolean, default=True, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return dict(
            id=self.id,
            provider=self.provider,
            stock=self.stock,
            cpu=self.cpu,
            ram=self.ram,
            disk=self.disk,
            bandwidth=self.bandwidth,
            location=self.location,
            price=self.price,
            currency=self.currency,
            period=self.period,
            buy_url=self.buy_url,
            review_url=self.review_url,
            note=self.note,
            sort_order=self.sort_order,
            enabled=self.enabled,
            created_at=self.created_at.isoformat(),
        )
