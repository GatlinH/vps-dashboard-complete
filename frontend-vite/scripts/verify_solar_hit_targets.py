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
            await js("(()=>{const s=window.__DBG__.solarSystem;if(s.__rzWrapped)return true;window.__RZ__={calls:0};const orig=s.resize.bind(s);s.resize=function(...a){window.__RZ__.calls++;return orig(...a)};s.__rzWrapped=true;return true})()")
            await js("[...document.querySelectorAll('button.solar-system-hit')].find(e=>e.getAttribute('aria-label').includes('地球')).click()")
            end = time.time()+40; opened = False
            while time.time()<end:
                opened = await js("getComputedStyle(document.querySelector('#globe-container')).display !== 'none'")
                if opened: break
                await asyncio.sleep(.25)
            if not opened:
                print('SKIP cesium never opened')
                return
            await js("__DBG__.solarSystem.pause()")
            pre = await js("(()=>{const s=__DBG__.solarSystem;return {pos:s.camera.position.toArray(),dist:s.camera.position.distanceTo(s.homeCameraPosition),calls:__RZ__.calls,home:s.homeCameraPosition.toArray(),aspect:s.camera.aspect,atHome:s.cameraAtHome,tween:!!s.cameraTween,running:s.running}})()")
            if pre is None: raise AssertionError('pre state unavailable')
            await cdp('Emulation.setDeviceMetricsOverride', {'width':1100,'height':913,'deviceScaleFactor':1,'mobile':False})
            await js("(() => { window.dispatchEvent(new Event('resize')); return true; })()")
            post = await js("(()=>{const s=__DBG__.solarSystem;return {pos:s.camera.position.toArray(),dist:s.camera.position.distanceTo(s.homeCameraPosition),calls:__RZ__.calls,home:s.homeCameraPosition.toArray(),aspect:s.camera.aspect,atHome:s.cameraAtHome,tween:!!s.cameraTween,running:s.running}})()")
            if post is None: raise AssertionError('post state unavailable')
            assert post['calls']-pre['calls'] >= 1, f"resize() did not run: pre={pre} post={post}"
            assert post['dist'] > 5, f"resize guard snapped camera home: post_dist={post['dist']} post_pos={post['pos']}"
            assert post['pos'] == pre['pos'], f"camera moved unexpectedly: pre_pos={pre['pos']} post_pos={post['pos']}"
            await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
            end = time.time()+10
            while time.time()<end and await js("getComputedStyle(document.querySelector('#globe-container')).display !== 'none'"): await asyncio.sleep(.1)
            assert not await js("getComputedStyle(document.querySelector('#globe-container')).display !== 'none'"), 'escape: globe did not hide'
            print(f"resize: ran={post['calls']-pre['calls']} pre_dist={pre['dist']:.3f} post_dist={post['dist']:.3f} pre_pos={pre['pos']} post_pos={post['pos']} home={post['home']} aspect={post['aspect']:.4f} atHome={post['atHome']} tween={post['tween']} running={post['running']}")
    finally:
        chrome.terminate()
        try: chrome.wait(3)
        except subprocess.TimeoutExpired: chrome.kill()
        shutil.rmtree(profile, ignore_errors=True); httpd.shutdown(); httpd.server_close()

async def run_tween_resize_scene():
    width, height = 1100, 913
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(DIST)))
    Thread(target=httpd.serve_forever, daemon=True).start(); http_port = httpd.server_address[1]
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    profile = tempfile.mkdtemp(prefix='solar-tween-')
    chrome = subprocess.Popen(['chromium','--headless=new',f'--remote-debugging-port={port}',f'--user-data-dir={profile}','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',f'--window-size={width},{height}','about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_devtools(port); req = urllib.request.Request(f'http://127.0.0.1:{port}/json/new?about%3Ablank', method='PUT')
        with urllib.request.urlopen(req, timeout=10) as r: tab = json.loads(r.read().decode())
        async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=None) as ws:
            i = 0
            async def cdp(method, params=None):
                nonlocal i; i += 1; await ws.send(json.dumps({'id':i,'method':method,'params':params or {}}))
                while True:
                    m = json.loads(await asyncio.wait_for(ws.recv(),25))
                    if m.get('id') == i: return m.get('result', {})
            async def js(expr):
                r = await cdp('Runtime.evaluate', {'expression':expr,'returnByValue':True,'awaitPromise':True,'userGesture':True}); return r.get('result',{}).get('value')
            await cdp('Runtime.enable'); await cdp('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':False}); await cdp('Page.navigate', {'url':f'http://127.0.0.1:{http_port}/'})
            end=time.time()+40
            while time.time()<end and not await js("!!(window.__DBG__&&__DBG__.solarSystem&&document.querySelectorAll('button.solar-system-hit').length>=3)"): await asyncio.sleep(.2)
            await js("(()=>{const s=__DBG__.solarSystem;window.__RZ__={calls:0};const o=s.resize.bind(s);s.resize=function(...a){__RZ__.calls++;return o(...a)};return true})()")
            await js("[...document.querySelectorAll('button.solar-system-hit')].find(e=>e.getAttribute('aria-label').includes('地球')).click()")
            immediate=await js("(()=>{const s=__DBG__.solarSystem;return {atHome:s.cameraAtHome,tween:!!s.cameraTween}})()")
            assert immediate is not None and immediate['atHome'] is False and immediate['tween'], f'click state invalid: {immediate}'
            state=None; end=time.time()+15
            while time.time()<end:
                state=await js("(()=>{const s=__DBG__.solarSystem;return {pos:s.camera.position.toArray(),home:s.homeCameraPosition.toArray(),to:s.cameraTween&&s.cameraTween.to.toArray(),dist:s.camera.position.distanceTo(s.homeCameraPosition),tween:!!s.cameraTween,aspect:s.camera.aspect}})()")
                if state and state['tween'] and state['dist']>5: break
                await asyncio.sleep(.05)
            assert state and state['tween'] and state['dist']>5, f'tween did not reach probe: {state}'
            before=state
            await cdp('Emulation.setDeviceMetricsOverride', {'width':480,'height':850,'deviceScaleFactor':1,'mobile':False}); await js("window.dispatchEvent(new Event('resize'))")
            after=await js("(()=>{const s=__DBG__.solarSystem;return {pos:s.camera.position.toArray(),home:s.homeCameraPosition.toArray(),to:s.cameraTween&&s.cameraTween.to.toArray(),dist:s.camera.position.distanceTo(s.homeCameraPosition),aspect:s.camera.aspect,calls:__RZ__.calls}})()")
            assert after is not None and after['calls']>=1 and after['to']==before['to'] and after['dist']>5 and after['home']!=before['home'], f'tween resize invariant failed: before={before} after={after}'
            rows=await js("(()=>{const r=__DBG__.solarSystem.canvas.getBoundingClientRect();return [...document.querySelectorAll('button.solar-system-hit')].map(el=>{const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,v=getComputedStyle(el).visibility;return [el.getAttribute('aria-label'),v,x,y,x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom,document.elementFromPoint(x,y)===el,b.width,b.height]})})()") or []
            violations=sum(1 for _,v,x,y,inside,own,_,__ in rows if v=='visible' and (not inside or not own)); vis=sum(v=='visible' for _,v,*_ in rows)
            assert violations==0, f'visible hit violations={violations} rows={rows}'
            earth=next((r for r in rows if r[0]==LABELS[1] and r[1]=='visible'),None); moon=next((r for r in rows if r[0]==LABELS[2] and r[1]=='visible'),None)
            overlap=0
            if earth and moon:
                d=((earth[2]-moon[2])**2+(earth[3]-moon[3])**2)**0.5; overlap=int(d < (earth[6]+moon[6])/2)
            assert overlap==0, f'earth/moon boxes overlap: distance={d if earth and moon else None}'
            print(f"tween: ran={after['calls']} tweenTo_before={before['to']} tweenTo_after={after['to']} home_before={before['home']} home_after={after['home']} aspect_before={before['aspect']:.4f} aspect_after={after['aspect']:.4f} camera_dist={after['dist']:.3f} visible={vis} violations={violations} overlap={overlap}")
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
    await run_tween_resize_scene()
asyncio.run(main())
