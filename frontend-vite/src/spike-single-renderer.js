import './globals/dashboardGlobals.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const app = document.getElementById('app');
const hud = document.getElementById('hud');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 1.2, 8.2);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(1.25, devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x020713, 1);
app.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0x7d9bc7, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(4,5,7); scene.add(key);
const rim = new THREE.DirectionalLight(0x6aa7ff, 1.0); rim.position.set(-5,2,-4); scene.add(rim);

// Earth proxy: deliberately lightweight; validates shared renderer/camera/layering, not final geography.
const earth = new THREE.Mesh(
  new THREE.SphereGeometry(1.62, 96, 48),
  new THREE.MeshStandardMaterial({ color: 0x1a4c86, roughness: 0.72, metalness: 0.03, emissive: 0x031529, emissiveIntensity: 0.35 })
);
earth.position.set(-1.45, -0.2, -1.0);
scene.add(earth);
const wire = new THREE.Mesh(new THREE.SphereGeometry(1.625, 48, 24), new THREE.MeshBasicMaterial({ color:0x68a8ff, wireframe:true, transparent:true, opacity:.08 }));
wire.position.copy(earth.position); scene.add(wire);

const starsGeo = new THREE.BufferGeometry();
const stars=[]; for(let i=0;i<900;i++){ const r=30, a=Math.random()*Math.PI*2, z=(Math.random()-.5)*18; stars.push(Math.cos(a)*r*Math.random(), z, Math.sin(a)*r*Math.random()-8); }
starsGeo.setAttribute('position', new THREE.Float32BufferAttribute(stars,3));
scene.add(new THREE.Points(starsGeo, new THREE.PointsMaterial({ color:0x9cc7ff, size:.025, transparent:true, opacity:.55 })));

const root = new THREE.Group();
root.position.set(2.1, 0.05, 0.45);
root.rotation.set(0.58, -0.65, 0.14);
root.scale.setScalar(0.42);
scene.add(root);
let ship=null, mixer=null, info=null;
let loadStart=performance.now(), loadedAt=null;
new GLTFLoader().load('/globe/star_trek_dsc_enterprise_user.glb?v=spike-single', (gltf)=>{
  ship=gltf.scene;
  const box = new THREE.Box3().setFromObject(ship);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = 4.8 / Math.max(size.x,size.y,size.z,0.001);
  ship.scale.setScalar(scale);
  ship.position.set(-center.x*scale, -center.y*scale, -center.z*scale);
  ship.rotation.set(0.62, Math.PI/2+0.62, -0.34);
  ship.traverse(o=>{ if(o.isMesh){ o.frustumCulled=true; o.castShadow=false; o.receiveShadow=false; const mats=Array.isArray(o.material)?o.material:[o.material]; mats.forEach(m=>{ if(m){ m.envMapIntensity=.45; if('roughness' in m) m.roughness=.5; } }); }});
  root.add(ship);
  if(gltf.animations?.length){ mixer = new THREE.AnimationMixer(ship); gltf.animations.forEach(c=>mixer.clipAction(c).play()); }
  info={animations:gltf.animations?.map(c=>({name:c.name,duration:c.duration,tracks:c.tracks.map(t=>t.name)})), size:size.toArray(), scale};
  loadedAt=performance.now();
  window.__DBG__.singleRendererSpike={scene,renderer,camera,root,ship,mixer,info};
}, undefined, (err)=>{ console.error('spike glb failed', err); hud.textContent='GLB failed '+err; });

let last=performance.now(); let frames=[]; let lastHud=0;
function tick(now){
  const dt=Math.min(.05, (now-last)/1000); last=now;
  earth.rotation.y += dt*.08; wire.rotation.y -= dt*.035;
  root.position.y = 0.05 + Math.sin(now*.001*.7)*.035;
  root.rotation.y = -0.65 + Math.sin(now*.001*.42)*.035;
  if(mixer) mixer.update(dt);
  renderer.render(scene,camera);
  frames.push(now); while(frames.length && now-frames[0]>2000) frames.shift();
  if(now-lastHud>500){
    const fps=Math.round((frames.length-1)/Math.max(.001,(frames[frames.length-1]-frames[0])/1000));
    hud.textContent = [
      'singleRenderer=true canvas='+document.querySelectorAll('canvas').length,
      'fps~'+fps+' dpr='+renderer.getPixelRatio(),
      'loaded='+(!!ship)+' loadMs='+(loadedAt?Math.round(loadedAt-loadStart):'…'),
      'mixer='+(mixer?mixer.time.toFixed(2):'none'),
      'tracks='+(info?.animations?.[0]?.tracks?.join(',')||'…')
    ].join('\n');
    window.__DBG__.singleRendererSpikeStats={fps,canvasCount:document.querySelectorAll('canvas').length,loaded:!!ship,loadMs:loadedAt?Math.round(loadedAt-loadStart):null,mixer:mixer?.time||0,info};
    lastHud=now;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
addEventListener('resize',()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); });
