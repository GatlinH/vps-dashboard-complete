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

def test_csp_allows_inline_style_attributes_for_progress_bars(client):
    # Progress-bar fills render via inline `style="width:X%"`. A nonce on
    # style-src makes style-src-attr inherit the nonce and strip those
    # attributes, saturating every meter to 100%. style-src-attr must
    # explicitly allow inline style attributes while <style> elements keep
    # nonce protection through style-src.
    response = client.get('/health')

    csp = response.headers['Content-Security-Policy']
    directives = csp.split('; ')

    style_src = next(d for d in directives if d.startswith('style-src '))
    style_src_attr = next(
        (d for d in directives if d.startswith('style-src-attr ')), None
    )

    assert style_src_attr is not None, 'style-src-attr must be present'
    assert "'unsafe-inline'" in style_src_attr
    # <style>/<link> elements must still be nonce-governed, not unsafe-inline.
    assert re.search(r"'nonce-[A-Za-z0-9_-]{32}'", style_src)
    assert "'unsafe-inline'" not in style_src


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
