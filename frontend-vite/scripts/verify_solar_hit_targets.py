#!/usr/bin/env python3
import asyncio, functools, json, shutil, socket, subprocess, tempfile, time, urllib.request, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import websockets

ROOT = Path(__file__).resolve().parents[2]; DIST = ROOT / 'frontend-dist'
LABELS = ('太阳（前往登录）','地球（进入三维地球）','月球（进入总览）')

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def handle_one_request(self):
        try: return super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError): return

def wait_devtools(port):
    end = time.time() + 30
    while time.time() < end:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=1.5) as r:
                return json.loads(r.read().decode())
        except Exception: time.sleep(.3)
    raise RuntimeError('DevTools did not become ready')

async def run_viewport(width, height):
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(DIST)))
    Thread(target=httpd.serve_forever, daemon=True).start()
    http_port = httpd.server_address[1]
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    profile = tempfile.mkdtemp(prefix='solar-hit-')
    chrome = subprocess.Popen(['chromium','--headless=new',f'--remote-debugging-port={port}',f'--user-data-dir={profile}','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',f'--window-size={width},{height}','about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_devtools(port)
        req = urllib.request.Request(f'http://127.0.0.1:{port}/json/new?{urllib.parse.quote("about:blank", safe="")}', method='PUT')
        with urllib.request.urlopen(req, timeout=10) as r: tab = json.loads(r.read().decode())
        async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=None) as ws:
            i = 0
            async def cdp(method, params=None):
                nonlocal i; i += 1; await ws.send(json.dumps({'id':i,'method':method,'params':params or {}}))
                while True:
                    m = json.loads(await asyncio.wait_for(ws.recv(),25))
                    if m.get('id') == i: return m.get('result', {})
            async def js(expr):
                r = await cdp('Runtime.evaluate', {'expression':expr,'returnByValue':True,'awaitPromise':True,'userGesture':True})
                return r.get('result',{}).get('value')
            await cdp('Runtime.enable'); await cdp('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':False})
            await cdp('Page.navigate', {'url':f'http://127.0.0.1:{http_port}/'})
            end = time.time() + 40
            while time.time() < end:
                ready = await js("!!(window.__DBG__&&window.__DBG__.solarSystem&&window.__DBG__.solarSystem.renderer&&document.querySelectorAll('button.solar-system-hit').length>=3)")
                if ready: break
                await asyncio.sleep(.25)
            await js("window.__DBG__.solarSystem.bodies.forEach(b=>b.speed*=8)")
            totals = {n:[0,0] for n in LABELS}; failures=[]
            for _ in range(260):
                rows = await js("""(()=>Array.from(document.querySelectorAll('button.solar-system-hit')).map(el=>{let r=el.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,h=document.elementFromPoint(cx,cy);return [el.getAttribute('aria-label'),h===el,getComputedStyle(el).visibility,cx,cy,h&&h.getAttribute('aria-label'),r.width,r.height]}))()""") or []
                for label,hit,vis,cx,cy,owner,w,h in rows:
                    if label in totals:
                        totals[label][1]+=1; totals[label][0]+=int(hit and vis=='visible')
                        if not (hit and vis=='visible'): failures.append((label,cx,cy,owner,w,h))
                await asyncio.sleep(.08)
            return totals, failures
    finally:
        chrome.terminate(); chrome.wait(3); shutil.rmtree(profile, ignore_errors=True); httpd.shutdown()

async def main():
    for w,h in [(1400,913),(900,800),(760,900),(480,850)]:
        result, failures = await run_viewport(w,h)
        print(f'{w}x{h}: ' + ', '.join(f'{k} {v[0]/max(1,v[1]):.3%}' for k,v in result.items()))
        if failures: print('  failures:', failures[:3])
        assert all(v[0]/max(1,v[1]) >= .995 for v in result.values())
asyncio.run(main())
