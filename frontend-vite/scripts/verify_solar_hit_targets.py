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
            totals = {n:{'center':[0,0], 'target':[0,0]} for n in LABELS}; geometry = {'ok': 0, 'total': 0}; failures=[]
            for _ in range(260):
                rows = await js("""(()=>{const s=window.__DBG__.solarSystem,r=s.canvas.getBoundingClientRect(),es=s.hitButtons.find(e=>e.mesh===s.earth),ms=s.hitButtons.find(e=>e.mesh===s.moon),ep=es.mesh.getWorldPosition(es.mesh.position.clone()).project(s.camera),mp=ms.mesh.getWorldPosition(ms.mesh.position.clone()).project(s.camera),rawGap=Math.hypot((ep.x-mp.x)*r.width*.5,(ep.y-mp.y)*r.height*.5);return Array.from(document.querySelectorAll('button.solar-system-hit')).map(el=>{const label=el.getAttribute('aria-label'),entry=s.hitButtons.find(e=>e.el===el),p=entry.mesh.getWorldPosition(entry.mesh.position.clone()).project(s.camera),tx=r.left+(p.x*.5+.5)*r.width,ty=r.top+(-p.y*.5+.5)*r.height,br=el.getBoundingClientRect(),cx=br.left+br.width/2,cy=br.top+br.height/2,ch=document.elementFromPoint(cx,cy),th=document.elementFromPoint(tx,ty);return [label,ch===el,th===el,getComputedStyle(el).visibility,cx,cy,tx,ty,ch&& (ch.getAttribute('aria-label')||ch.tagName),th&& (th.getAttribute('aria-label')||th.tagName),Math.hypot(cx-tx,cy-ty),rawGap,br.width,br.height]})})()""") or []
                for label,center_hit,target_hit,vis,cx,cy,tx,ty,owner,target_owner,drift,raw_gap,w,h in rows:
                    if label in totals:
                        totals[label]['center'][1]+=1; totals[label]['center'][0]+=int(center_hit and vis=='visible')
                        totals[label]['target'][1]+=1; totals[label]['target'][0]+=int(target_hit and vis=='visible')
                        if not (center_hit and vis=='visible'): failures.append((label,'center',owner,w,h))
                        if not (target_hit and vis=='visible'): failures.append((label,'target',target_owner,drift,raw_gap,w,h))
                earth = next((row for row in rows if row[0] == LABELS[1]), None)
                moon = next((row for row in rows if row[0] == LABELS[2]), None)
                if earth and moon and earth[3] == 'visible' and moon[3] == 'visible':
                    geometry['total'] += 1
                    distance = ((earth[4] - moon[4]) ** 2 + (earth[5] - moon[5]) ** 2) ** 0.5
                    required = (earth[12] + moon[12]) * 0.5
                    if distance >= required:
                        geometry['ok'] += 1
                    else:
                        failures.append(('geometry', distance, required, earth[12], moon[12], earth[11], moon[11], (earth[4], earth[5]), (moon[4], moon[5])))
                await asyncio.sleep(.08)
            return totals, geometry, failures
    finally:
        chrome.terminate()
        try:
            chrome.wait(3)
        except subprocess.TimeoutExpired:
            chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)
        httpd.shutdown()
        httpd.server_close()

async def run_resize_scene():
    width, height = 1400, 913
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(DIST)))
    Thread(target=httpd.serve_forever, daemon=True).start(); http_port = httpd.server_address[1]
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    profile = tempfile.mkdtemp(prefix='solar-resize-')
    chrome = subprocess.Popen(['chromium','--headless=new',f'--remote-debugging-port={port}',f'--user-data-dir={profile}','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',f'--window-size={width},{height}','about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_devtools(port)
        req = urllib.request.Request(f'http://127.0.0.1:{port}/json/new?about%3Ablank', method='PUT')
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
            end = time.time()+40
            while time.time()<end and not await js("!!(window.__DBG__&&window.__DBG__.solarSystem&&window.__DBG__.solarSystem.renderer&&document.querySelectorAll('button.solar-system-hit').length>=3)"): await asyncio.sleep(.2)
            assert await js("!!window.__DBG__.solarSystem.renderer"), 'ready: renderer/buttons missing'
            await js("[...document.querySelectorAll('button.solar-system-hit')].find(e=>e.getAttribute('aria-label').includes('地球')).click()")
            tween = await js("!!window.__DBG__.solarSystem.cameraTween")
            assert tween, 'tween-start: cameraTween already ended'
            await cdp('Emulation.setDeviceMetricsOverride', {'width':1100,'height':913,'deviceScaleFactor':1,'mobile':False})
            mid = await js("(()=>{const s=__DBG__.solarSystem,d=s.camera.position.distanceTo(s.homeCameraPosition);return {d,pos:s.camera.position.toArray(),home:s.homeCameraPosition.toArray()}})()")
            assert mid['d'] > 1, f"resize-during-tween: cameraAtHome={await js('!!__DBG__.solarSystem.cameraAtHome')} pos={mid['pos']} home={mid['home']} distance={mid['d']}"
            end = time.time()+20
            while time.time()<end and not await js("!!__DBG__.solarSystem.cameraAtHome"): await asyncio.sleep(.1)
            assert await js("getComputedStyle(document.querySelector('#globe-container')).display !== 'none'"), 'cesium: globe not visible'
            await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
            end = time.time()+10
            while time.time()<end and await js("getComputedStyle(document.querySelector('#globe-container')).display !== 'none'"): await asyncio.sleep(.1)
            assert not await js("getComputedStyle(document.querySelector('#globe-container')).display !== 'none'"), 'escape: globe did not hide'
            await js("__DBG__.solarSystem.pause()")  # freeze rAF so stale view matrices cannot be masked by a refresh frame
            await cdp('Emulation.setDeviceMetricsOverride', {'width':900,'height':800,'deviceScaleFactor':1,'mobile':False})
            final = await js("(()=>{const s=__DBG__.solarSystem,r=s.canvas.getBoundingClientRect(),e=s.hitButtons.find(x=>x.mesh===s.earth),v=e.mesh.getWorldPosition(new THREE.Vector3()).project(s.camera),x=r.left+(v.x*.5+.5)*r.width,y=r.top+(-v.y*.5+.5)*r.height,b=e.el.getBoundingClientRect(),cx=b.left+b.width/2,cy=b.top+b.height/2;return {pos:s.camera.position.toArray(),home:s.homeCameraPosition.toArray(),distance:s.camera.position.distanceTo(s.homeCameraPosition),cameraAtHome:s.cameraAtHome,actual:[cx,cy],expected:[x,y],delta:Math.hypot(cx-x,cy-y)}})()")
            assert final['distance'] < .01 and final['cameraAtHome'], f"resize-at-home: cameraAtHome={final['cameraAtHome']} pos={final['pos']} home={final['home']} distance={final['distance']} actual={final['actual']} expected={final['expected']} delta={final['delta']}"
            assert final['delta'] < 2, f"resize-projection: cameraAtHome={final['cameraAtHome']} pos={final['pos']} home={final['home']} distance={final['distance']} actual={final['actual']} expected={final['expected']} delta={final['delta']}"
            print(f"resize: mid distance={mid['d']} pos={mid['pos']} home={mid['home']}; final cameraAtHome={final['cameraAtHome']} pos={final['pos']} home={final['home']} distance={final['distance']} actual={final['actual']} expected={final['expected']} delta={final['delta']}")
    finally:
        chrome.terminate()
        try: chrome.wait(3)
        except subprocess.TimeoutExpired: chrome.kill()
        shutil.rmtree(profile, ignore_errors=True); httpd.shutdown(); httpd.server_close()

async def main():
    for w,h in [(1400,913),(900,800),(760,900),(480,850)]:
        result, geometry, failures = await run_viewport(w,h)
        print(f'{w}x{h}: ' + ', '.join(f'{k} center {v["center"][0]/max(1,v["center"][1]):.3%}, target {v["target"][0]/max(1,v["target"][1]):.3%}' for k,v in result.items()) + f', geometry {geometry["ok"]/max(1,geometry["total"]):.3%}')
        if failures: print('  failures:', failures[:3])
        assert all(v['center'][0]/max(1,v['center'][1]) >= .995 for v in result.values()), f'{w}x{h}: button-center hit ratio below 99.5%'
        assert all(v['target'][0]/max(1,v['target'][1]) >= .995 for k,v in result.items() if k != LABELS[0]), f'{w}x{h}: user-target hit ratio below 99.5%; failures={failures[:3]}'
        assert result[LABELS[0]]['target'][0]/max(1,result[LABELS[0]]['target'][1]) >= 1.0, f'{w}x{h}: sun target hit ratio below 100%; failures={failures[:3]}'
        assert geometry['ok']/max(1, geometry['total']) >= .995, f'{w}x{h}: earth/moon button boxes overlap; failures={failures[:3]}'
    await run_resize_scene()
asyncio.run(main())
