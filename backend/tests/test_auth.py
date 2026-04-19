"""认证 API 测试（登录/刷新/登出/改密）。"""


class TestLogin:
    def test_login_success(self, client):
        res = client.post('/api/v1/auth/login', json={'username': 'admin', 'password': 'TestAdmin@123456'})
        assert res.status_code == 200
        body = res.get_json()
        assert 'access_token' in body
        assert 'refresh_token' in body

    def test_login_wrong_password(self, client):
        res = client.post('/api/v1/auth/login', json={'username': 'admin', 'password': 'wrong'})
        assert res.status_code == 401

    def test_login_missing_fields(self, client):
        res = client.post('/api/v1/auth/login', json={'username': 'admin'})
        assert res.status_code == 400


class TestRefresh:
    def test_refresh_success(self, client):
        login_res = client.post('/api/v1/auth/login', json={'username': 'admin', 'password': 'TestAdmin@123456'})
        refresh_token = login_res.get_json()['refresh_token']
        res = client.post('/api/v1/auth/refresh', headers={'Authorization': f'Bearer {refresh_token}'})
        assert res.status_code == 200
        assert 'access_token' in res.get_json()

    def test_refresh_old_token_rejected_after_rotation(self, client):
        login_res = client.post('/api/v1/auth/login', json={'username': 'admin', 'password': 'TestAdmin@123456'})
        old_refresh = login_res.get_json()['refresh_token']
        assert client.post('/api/v1/auth/refresh', headers={'Authorization': f'Bearer {old_refresh}'}).status_code == 200
        assert client.post('/api/v1/auth/refresh', headers={'Authorization': f'Bearer {old_refresh}'}).status_code == 401


class TestLogoutAndPassword:
    def test_logout_revokes_access_token(self, client, auth_headers):
        assert client.post('/api/v1/auth/logout', headers=auth_headers).status_code == 200
        assert client.get('/api/v1/servers/', headers=auth_headers).status_code == 401

    def test_change_password_success(self, client, auth_headers):
        new_password = 'NewPass@789xyz!'
        res = client.post('/api/v1/auth/change-password', headers=auth_headers, json={
            'old_password': 'Password@123456',
            'new_password': new_password,
        })
        assert res.status_code == 200

        login_res = client.post('/api/v1/auth/login', json={'username': 'testuser', 'password': new_password})
        assert login_res.status_code == 200

    def test_change_password_wrong_old_password(self, client, auth_headers):
        res = client.post('/api/v1/auth/change-password', headers=auth_headers, json={
            'old_password': 'bad-old',
            'new_password': 'StrongPass@1234!'
        })
        assert res.status_code == 400
