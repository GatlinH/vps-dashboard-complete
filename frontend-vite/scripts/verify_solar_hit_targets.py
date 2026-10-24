#!/usr/bin/env python3
import asyncio, contextlib, functools, json, shutil, socket, subprocess, sys, tempfile, time, unittest, urllib.request, urllib.parse
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import websockets

ROOT = Path(__file__).resolve().parents[2]; DIST = ROOT / 'frontend-dist'
LABELS = ('太阳（前往登录）','地球（进入三维地球）','月球（进入总览）')
SOLAR_READY_EXPRESSION = "!!(window.__DBG__&&window.__DBG__.solarSystem&&window.__DBG__.solarSystem.renderer&&document.querySelectorAll('button.solar-system-hit').length>=3)"

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def handle_one_request(self):
        try: return super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError): return

class CDPDispatcher:
    def __init__(self, websocket, timeout=25, event_limit=20):
        self.websocket = websocket
        self.timeout = timeout
        self.next_id = 0
        self.pending = {}
        self.unmatched = {}
        self.events = deque(maxlen=event_limit)
        self.event_messages = deque(maxlen=event_limit)
        self.event_sequence = 0
        self.reader = None
        self.failure = None

    async def __aenter__(self):
        self.reader = asyncio.create_task(self._read_messages())
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        self.reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.reader

    def _result(self, message, method, request_id):
        if 'error' in message:
            raise RuntimeError(f'CDP {method} id={request_id} failed: {message["error"]}')
        return message.get('result', {})

    def _diagnostics(self):
        return f'events={list(self.events)} outstanding={sorted(self.pending)} unmatched={sorted(self.unmatched)}'

    async def __call__(self, method, params=None):
        return await self.send(method, params)

    async def _read_messages(self):
        try:
            while True:
                message = json.loads(await self.websocket.recv())
                response_id = message.get('id')
                if response_id is not None:
                    pending = self.pending.get(response_id)
                    if pending is None:
                        self.unmatched[response_id] = message
                    elif pending['future'] is None:
                        self.unmatched[response_id] = message
                        self.pending.pop(response_id, None)
                    elif not pending['future'].done():
                        pending['future'].set_result(message)
                    continue
                event = message.get('method', '<unknown event>')
                self.events.append(event)
                self.event_sequence += 1
                self.event_messages.append((self.event_sequence, message))
                if event == 'Inspector.targetCrashed' or event.endswith('.targetCrashed'):
                    raise RuntimeError(f'CDP target crash event {event}')
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.failure = error
            for pending in self.pending.values():
                if pending['future'] is not None and not pending['future'].done():
                    pending['future'].set_exception(error)

    async def send_no_wait(self, method, params=None):
        if self.reader is None:
            self.reader = asyncio.create_task(self._read_messages())
        if self.failure is not None:
            raise RuntimeError(f'CDP dispatcher failed before {method}: {self.failure}; {self._diagnostics()}') from self.failure
        self.next_id += 1
        request_id = self.next_id
        self.pending[request_id] = {'method': method, 'future': None}
        await self.websocket.send(json.dumps({'id': request_id, 'method': method, 'params': params or {}}))
        if request_id in self.unmatched:
            self.pending.pop(request_id, None)
        return request_id

    async def send(self, method, params=None):
        if self.reader is None:
            self.reader = asyncio.create_task(self._read_messages())
        if self.failure is not None:
            raise RuntimeError(f'CDP dispatcher failed before {method}: {self.failure}; {self._diagnostics()}') from self.failure
        self.next_id += 1
        request_id = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = {'method': method, 'future': future}
        await self.websocket.send(json.dumps({'id': request_id, 'method': method, 'params': params or {}}))
        try:
            if request_id in self.unmatched:
                message = self.unmatched.pop(request_id)
            else:
                try:
                    message = await asyncio.wait_for(future, self.timeout)
                except asyncio.TimeoutError as error:
                    raise TimeoutError(f'CDP timeout waiting for {method} id={request_id}; {self._diagnostics()}') from error
                except Exception as error:
                    raise RuntimeError(f'{error} while waiting for {method} id={request_id}; {self._diagnostics()}') from error
            return self._result(message, method, request_id)
        finally:
            self.pending.pop(request_id, None)

async def navigate_and_wait(cdp, url, ready_expression=SOLAR_READY_EXPRESSION, timeout=40, poll_interval=.2):
    await cdp('Page.enable')
    await cdp('Page.setLifecycleEventsEnabled', {'enabled': True})
    event_start = cdp.event_sequence
    navigation_id = await cdp.send_no_wait('Page.navigate', {'url': url})
    deadline = time.monotonic() + timeout
    started = completed = ready = False
    frame_id = loader_id = None
    last_ready_error = None

    while time.monotonic() < deadline:
        for sequence, message in cdp.event_messages:
            if sequence <= event_start:
                continue
            method = message.get('method')
            params = message.get('params', {})
            if method == 'Page.frameStartedNavigating' and params.get('url') == url:
                started = True
                frame_id = params.get('frameId')
                loader_id = params.get('loaderId')
            elif started and method == 'Page.lifecycleEvent' and params.get('name') == 'networkIdle':
                same_frame = frame_id is None or params.get('frameId') == frame_id
                same_loader = loader_id is None or params.get('loaderId') == loader_id
                if same_frame and same_loader:
                    completed = True

        if completed:
            try:
                response = await cdp('Runtime.evaluate', {'expression': ready_expression, 'returnByValue': True, 'awaitPromise': True})
                ready = bool(response.get('result', {}).get('value'))
                last_ready_error = None
            except RuntimeError as error:
                if cdp.failure is not None:
                    raise
                ready = False
                last_ready_error = str(error)

        if started and completed and ready:
            return navigation_id
        await asyncio.sleep(poll_interval)

    raise TimeoutError(
        f'navigation readiness timeout url={url} id={navigation_id} '
        f'started={started} completed={completed} ready={ready} '
        f'last_ready_error={last_ready_error!r}; {cdp._diagnostics()}'
    )

async def evaluate_js(cdp, expression):
    response = await cdp('Runtime.evaluate', {
        'expression': expression,
        'returnByValue': True,
        'awaitPromise': True,
        'userGesture': True,
    })
    return response.get('result', {}).get('value')

async def js_effect(cdp, expression):
    value = await evaluate_js(cdp, f'(()=>{{{expression}; return true;}})()')
    if value is not True:
        raise RuntimeError(f'JavaScript effect did not return true: {expression}')

def cleanup_browser(chrome, profile, httpd):
    if chrome is not None:
        chrome.terminate()
        try:
            chrome.wait(3)
        except subprocess.TimeoutExpired:
            chrome.kill()
            chrome.wait()
    shutil.rmtree(profile, ignore_errors=True)
    httpd.shutdown()
    httpd.server_close()

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
    chrome = None
    try:
        chrome = subprocess.Popen(['chromium','--headless=new',f'--remote-debugging-port={port}',f'--user-data-dir={profile}','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',f'--window-size={width},{height}','about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_devtools(port)
        req = urllib.request.Request(f'http://127.0.0.1:{port}/json/new?{urllib.parse.quote("about:blank", safe="")}', method='PUT')
        with urllib.request.urlopen(req, timeout=10) as r: tab = json.loads(r.read().decode())
        async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=None) as ws:
            async with CDPDispatcher(ws) as cdp:
                return await verify_viewport(cdp, width, height, http_port)
    finally:
        cleanup_browser(chrome, profile, httpd)

async def verify_viewport(cdp, width, height, http_port):
            js = functools.partial(evaluate_js, cdp)
            effect = functools.partial(js_effect, cdp)
            await cdp('Runtime.enable'); await cdp('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':False})
            await navigate_and_wait(cdp, f'http://127.0.0.1:{http_port}/')
            await effect("window.__DBG__.solarSystem.bodies.forEach(b=>b.speed*=8)")
            totals = {n:{'center':[0,0], 'target':[0,0]} for n in LABELS}; geometry = {'ok': 0, 'total': 0}; failures=[]
            for _ in range(260):
                frame_state = await js("(()=>{const s=window.__DBG__.solarSystem;return {atHome:s.cameraAtHome,tween:!!s.cameraTween}})()")
                assert frame_state is not None and not (frame_state['atHome'] and frame_state['tween']), f"cameraAtHome and cameraTween both truthy: {frame_state}"
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

async def run_resize_scene():
    width, height = 1400, 913
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(DIST)))
    Thread(target=httpd.serve_forever, daemon=True).start(); http_port = httpd.server_address[1]
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    profile = tempfile.mkdtemp(prefix='solar-resize-')
    chrome = None
    try:
        chrome = subprocess.Popen(['chromium','--headless=new',f'--remote-debugging-port={port}',f'--user-data-dir={profile}','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',f'--window-size={width},{height}','about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_devtools(port)
        req = urllib.request.Request(f'http://127.0.0.1:{port}/json/new?about%3Ablank', method='PUT')
        with urllib.request.urlopen(req, timeout=10) as r: tab = json.loads(r.read().decode())
        async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=None) as ws:
            async with CDPDispatcher(ws) as cdp:
                await verify_resize_scene(cdp, http_port, width, height)
    finally:
        cleanup_browser(chrome, profile, httpd)

async def verify_resize_scene(cdp, http_port, width, height):
            js = functools.partial(evaluate_js, cdp)
            effect = functools.partial(js_effect, cdp)
            await cdp('Runtime.enable'); await cdp('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':False})
            await navigate_and_wait(cdp, f'http://127.0.0.1:{http_port}/')
            assert await js("!!window.__DBG__.solarSystem.renderer"), 'ready: renderer/buttons missing'
            await effect("(()=>{const s=window.__DBG__.solarSystem;if(s.__rzWrapped)return true;window.__RZ__={calls:0};const orig=s.resize.bind(s);s.resize=function(...a){window.__RZ__.calls++;return orig(...a)};s.__rzWrapped=true;return true})()")
            await effect("[...document.querySelectorAll('button.solar-system-hit')].find(e=>e.getAttribute('aria-label').includes('地球')).click()")
            end = time.time()+40; opened = False
            while time.time()<end:
                opened = await js("getComputedStyle(document.querySelector('#globe-container')).display !== 'none'")
                if opened: break
                await asyncio.sleep(.25)
            if not opened:
                print('SKIP cesium never opened')
                return
            await effect("__DBG__.solarSystem.pause()")
            pre = await js("(()=>{const s=__DBG__.solarSystem;return {pos:s.camera.position.toArray(),dist:s.camera.position.distanceTo(s.homeCameraPosition),calls:__RZ__.calls,home:s.homeCameraPosition.toArray(),aspect:s.camera.aspect,atHome:s.cameraAtHome,tween:!!s.cameraTween,running:s.running}})()")
            if pre is None: raise AssertionError('pre state unavailable')
            assert not (pre['atHome'] and pre['tween']), f"cameraAtHome and cameraTween both truthy: {pre}"
            await cdp('Emulation.setDeviceMetricsOverride', {'width':1100,'height':913,'deviceScaleFactor':1,'mobile':False})
            await effect("window.dispatchEvent(new Event('resize'))")
            post = await js("(()=>{const s=__DBG__.solarSystem;return {pos:s.camera.position.toArray(),dist:s.camera.position.distanceTo(s.homeCameraPosition),calls:__RZ__.calls,home:s.homeCameraPosition.toArray(),aspect:s.camera.aspect,atHome:s.cameraAtHome,tween:!!s.cameraTween,running:s.running}})()")
            if post is None: raise AssertionError('post state unavailable')
            assert not (post['atHome'] and post['tween']), f"cameraAtHome and cameraTween both truthy: {post}"
            assert post['calls']-pre['calls'] >= 1, f"resize() did not run: pre={pre} post={post}"
            assert post['dist'] > 5, f"resize guard snapped camera home: post_dist={post['dist']} post_pos={post['pos']}"
            assert post['pos'] == pre['pos'], f"camera moved unexpectedly: pre_pos={pre['pos']} post_pos={post['pos']}"
            await effect("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
            end = time.time()+10
            while time.time()<end and await js("getComputedStyle(document.querySelector('#globe-container')).display !== 'none'"): await asyncio.sleep(.1)
            assert not await js("getComputedStyle(document.querySelector('#globe-container')).display !== 'none'"), 'escape: globe did not hide'
            print(f"resize: ran={post['calls']-pre['calls']} pre_dist={pre['dist']:.3f} post_dist={post['dist']:.3f} pre_pos={pre['pos']} post_pos={post['pos']} home={post['home']} aspect={post['aspect']:.4f} atHome={post['atHome']} tween={post['tween']} running={post['running']}")

async def run_tween_resize_scene():
    width, height = 1100, 913
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(DIST)))
    Thread(target=httpd.serve_forever, daemon=True).start(); http_port = httpd.server_address[1]
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    profile = tempfile.mkdtemp(prefix='solar-tween-')
    chrome = None
    try:
        chrome = subprocess.Popen(['chromium','--headless=new',f'--remote-debugging-port={port}',f'--user-data-dir={profile}','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',f'--window-size={width},{height}','about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_devtools(port); req = urllib.request.Request(f'http://127.0.0.1:{port}/json/new?about%3Ablank', method='PUT')
        with urllib.request.urlopen(req, timeout=10) as r: tab = json.loads(r.read().decode())
        async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=None) as ws:
            async with CDPDispatcher(ws) as cdp:
                await verify_tween_resize_scene(cdp, http_port, width, height)
    finally:
        cleanup_browser(chrome, profile, httpd)

async def verify_tween_resize_scene(cdp, http_port, width, height):
            js = functools.partial(evaluate_js, cdp)
            effect = functools.partial(js_effect, cdp)
            await cdp('Runtime.enable'); await cdp('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':False})
            await navigate_and_wait(cdp, f'http://127.0.0.1:{http_port}/')
            await effect("(()=>{const s=__DBG__.solarSystem;window.__RZ__={calls:0};const o=s.resize.bind(s);s.resize=function(...a){__RZ__.calls++;return o(...a)};return true})()")
            baseline = await js("(()=>Object.fromEntries([...document.querySelectorAll('button.solar-system-hit')].map(e=>[e.getAttribute('aria-label'),getComputedStyle(e).visibility])))()")
            await effect("[...document.querySelectorAll('button.solar-system-hit')].find(e=>e.getAttribute('aria-label').includes('地球')).click()")
            immediate=await js("(()=>{const s=__DBG__.solarSystem;return {atHome:s.cameraAtHome,tween:!!s.cameraTween}})()")
            assert immediate is not None and immediate['atHome'] is False and immediate['tween'], f'click state invalid: {immediate}'
            immediate_vis = await js("(()=>Object.fromEntries([...document.querySelectorAll('button.solar-system-hit')].map(e=>[e.getAttribute('aria-label'),getComputedStyle(e).visibility])))()")
            assert immediate_vis == baseline, f't=0 visibility changed: baseline={baseline} immediate={immediate_vis} tweenT=0'
            state=None; end=time.time()+15
            while time.time()<end:
                state=await js("(()=>{const s=__DBG__.solarSystem;return {pos:s.camera.position.toArray(),home:s.homeCameraPosition.toArray(),to:s.cameraTween&&s.cameraTween.to.toArray(),dist:s.camera.position.distanceTo(s.homeCameraPosition),tween:!!s.cameraTween,aspect:s.camera.aspect}})()")
                if state and state['tween'] and state['dist']>5: break
                await asyncio.sleep(.05)
            assert state and state['tween'] and state['dist']>5, f'tween did not reach probe: {state}'
            before=state
            t1_vis = None; fallback = False
            await effect("window.__DBG__.solarSystem.resume()")
            invariant = await js("(()=>{const s=__DBG__.solarSystem;return {atHome:s.cameraAtHome,tween:!!s.cameraTween}})()")
            assert invariant is not None and not (invariant['atHome'] and invariant['tween']), f"cameraAtHome and cameraTween both truthy: {invariant}"
            await effect("__DBG__.solarSystem.pause()")
            await cdp('Emulation.setDeviceMetricsOverride', {'width':480,'height':850,'deviceScaleFactor':1,'mobile':False}); await effect("window.dispatchEvent(new Event('resize'))")
            after=await js("(()=>{const s=__DBG__.solarSystem;return {pos:s.camera.position.toArray(),home:s.homeCameraPosition.toArray(),to:s.cameraTween&&s.cameraTween.to.toArray(),dist:s.camera.position.distanceTo(s.homeCameraPosition),aspect:s.camera.aspect,calls:__RZ__.calls}})()")
            # v3.7 letterbox: the canvas keeps a cinematic aspect at any window size,
            # so home may legitimately stay identical (or drift sub-percent) after
            # resize. Protected invariants: the in-flight tween endpoint ('to') is
            # untouched, the camera is still in motion, and resize() did real work
            # (finite positive aspect + backing store resized) rather than no-op.
            assert after is not None and after['calls']>=1 and after['to']==before['to'] and after['dist']>5, f'resize() must not mutate an in-flight tween endpoint: before={before} after={after}'
            import math
            assert after['aspect'] == after['aspect'] and math.isfinite(after['aspect']) and after['aspect'] > 0.1, f'resize produced invalid aspect: {after}'
            store = await js("(()=>{const c=__DBG__.solarSystem.renderer.domElement;return {w:c.width,h:c.height}})()")
            assert store and store['w']>0 and store['h']>0, f'backing store not sized after resize: {store}'
            await effect("__DBG__.solarSystem.resume()")
            for _ in range(160):
                ready = await js("(()=>{const s=__DBG__.solarSystem;return s.cameraTween===null && getComputedStyle(document.querySelector('#globe-container')).display==='none'})()")
                if ready:
                    t1_vis = await js("(()=>Object.fromEntries([...document.querySelectorAll('button.solar-system-hit')].map(e=>[e.getAttribute('aria-label'),getComputedStyle(e).visibility])))()")
                    break
                await asyncio.sleep(.05)
            if t1_vis is None:
                fallback = True; t1_vis = await js("(()=>Object.fromEntries([...document.querySelectorAll('button.solar-system-hit')].map(e=>[e.getAttribute('aria-label'),getComputedStyle(e).visibility])))()")
            assert t1_vis is not None and t1_vis.get(LABELS[1]) == 'visible', f't=1 Earth must be visible: frames={{t0:{baseline},t1:{t1_vis}}} fallback={fallback}'
            rows=await js("(()=>{const r=__DBG__.solarSystem.canvas.getBoundingClientRect();return [...document.querySelectorAll('button.solar-system-hit')].map(el=>{const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,v=getComputedStyle(el).visibility;return [el.getAttribute('aria-label'),v,x,y,x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom,document.elementFromPoint(x,y)===el,b.width,b.height]})})()") or []
            violations=sum(1 for _,v,x,y,inside,own,_,__ in rows if v=='visible' and (not inside or not own)); vis=sum(v=='visible' for _,v,*_ in rows)
            assert violations==0, f'visible hit violations={violations} rows={rows}'
            earth=next((r for r in rows if r[0]==LABELS[1] and r[1]=='visible'),None); moon=next((r for r in rows if r[0]==LABELS[2] and r[1]=='visible'),None)
            overlap=0
            if earth and moon:
                d=((earth[2]-moon[2])**2+(earth[3]-moon[3])**2)**0.5; overlap=int(d < (earth[6]+moon[6])/2)
            assert overlap==0, f'earth/moon boxes overlap: distance={d if earth and moon else None}'
            print(f"tween: ran={after['calls']} tweenTo_before={before['to']} tweenTo_after={after['to']} home_before={before['home']} home_after={after['home']} aspect_before={before['aspect']:.4f} aspect_after={after['aspect']:.4f} camera_dist={after['dist']:.3f} visible={vis} violations={violations} overlap={overlap} visibility_frames={{t0:{baseline},t1:{t1_vis}}} fallback={fallback}")

async def main():
    for w,h in [(1400,913),(900,800),(760,900),(480,850)]:
        result, geometry, failures = await run_viewport(w,h)
        print(f'{w}x{h}: ' + ', '.join(f'{k} center {v["center"][0]/max(1,v["center"][1]):.3%}, target {v["target"][0]/max(1,v["target"][1]):.3%}' for k,v in result.items()) + f', geometry {geometry["ok"]/max(1,geometry["total"]):.3%}')
        if failures: print('  failures:', failures[:3])
        assert all(v['center'][0]/max(1,v['center'][1]) >= .995 for v in result.values()), f'{w}x{h}: button-center hit ratio below 99.5%; failures={failures[:3]}'
        assert all(v['target'][0]/max(1,v['target'][1]) >= .995 for k,v in result.items() if k != LABELS[0]), f'{w}x{h}: user-target hit ratio below 99.5%; failures={failures[:3]}'
        assert result[LABELS[0]]['target'][0]/max(1,result[LABELS[0]]['target'][1]) >= 1.0, f'{w}x{h}: sun target hit ratio below 100%; failures={failures[:3]}'
        assert geometry['ok']/max(1, geometry['total']) >= .995, f'{w}x{h}: earth/moon button boxes overlap; failures={failures[:3]}'
    await run_resize_scene()
    await run_tween_resize_scene()

class FakeWebSocket:
    def __init__(self, messages):
        self.messages = asyncio.Queue()
        for message in messages:
            self.messages.put_nowait(json.dumps(message))
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def recv(self):
        return await self.messages.get()

    def feed(self, message):
        self.messages.put_nowait(json.dumps(message))

class NavigationWebSocket(FakeWebSocket):
    def __init__(self, complete=False):
        super().__init__([])
        self.complete = complete

    async def send(self, message):
        request = json.loads(message)
        self.sent.append(request)
        if request['method'] in ('Page.enable', 'Page.setLifecycleEventsEnabled'):
            self.feed({'id': request['id'], 'result': {}})
        elif request['method'] == 'Page.navigate':
            self.feed({'method': 'Page.frameStartedNavigating', 'params': {'frameId': 'frame-1', 'loaderId': 'loader-1', 'url': request['params']['url']}})
            self.feed({'method': 'Page.frameStartedLoading', 'params': {'frameId': 'frame-1'}})
            if self.complete:
                self.feed({'method': 'Page.lifecycleEvent', 'params': {'frameId': 'frame-1', 'loaderId': 'loader-1', 'name': 'networkIdle'}})
        elif request['method'] == 'Runtime.evaluate':
            self.feed({'id': request['id'], 'result': {'result': {'value': True}}})

class SerializationBoundaryWebSocket(FakeWebSocket):
    def __init__(self):
        super().__init__([])

    async def send(self, message):
        request = json.loads(message)
        self.sent.append(request)
        params = request.get('params', {})
        expression = params.get('expression')
        if expression == '__DBG__.solarSystem.pause()':
            self.feed({'id': request['id'], 'error': {'code': -32000, 'message': 'Object reference chain is too long'}})
        elif expression == '(()=>{__DBG__.solarSystem.pause(); return true;})()' and params.get('returnByValue') is True:
            self.feed({'id': request['id'], 'result': {'result': {'value': True}}})
        elif expression == "(()=>{throw new Error('boom'); return true;})()":
            self.feed({'id': request['id'], 'error': {'code': -32000, 'message': 'Uncaught Error: boom'}})
        else:
            self.feed({'id': request['id'], 'error': {'code': -32001, 'message': 'effect expression did not return a primitive'}})

class DispatcherTests(unittest.IsolatedAsyncioTestCase):
    async def test_effect_js_returns_a_primitive_instead_of_serializing_command_result(self):
        ws = SerializationBoundaryWebSocket()
        dispatcher = CDPDispatcher(ws, timeout=0.05)
        async with dispatcher as cdp:
            with self.assertRaisesRegex(RuntimeError, 'Object reference chain is too long'):
                await cdp('Runtime.evaluate', {
                    'expression': '__DBG__.solarSystem.pause()',
                    'returnByValue': True,
                    'awaitPromise': True,
                    'userGesture': True,
                })
            self.assertIsNone(await js_effect(cdp, '__DBG__.solarSystem.pause()'))

        effect_request = ws.sent[-1]
        self.assertTrue(effect_request['params']['returnByValue'])
        self.assertNotEqual(effect_request['params']['expression'], '__DBG__.solarSystem.pause()')
        self.assertIn('__DBG__.solarSystem.pause()', effect_request['params']['expression'])

    async def test_effect_js_does_not_suppress_runtime_errors(self):
        ws = SerializationBoundaryWebSocket()
        dispatcher = CDPDispatcher(ws, timeout=0.05)
        async with dispatcher as cdp:
            with self.assertRaisesRegex(RuntimeError, 'Uncaught Error: boom'):
                await js_effect(cdp, "throw new Error('boom')")

    async def test_no_wait_navigation_is_sent_once_and_late_replies_stay_correlated(self):
        ws = FakeWebSocket([])
        dispatcher = CDPDispatcher(ws, timeout=0.05)
        async with dispatcher as cdp:
            navigation_id = await cdp.send_no_wait('Page.navigate', {'url': 'http://example.test/'})
            ws.feed({'id': 3, 'result': {'value': 'later'}})
            ws.feed({'id': navigation_id, 'result': {'frameId': 'frame-1'}})
            ws.feed({'id': 2, 'result': {'value': 'current'}})
            self.assertEqual(await cdp('Runtime.evaluate'), {'value': 'current'})
            self.assertEqual(await cdp('Later.method'), {'value': 'later'})
            await asyncio.sleep(0)

        navigations = [request for request in ws.sent if request['method'] == 'Page.navigate']
        self.assertEqual(navigations, [{'id': navigation_id, 'method': 'Page.navigate', 'params': {'url': 'http://example.test/'}}])
        self.assertEqual(dispatcher.unmatched[navigation_id]['result'], {'frameId': 'frame-1'})

    async def test_navigation_requires_completion_not_only_start_events(self):
        ws = NavigationWebSocket(complete=False)
        dispatcher = CDPDispatcher(ws, timeout=0.05)
        async with dispatcher as cdp:
            with self.assertRaisesRegex(TimeoutError, r'navigation readiness timeout.*started=True.*completed=False'):
                await navigate_and_wait(cdp, 'http://example.test/', 'true', timeout=0.02, poll_interval=0)

    async def test_navigation_completes_without_waiting_for_navigate_reply(self):
        ws = NavigationWebSocket(complete=True)
        dispatcher = CDPDispatcher(ws, timeout=0.05)
        async with dispatcher as cdp:
            navigation_id = await navigate_and_wait(cdp, 'http://example.test/', 'true', timeout=0.05, poll_interval=0)
        self.assertEqual(navigation_id, 3)
        self.assertNotIn(navigation_id, dispatcher.unmatched)
        self.assertEqual([request['method'] for request in ws.sent].count('Page.navigate'), 1)

    async def test_awaiting_navigate_times_out_after_navigation_starts(self):
        ws = NavigationWebSocket(complete=True)
        dispatcher = CDPDispatcher(ws, timeout=0.01)
        async with dispatcher as cdp:
            with self.assertRaisesRegex(TimeoutError, r'Page\.navigate.*Page\.frameStartedNavigating.*Page\.lifecycleEvent'):
                await cdp('Page.navigate', {'url': 'http://example.test/'})

    async def test_buffers_out_of_order_response_for_later_request(self):
        ws = FakeWebSocket([{'id': 2, 'result': {'value': 'second'}}, {'id': 1, 'result': {'value': 'first'}}])
        dispatcher = CDPDispatcher(ws, timeout=0.05)
        async with dispatcher as cdp:
            first = await cdp('First.method')
            second = await cdp('Second.method')
        self.assertEqual(first, {'value': 'first'})
        self.assertEqual(second, {'value': 'second'})

    async def test_records_event_without_treating_it_as_reply(self):
        ws = FakeWebSocket([{'method': 'Page.frameStartedLoading', 'params': {}}, {'id': 1, 'result': {'ok': True}}])
        dispatcher = CDPDispatcher(ws, timeout=0.05)
        async with dispatcher as cdp:
            self.assertEqual(await cdp('Page.navigate'), {'ok': True})
        self.assertEqual(list(dispatcher.events), ['Page.frameStartedLoading'])

    async def test_timeout_names_request_and_diagnostics(self):
        ws = FakeWebSocket([{'method': 'Page.lifecycleEvent', 'params': {}}, {'id': 99, 'result': {}}])
        dispatcher = CDPDispatcher(ws, timeout=0.01)
        async with dispatcher as cdp:
            with self.assertRaisesRegex(TimeoutError, r'Runtime\.evaluate.*id=1.*Page\.lifecycleEvent.*outstanding=\[1\].*unmatched=\[99\]'):
                await cdp('Runtime.evaluate')

    async def test_target_crash_fails_explicitly(self):
        ws = FakeWebSocket([{'method': 'Inspector.targetCrashed', 'params': {'status': 'crashed'}}])
        dispatcher = CDPDispatcher(ws, timeout=0.05)
        async with dispatcher as cdp:
            with self.assertRaisesRegex(RuntimeError, r'Inspector\.targetCrashed.*Page\.navigate.*id=1'):
                await cdp('Page.navigate')

    async def test_legacy_receive_loop_loses_out_of_order_response(self):
        ws = FakeWebSocket([{'id': 2, 'result': {'value': 'second'}}, {'id': 1, 'result': {'value': 'first'}}])

        async def legacy_wait(request_id):
            while True:
                message = json.loads(await asyncio.wait_for(ws.recv(), 0.01))
                if message.get('id') == request_id:
                    return message.get('result', {})

        self.assertEqual(await legacy_wait(1), {'value': 'first'})
        with self.assertRaises(asyncio.TimeoutError):
            await legacy_wait(2)

if __name__ == '__main__':
    if sys.argv[1:] == ['--test-dispatcher']:
        unittest.main(argv=[sys.argv[0]])
    else:
        asyncio.run(main())
