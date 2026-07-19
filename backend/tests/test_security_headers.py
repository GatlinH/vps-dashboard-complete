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