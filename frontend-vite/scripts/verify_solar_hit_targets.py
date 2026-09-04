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
            totals = {n:{'center':[0,0], 'target':[0,0]} for n in LABELS}; failures=[]
            for _ in range(260):
                rows = await js("""(()=>{const s=window.__DBG__.solarSystem,r=s.canvas.getBoundingClientRect(),es=s.hitButtons.find(e=>e.mesh===s.earth),ms=s.hitButtons.find(e=>e.mesh===s.moon),ep=es.mesh.getWorldPosition(es.mesh.position.clone()).project(s.camera),mp=ms.mesh.getWorldPosition(ms.mesh.position.clone()).project(s.camera),rawGap=Math.hypot((ep.x-mp.x)*r.width*.5,(ep.y-mp.y)*r.height*.5);return Array.from(document.querySelectorAll('button.solar-system-hit')).map(el=>{const label=el.getAttribute('aria-label'),entry=s.hitButtons.find(e=>e.el===el),p=entry.mesh.getWorldPosition(entry.mesh.position.clone()).project(s.camera),tx=r.left+(p.x*.5+.5)*r.width,ty=r.top+(-p.y*.5+.5)*r.height,br=el.getBoundingClientRect(),cx=br.left+br.width/2,cy=br.top+br.height/2,ch=document.elementFromPoint(cx,cy),th=document.elementFromPoint(tx,ty);return [label,ch===el,th===el,getComputedStyle(el).visibility,cx,cy,tx,ty,ch&& (ch.getAttribute('aria-label')||ch.tagName),th&& (th.getAttribute('aria-label')||th.tagName),Math.hypot(cx-tx,cy-ty),rawGap,br.width,br.height]})})()""") or []
                for label,center_hit,target_hit,vis,cx,cy,tx,ty,owner,target_owner,drift,raw_gap,w,h in rows:
                    if label in totals:
                        totals[label]['center'][1]+=1; totals[label]['center'][0]+=int(center_hit and vis=='visible')
                        totals[label]['target'][1]+=1; totals[label]['target'][0]+=int(target_hit and vis=='visible')
                        if not (center_hit and vis=='visible'): failures.append((label,'center',owner,w,h))
                        if not (target_hit and vis=='visible'): failures.append((label,'target',target_owner,drift,raw_gap,w,h))
                await asyncio.sleep(.08)
            return totals, failures
    finally:
        chrome.terminate(); chrome.wait(3); shutil.rmtree(profile, ignore_errors=True); httpd.shutdown()

async def main():
    for w,h in [(1400,913),(900,800),(760,900),(480,850)]:
        result, failures = await run_viewport(w,h)
        print(f'{w}x{h}: ' + ', '.join(f'{k} center {v["center"][0]/max(1,v["center"][1]):.3%}, target {v["target"][0]/max(1,v["target"][1]):.3%}' for k,v in result.items()))
        if failures: print('  failures:', failures[:3])
        assert all(v['center'][0]/max(1,v['center'][1]) >= .995 for v in result.values()), f'{w}x{h}: button-center hit ratio below 99.5%'
        assert all(v['target'][0]/max(1,v['target'][1]) >= .995 for k,v in result.items() if k != LABELS[0]), f'{w}x{h}: user-target hit ratio below 99.5%; failures={failures[:3]}'
        assert result[LABELS[0]]['target'][0]/max(1,result[LABELS[0]]['target'][1]) >= 1.0, f'{w}x{h}: sun target hit ratio below 100%; failures={failures[:3]}'
asyncio.run(main())
