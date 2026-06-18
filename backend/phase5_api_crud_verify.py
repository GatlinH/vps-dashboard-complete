from app import create_app
from models.models import User
from flask_jwt_extended import create_access_token
import json

app = create_app()
with app.app_context():
    u = User.query.filter_by(username='admin').first()
    token = create_access_token(identity=str(u.id), additional_claims={'role': u.role, 'username': u.username})

client = app.test_client()
headers = {'Authorization': f'Bearer {token}'}

resp = client.get('/api/v1/telegram/alerts', headers=headers)
print('LIST1', resp.status_code, sorted((resp.json or {}).keys()))

payload = {
    'name': 'phase5-latency-test',
    'rule_type': 'latency',
    'threshold': 180,
    'cool_down_s': 600,
    'server_id': 8,
    'target_chat_id': '',
    'note': 'phase5 test rule',
    'enabled': True,
    'notify_repeat': False,
}
resp = client.post('/api/v1/telegram/alerts/rule', headers=headers, json=payload)
print('CREATE', resp.status_code, json.dumps(resp.json, ensure_ascii=False))
rule_id = resp.json['rule']['id']

resp = client.put(f'/api/v1/telegram/alerts/{rule_id}', headers=headers, json={'threshold': 220, 'note': 'phase5 updated'})
print('UPDATE', resp.status_code, json.dumps(resp.json, ensure_ascii=False))

resp = client.post(f'/api/v1/telegram/alerts/{rule_id}/toggle', headers=headers, json={'enabled': False})
print('TOGGLE', resp.status_code, json.dumps(resp.json, ensure_ascii=False))

resp = client.delete(f'/api/v1/telegram/alerts/{rule_id}', headers=headers)
print('DELETE', resp.status_code, json.dumps(resp.json, ensure_ascii=False))

resp = client.get('/api/v1/telegram/alerts', headers=headers)
print('LIST2', resp.status_code, 'rules=', len((resp.json or {}).get('rules', [])), 'types=', (resp.json or {}).get('rule_types'))
