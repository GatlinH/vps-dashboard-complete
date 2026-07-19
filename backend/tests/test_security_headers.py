import re


def test_csp_allows_cesium_eval_while_retaining_script_self_and_nonce(client):
    response = client.get('/health')

    csp = response.headers['Content-Security-Policy']
    script_src = next(
        directive for directive in csp.split('; ')
        if directive.startswith('script-src ')
    )

    assert "'self'" in script_src
    assert "'unsafe-eval'" in script_src
    assert re.search(r"'nonce-[A-Za-z0-9_-]{32}'", script_src)
    assert "'unsafe-inline'" not in script_src

def test_csp_connect_src_preserves_existing_sources_and_allows_jsdelivr(client):
    response = client.get('/health')

    csp = response.headers['Content-Security-Policy']
    connect_src = next(
        directive for directive in csp.split('; ')
        if directive.startswith('connect-src ')
    )

    assert "'self'" in connect_src
    assert 'https://api.telegram.org' in connect_src
    assert 'https://ip-api.com' in connect_src
    assert 'https://cdn.jsdelivr.net' in connect_src
    assert 'https://services.arcgisonline.com' in connect_src
    assert '*' not in connect_src
