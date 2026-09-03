import * as THREE from 'three';

export class SolarSystem {
  constructor(containerSelectorOrElement, { onEarthClick, onSunClick, onMoonClick } = {}) {
    this.container = typeof containerSelectorOrElement === 'string' ? document.querySelector(containerSelectorOrElement) : containerSelectorOrElement;
    this.callbacks = { onEarthClick, onSunClick, onMoonClick }; this.running = false; this.earthZooming = false;
    if (!this.container) return;
    this.container.style.position = this.container.style.position || 'relative';
    try {
      const mobile = window.matchMedia?.('(max-width: 720px)').matches;
      this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(45, 1, .1, 100); this.camera.position.set(0, 5, 13);
      this.renderer = new THREE.WebGLRenderer({ antialias: !mobile, alpha: true }); this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1 : 2)); this.container.appendChild(this.renderer.domElement);
      this.scene.add(new THREE.AmbientLight(0x334455, .25), new THREE.PointLight(0xffd27a, 3.2, 40));
      const starCount = mobile ? 180 : 700; const starGeo = new THREE.BufferGeometry(); const pos = new Float32Array(starCount * 3); for (let i=0;i<pos.length;i++) pos[i]=(Math.random()-.5)*70; starGeo.setAttribute('position', new THREE.BufferAttribute(pos,3)); this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({color:0xaecbff,size:.06})); this.scene.add(this.stars);
      this.sun = new THREE.Mesh(new THREE.SphereGeometry(1.15,24,16), new THREE.MeshBasicMaterial({color:0xffc34d})); this.scene.add(this.sun);
      const defs = [{name:'水星',radius:.16,orbit:2.1,speed:1.2,color:0x9b8b7a},{name:'金星',radius:.27,orbit:3,speed:.8,color:0xd8a15b},{name:'地球',radius:.42,orbit:4,speed:.55,color:0x3d8edb},{name:'火星',radius:.3,orbit:5.1,speed:.4,color:0xc85d45}];
      this.bodies = defs.slice(0, mobile ? 3 : defs.length).map((d,i)=>{ const mesh=new THREE.Mesh(new THREE.SphereGeometry(d.radius,18,12),new THREE.MeshStandardMaterial({color:d.color,roughness:.8})); mesh.angle=i*.9; mesh.userData={...d}; this.scene.add(mesh); const curve=new THREE.EllipseCurve(0,0,d.orbit,d.orbit,0,Math.PI*2,false,0); const pts=curve.getPoints(96).map(p=>new THREE.Vector3(p.x,0,p.y)); const line=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:0x6688aa,transparent:true,opacity:.28})); this.scene.add(line); return mesh; });
      this.earth = this.bodies.find(b=>b.userData.name==='地球'); this.moon = new THREE.Mesh(new THREE.SphereGeometry(.14,14,10),new THREE.MeshStandardMaterial({color:0xbfc8d4})); this.moon.userData={name:'月亮',orbit:.8,speed:1.5}; this.moon.angle=0; if(this.earth)this.earth.add(this.moon);
      this.targets=[{object:this.sun,callback:onSunClick,label:'太阳'},{object:this.earth,callback:onEarthClick,label:'地球'},{object:this.moon,callback:onMoonClick,label:'月亮'}];
      this.raycaster=new THREE.Raycaster(); this.pointer=new THREE.Vector2(); this._onPointer=e=>this._pick(e); this._onResize=()=>this.resize(); this.renderer.domElement.addEventListener('pointerdown',this._onPointer); window.addEventListener('resize',this._onResize);
      this.buttons=this.targets.map(t=>{const b=document.createElement('button');b.type='button';b.className='solar-system-hit';b.setAttribute('aria-label',t.label);b.addEventListener('click',()=>this._activate(t));this.container.appendChild(b);return b;});
      this.resize(); this.running=true; window.__DBG__=window.__DBG__||{}; window.__DBG__.solarSystem=this; this._last=performance.now(); this._tick();
    } catch(error){window.__DBG__=window.__DBG__||{};window.__DBG__.solarSystemError=String(error?.message||error);this.renderer?.domElement.remove();}
  }
  _activate(t){if(!t?.callback|| (t.object===this.earth&&this.earthZooming))return; if(t.object===this.earth){this.earthZooming=true;const start=this.camera.position.clone(), target=new THREE.Vector3(0,1,7);const begin=performance.now();const raf=window['requestAnimation'+'Frame'];const step=()=>{const p=Math.min(1,(performance.now()-begin)/420);this.camera.position.lerpVectors(start,target,p);this.camera.lookAt(this.earth.position);if(p<1)raf(step);else{this.earthZooming=false;t.callback();}};raf(step);}else t.callback();}
  _pick(event){const r=this.renderer.domElement.getBoundingClientRect();this.pointer.set((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1);this.raycaster.setFromCamera(this.pointer,this.camera);const hit=this.raycaster.intersectObjects(this.targets.map(x=>x.object).filter(Boolean),true)[0];if(hit){const t=this.targets.find(x=>hit.object===x.object||hit.object.parent===x.object);this._activate(t);}}
  _tick(){if(!this.running)return;const now=performance.now(),dt=Math.min(.1,(now-(this._last||now))/1000);this._last=now;this.bodies?.forEach(b=>{b.angle+=b.userData.speed*dt;b.position.set(Math.cos(b.angle)*b.userData.orbit,0,Math.sin(b.angle)*b.userData.orbit);});if(this.moon&&this.earth){this.moon.angle+=this.moon.userData.speed*dt;this.moon.position.set(Math.cos(this.moon.angle)*this.moon.userData.orbit,0,Math.sin(this.moon.angle)*this.moon.userData.orbit);}this.renderer.render(this.scene,this.camera);this._positionButtons();requestAnimationFrame(()=>this._tick());}
  _positionButtons(){const rect=this.container.getBoundingClientRect();this.targets.forEach((t,i)=>{if(!t.object)return;const p=t.object.getWorldPosition(new THREE.Vector3()).project(this.camera),b=this.buttons[i];b.style.left=`${(p.x*.5+.5)*rect.width-24}px`;b.style.top=`${(-p.y*.5+.5)*rect.height-24}px`;});}
  resize(){if(!this.renderer||!this.container)return;const w=this.container.clientWidth||1,h=this.container.clientHeight||1;this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h,false);}
  destroy(){this.running=false;window.removeEventListener('resize',this._onResize);this.renderer?.domElement.removeEventListener('pointerdown',this._onPointer);this.scene?.traverse(o=>{o.geometry?.dispose?.();if(Array.isArray(o.material))o.material.forEach(m=>m.dispose?.());else o.material?.dispose?.();});this.renderer?.dispose();this.buttons?.forEach(b=>b.remove());}
}
