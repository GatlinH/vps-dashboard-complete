#!/usr/bin/env python3
import asyncio, json, os, shutil, socket, subprocess, tempfile, time
from pathlib import Path
import websockets

ROOT = Path(__file__).resolve().parents[2]; DIST = ROOT / 'frontend-dist'
async def run_viewport(width, height):
    profile = tempfile.mkdtemp(prefix='solar-hit-'); sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    chrome = subprocess.Popen(['chromium','--headless=new',f'--remote-debugging-port={port}',f'--user-data-dir={profile}','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',f'--window-size={width},{height}','about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        async with websockets.connect(f'ws://127.0.0.1:{port}/devtools/browser', max_size=None) as ws:
            i=0
            async def cdp(method, params={}):
                nonlocal i; i+=1; await ws.send(json.dumps({'id':i,'method':method,'params':params}))
                while True:
                    m=json.loads(await asyncio.wait_for(ws.recv(),25))
                    if m.get('id')==i: return m.get('result',{})
            targets=(await cdp('Target.getTargets'))['targetInfos']; page=next(t for t in targets if t['type']=='page')
            s=(await cdp('Target.attachToTarget',{'targetId':page['targetId'],'flatten':True}))['sessionId']
            async def js(expr):
                r=await cdp('Runtime.evaluate',{'expression':expr,'returnByValue':True,'awaitPromise':True,'userGesture':True,'contextId':None}); return r.get('result',{}).get('value')
            await cdp('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':False},); await cdp('Page.navigate',{'url':'http://127.0.0.1:4173'}); await asyncio.sleep(8)
            await js("window.__DBG__.solarSystem.bodies.forEach(b=>b.speed*=8)")
            totals={n:[0,0] for n in ('太阳（前往登录）','地球（进入三维地球）','月球（进入总览）')}
            for _ in range(260):
                rows=await js("""(()=>Array.from(document.querySelectorAll('button.solar-system-hit')).map(el=>{let r=el.getBoundingClientRect(),h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return [el.getAttribute('aria-label'),h===el,getComputedStyle(el).visibility]}))()""") or []
                for label,hit,vis in rows:
                    if label in totals: totals[label][1]+=1; totals[label][0]+=int(hit and vis=='visible')
                await asyncio.sleep(.08)
            return totals
    finally:
        chrome.terminate()
        try: chrome.wait(3)
        except subprocess.TimeoutExpired: chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)

async def main():
    for w,h in [(1400,913),(900,800),(760,900),(480,850)]:
        result=await run_viewport(w,h); print(f'{w}x{h}: ' + ', '.join(f'{k} {v[0]/max(1,v[1]):.3%}' for k,v in result.items()))
        assert all(v[0]/max(1,v[1]) >= .995 for v in result.values())
asyncio.run(main())
