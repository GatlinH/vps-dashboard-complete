import {
  Color,
  LinearSRGBColorSpace,
  NearestFilter,
  Object3D,
  OrthographicCamera,
  RGBAFormat,
  REVISION,
  Scene,
  Spherical,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';

export const METHOD = Object.freeze({
  name: 'actual-production-sun-native-linear-v1',
  size: 1024,
  radiusPixels: 128,
  halfExtentR: 4,
  lumaWeights: [0.2126, 0.7152, 0.0722],
  normalization: 0.8,
  phase: 'unchanged original home pose; no phase search',
  mechanismColorSpace: LinearSRGBColorSpace,
  rowOrder: 'bottom-left',
});

const OVERRIDES = Object.freeze({
  production: {},
  limb: { uGrade: 0, uNoiseAmplitude: 0, uSpotStrength: 0, uLimb: 0.6 },
  noise0: { uNoiseAmplitude: 0 },
  limb0: { uLimb: 0 },
  limb0Law: { uGrade: 0, uNoiseAmplitude: 0, uSpotStrength: 0, uLimb: 0 },
  flat: { uGrade: 0, uNoiseAmplitude: 0, uSpotStrength: 0, uLimb: 0 },
  hidden: {},
  glow28: {},
  glowBackground: {},
});

const MATERIAL_FLAGS = [
  'name', 'version', 'side', 'opacity', 'transparent', 'blending',
  'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha',
  'blendEquationAlpha', 'depthFunc', 'depthTest', 'depthWrite', 'colorWrite',
  'alphaTest', 'alphaHash', 'premultipliedAlpha', 'dithering', 'toneMapped',
  'visible', 'wireframe', 'uniformsNeedUpdate', 'forceSinglePass',
];

function requireValue(condition, prefix, detail) {
  if (!condition) throw new Error(`${prefix}: ${detail}`);
}

export function luminanceFromRgb(red, green, blue, colorSpace = LinearSRGBColorSpace) {
  const decode = (channel) => {
    const value = channel / 255;
    if (colorSpace === LinearSRGBColorSpace) return value;
    requireValue(colorSpace === SRGBColorSpace, 'SUN_NATIVE_COLORSPACE', colorSpace);
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * decode(red) + 0.7152 * decode(green) + 0.0722 * decode(blue);
}

function bytesOf(array) {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fingerprint(bytes) {
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value.toString(16).padStart(8, '0');
}

function base64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  }
  return btoa(text);
}

function saveTransform(object) {
  return {
    object,
    parent: object.parent,
    children: [...object.children],
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    rotationOrder: object.rotation.order,
    scale: object.scale.clone(),
    up: object.up.clone(),
    matrix: object.matrix.clone(),
    matrixWorld: object.matrixWorld.clone(),
    matrixAutoUpdate: object.matrixAutoUpdate,
    matrixWorldAutoUpdate: object.matrixWorldAutoUpdate,
    matrixWorldNeedsUpdate: object.matrixWorldNeedsUpdate,
    visible: object.visible,
    layers: object.layers.mask,
    frustumCulled: object.frustumCulled,
    renderOrder: object.renderOrder,
  };
}

function restoreTransform(saved) {
  const object = saved.object;
  object.rotation.order = saved.rotationOrder;
  object.position.copy(saved.position);
  object.quaternion.copy(saved.quaternion);
  object.scale.copy(saved.scale);
  object.up.copy(saved.up);
  object.matrix.copy(saved.matrix);
  object.matrixWorld.copy(saved.matrixWorld);
  object.matrixAutoUpdate = saved.matrixAutoUpdate;
  object.matrixWorldAutoUpdate = saved.matrixWorldAutoUpdate;
  object.matrixWorldNeedsUpdate = saved.matrixWorldNeedsUpdate;
  object.visible = saved.visible;
  object.layers.mask = saved.layers;
  object.frustumCulled = saved.frustumCulled;
  object.renderOrder = saved.renderOrder;
}

function transformMatches(saved) {
  const object = saved.object;
  return object.parent === saved.parent
    && object.children.length === saved.children.length
    && object.children.every((child, index) => child === saved.children[index])
    && object.position.equals(saved.position) && object.quaternion.equals(saved.quaternion)
    && object.scale.equals(saved.scale) && object.up.equals(saved.up)
    && object.rotation.order === saved.rotationOrder
    && object.matrix.equals(saved.matrix) && object.matrixWorld.equals(saved.matrixWorld)
    && object.matrixAutoUpdate === saved.matrixAutoUpdate
    && object.matrixWorldAutoUpdate === saved.matrixWorldAutoUpdate
    && object.matrixWorldNeedsUpdate === saved.matrixWorldNeedsUpdate
    && object.visible === saved.visible && object.layers.mask === saved.layers
    && object.frustumCulled === saved.frustumCulled && object.renderOrder === saved.renderOrder;
}

function saveMaterial(material) {
  return {
    material,
    vertexShader: material.vertexShader,
    fragmentShader: material.fragmentShader,
    defines: material.defines,
    definesJson: JSON.stringify(material.defines),
    flags: Object.fromEntries(MATERIAL_FLAGS.filter((key) => key in material).map((key) => [key, material[key]])),
    uniforms: Object.fromEntries(Object.entries(material.uniforms || {}).map(([name, uniform]) => [name, {
      uniform,
      value: uniform.value,
      copy: uniform.value?.clone ? uniform.value.clone() : structuredClone(uniform.value),
    }])),
  };
}

function restoreMaterial(saved) {
  for (const [key, value] of Object.entries(saved.flags)) {
    if (key !== 'version') saved.material[key] = value;
  }
  for (const [name, entry] of Object.entries(saved.uniforms)) {
    saved.material.uniforms[name] = entry.uniform;
    if (entry.value?.copy) entry.value.copy(entry.copy);
    entry.uniform.value = entry.value;
  }
}

function restorePlainObject(object, saved) {
  for (const key of Object.keys(object)) if (!Object.hasOwn(saved, key)) delete object[key];
  for (const [key, value] of Object.entries(saved)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!object[key] || typeof object[key] !== 'object' || Array.isArray(object[key])) object[key] = {};
      restorePlainObject(object[key], value);
    } else if (Array.isArray(value)) {
      if (!Array.isArray(object[key])) object[key] = [];
      object[key].splice(0, object[key].length, ...structuredClone(value));
    } else object[key] = value;
  }
}

function saveOrbitState(orbitState) {
  return {
    orbitReferences: { ...orbitState },
    orbit: Object.fromEntries(Object.entries(orbitState).map(([key, value]) => [key,
      value?.clone ? value.clone() : structuredClone(value),
    ])),
  };
}

function orbitStateDiagnostics(orbitState, saved) {
  const keys = Object.fromEntries(Object.entries(saved.orbit).map(([key, value]) => [key, {
    sameIdentity: orbitState[key] === saved.orbitReferences[key],
    sameValue: value?.equals ? orbitState[key]?.equals?.(value) === true
      : value && typeof value === 'object' ? JSON.stringify(orbitState[key]) === JSON.stringify(value) : orbitState[key] === value,
  }]));
  return { keys, matches: Object.values(keys).every((entry) => entry.sameIdentity && entry.sameValue) };
}

function materialMatches(saved) {
  return saved.material.vertexShader === saved.vertexShader
    && saved.material.fragmentShader === saved.fragmentShader
    && saved.material.defines === saved.defines
    && JSON.stringify(saved.material.defines) === saved.definesJson
    && Object.entries(saved.flags).every(([key, value]) => saved.material[key] === value)
    && Object.entries(saved.uniforms).every(([name, entry]) => {
      const uniform = saved.material.uniforms[name];
      return uniform === entry.uniform && uniform.value === entry.value
        && (entry.value?.equals ? entry.value.equals(entry.copy) : JSON.stringify(entry.value) === JSON.stringify(entry.copy));
    });
}

function uniformValues(material) {
  return Object.fromEntries(Object.entries(material.uniforms || {}).map(([name, uniform]) => [
    name, uniform.value?.toArray ? uniform.value.toArray() : structuredClone(uniform.value),
  ]));
}

function collectErrors(gl) {
  const calls = [];
  for (let index = 0; index < 32; index += 1) {
    const code = gl.getError();
    calls.push(code);
    if (code === gl.NO_ERROR) break;
  }
  return { calls, errors: calls.filter((code) => code !== gl.NO_ERROR), contextLost: gl.isContextLost() };
}

function programRecord(renderer, material, gl) {
  const program = renderer.properties.get(material).currentProgram;
  if (!program?.program) return { present: false, diagnostics: null };
  const diagnostics = program.diagnostics;
  return {
    present: true,
    id: program.id,
    name: program.name,
    linkStatus: gl.getProgramParameter(program.program, gl.LINK_STATUS),
    vertexCompileStatus: gl.getShaderParameter(program.vertexShader, gl.COMPILE_STATUS),
    fragmentCompileStatus: gl.getShaderParameter(program.fragmentShader, gl.COMPILE_STATUS),
    programLog: gl.getProgramInfoLog(program.program),
    vertexLog: gl.getShaderInfoLog(program.vertexShader),
    fragmentLog: gl.getShaderInfoLog(program.fragmentShader),
    vertexSource: gl.getShaderSource(program.vertexShader),
    fragmentSource: gl.getShaderSource(program.fragmentShader),
    diagnostics: diagnostics ? {
      runnable: diagnostics.runnable,
      programLog: diagnostics.programLog,
      vertexShader: diagnostics.vertexShader,
      fragmentShader: diagnostics.fragmentShader,
    } : null,
  };
}

function projectedSun(solar, width, height) {
  const rectangle = solar.canvas.getBoundingClientRect();
  const center = new Vector3().setFromMatrixPosition(solar.sun.matrixWorld).project(solar.camera);
  const centerPixels = [(center.x + 1) * width / 2, (center.y + 1) * height / 2];
  const positions = solar.sun.geometry.getAttribute('position');
  let radiusPixels = 0;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.count; index += 1) {
    const projected = new Vector3().fromBufferAttribute(positions, index)
      .applyMatrix4(solar.sun.matrixWorld).project(solar.camera);
    const horizontal = (projected.x + 1) * width / 2;
    const vertical = (projected.y + 1) * height / 2;
    radiusPixels = Math.max(radiusPixels, Math.hypot(horizontal - centerPixels[0], vertical - centerPixels[1]));
    bounds[0] = Math.min(bounds[0], horizontal);
    bounds[1] = Math.min(bounds[1], vertical);
    bounds[2] = Math.max(bounds[2], horizontal);
    bounds[3] = Math.max(bounds[3], vertical);
  }
  return {
    centerPixels, radiusPixels, projectedGeometryBounds: bounds,
    centerNdc: center.toArray(),
    canvasRect: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height },
    drawingBuffer: { width, height },
    cssToDrawingBuffer: [width / rectangle.width, height / rectangle.height],
    centerCss: [rectangle.x + centerPixels[0] * rectangle.width / width,
      rectangle.y + (height - centerPixels[1]) * rectangle.height / height],
    radiusCss: [radiusPixels * rectangle.width / width, radiusPixels * rectangle.height / height],
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    rendererDpr: solar.renderer.getPixelRatio(),
  };
}

export function createSunNativeProbe(solar = window.__DBG__?.solarSystem) {
  requireValue(solar && solar === window.__DBG__?.solarSystem, 'SUN_NATIVE_SOURCE_BINDING', 'actual homepage instance required');
  const { sun, renderer, camera } = solar;
  requireValue(sun?.isMesh && sun.material?.uniforms && sun.geometry, 'SUN_NATIVE_SOURCE_BINDING', 'actual mesh/material/geometry required');
  requireValue(renderer?.domElement === solar.canvas && sun.parent, 'SUN_NATIVE_SOURCE_BINDING', 'actual renderer and attached Sun required');
  requireValue(solar.cameraAtHome && !solar.cameraTween && !solar.orbitState.isDragging
    && solar.orbitState.resumeTimerId == null, 'SUN_NATIVE_DEFAULT_HOME', 'fresh default source widget required');
  requireValue(camera.position.distanceTo(solar.homeCameraPosition) < 1e-9
    && solar.cameraTarget.distanceTo(solar.homeCameraTarget) < 1e-9, 'SUN_NATIVE_DEFAULT_HOME', 'camera is not its constructor home pose');
  requireValue(renderer.getRenderTarget() === null, 'SUN_NATIVE_HOME_TARGET', 'home must be the actual default framebuffer');

  const gl = renderer.getContext();
  const nodes = [];
  solar.scene.traverse((object) => nodes.push(saveTransform(object)));
  const sunNodes = nodes.filter((entry) => entry.object === sun || (() => {
    let parent = entry.object.parent;
    while (parent && parent !== sun) parent = parent.parent;
    return parent === sun;
  })());
  const glows = sunNodes.map((entry) => entry.object).filter((object) => object.isSprite);
  requireValue(glows.length > 0, 'SUN_NATIVE_GLOW_SOURCE', 'no actual production glow sprite');
  const materials = [...new Set(sunNodes.flatMap((entry) => entry.object.material
    ? (Array.isArray(entry.object.material) ? entry.object.material : [entry.object.material]) : []))].map(saveMaterial);
  const sourceBuffers = [...Object.entries(sun.geometry.attributes), ...(sun.geometry.index ? [['index', sun.geometry.index]] : [])]
    .map(([name, attribute]) => {
      const array = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
      return { name, attribute, array, bytes: bytesOf(array).slice(), version: attribute.version,
        itemSize: attribute.itemSize, count: attribute.count, normalized: attribute.normalized };
    });
  const savedCamera = saveTransform(camera);
  const snapshot = {
    running: solar.running, frameId: solar.frameId, tick: solar._tick,
    geometry: sun.geometry, material: sun.material, parent: sun.parent, parentChildren: [...sun.parent.children],
    onAfterRender: sun.onAfterRender,
    sample: solar.timeSample, sampleCopy: structuredClone(solar.timeSample), simulationTime: solar.simulationTime,
    epochRequestId: solar._epochRequestId, pendingEpoch: solar._pendingEpoch,
    status: solar.ephemerisStatus, statusCopy: structuredClone(solar.ephemerisStatus), statusJson: JSON.stringify(solar.ephemerisStatus),
    realTimeClock: { rate: solar.realTimeClock.rate, anchorSim: solar.realTimeClock.anchorSim, anchorPerf: solar.realTimeClock.anchorPerf },
    clock: Object.fromEntries(Object.entries(solar.clock).filter(([, value]) => typeof value !== 'function')),
    target: solar.cameraTarget.clone(), cameraTween: solar.cameraTween, cameraAtHome: solar.cameraAtHome,
    ...saveOrbitState(solar.orbitState),
    cameraFields: Object.fromEntries(['fov', 'zoom', 'near', 'far', 'focus', 'aspect', 'filmGauge', 'filmOffset'].map((key) => [key, camera[key]])),
    cameraView: camera.view, projection: camera.projectionMatrix.clone(), projectionInverse: camera.projectionMatrixInverse.clone(),
    worldInverse: camera.matrixWorldInverse.clone(), homePosition: solar.homeCameraPosition,
    homePositionCopy: solar.homeCameraPosition.clone(), homeTarget: solar.homeCameraTarget.clone(),
    renderTarget: renderer.getRenderTarget(), activeCubeFace: renderer.getActiveCubeFace(), activeMipmapLevel: renderer.getActiveMipmapLevel(),
    viewport: renderer.getViewport(new Vector4()), scissor: renderer.getScissor(new Vector4()), scissorTest: renderer.getScissorTest(),
    clearColor: renderer.getClearColor(new Color()), clearAlpha: renderer.getClearAlpha(),
    rendererFlags: Object.fromEntries(['autoClear', 'autoClearColor', 'autoClearDepth', 'autoClearStencil'].map((key) => [key, renderer[key]])),
    outputColorSpace: renderer.outputColorSpace, toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
    currentProgram: renderer.properties.get(sun.material).currentProgram,
    rendererFrame: renderer.info.render.frame,
    initialGl: collectErrors(gl),
  };
  const sunSaved = sunNodes.find((entry) => entry.object === sun);
  const worldScale = new Vector3().setFromMatrixScale(sunSaved.matrixWorld);
  const radius = sun.geometry.parameters?.radius * worldScale.x;
  requireValue(Number.isFinite(radius) && radius > 0 && Math.abs(worldScale.x - worldScale.y) < 1e-9
    && Math.abs(worldScale.x - worldScale.z) < 1e-9, 'SUN_NATIVE_GEOMETRY_RADIUS', 'uniform original sphere scale required');
  const center = new Vector3().setFromMatrixPosition(sunSaved.matrixWorld);
  const direction = new Vector3().setFromMatrixPosition(savedCamera.matrixWorld).sub(center).normalize();
  const isolatedCamera = new OrthographicCamera(-4 * radius, 4 * radius, 4 * radius, -4 * radius, 0.1 * radius, 20 * radius);
  isolatedCamera.up.copy(camera.up);
  isolatedCamera.position.copy(center).addScaledVector(direction, 8 * radius);
  isolatedCamera.lookAt(center);
  isolatedCamera.updateMatrixWorld(true);
  const temporaryScene = new Scene();
  const renderTarget = new WebGLRenderTarget(METHOD.size, METHOD.size, {
    format: RGBAFormat, type: UnsignedByteType, colorSpace: LinearSRGBColorSpace,
    minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false,
    depthBuffer: true, stencilBuffer: false, samples: 0,
  });
  renderTarget.texture.internalFormat = 'RGBA8';
  let disposed = false;
  renderTarget.addEventListener('dispose', () => { disposed = true; });
  let restored = false;
  let lastSunDraw = null;
  let captureCount = 0;

  function geometryMatches() {
    return sun.geometry === snapshot.geometry && sourceBuffers.every((entry) => {
      const attribute = entry.name === 'index' ? sun.geometry.index : sun.geometry.getAttribute(entry.name);
      const array = attribute?.isInterleavedBufferAttribute ? attribute.data.array : attribute?.array;
      return attribute === entry.attribute && array === entry.array && attribute.version === entry.version
        && equalBytes(bytesOf(array), entry.bytes);
    });
  }

  function scientificState() {
    return {
      sample: structuredClone(solar.timeSample), simulationTime: solar.simulationTime,
      epochRequestId: solar._epochRequestId, pendingEpochSame: solar._pendingEpoch === snapshot.pendingEpoch,
      clock: { rate: solar.realTimeClock.rate, anchorSim: solar.realTimeClock.anchorSim, anchorPerf: solar.realTimeClock.anchorPerf },
      status: structuredClone(solar.ephemerisStatus),
      locals: Object.fromEntries(Object.entries(solar.ephemerisTargets).map(([name, target]) => [name, {
        position: target.position.toArray(), quaternion: target.quaternion.toArray(), scale: target.scale.toArray(),
      }])),
    };
  }

  const originalScientific = scientificState();

  function restoreBaseline() {
    if (sun.parent !== snapshot.parent) {
      sun.removeFromParent();
      snapshot.parent.add(sun);
    }
    snapshot.parent.children.splice(0, snapshot.parent.children.length, ...snapshot.parentChildren);
    for (const entry of sunNodes) {
      entry.object.children.splice(0, entry.object.children.length, ...entry.children);
      for (const child of entry.children) child.parent = entry.object;
    }
    for (const entry of nodes) restoreTransform(entry);
    for (const entry of materials) restoreMaterial(entry);
    restoreTransform(savedCamera);
    Object.assign(camera, snapshot.cameraFields);
    camera.view = snapshot.cameraView;
    camera.projectionMatrix.copy(snapshot.projection);
    camera.projectionMatrixInverse.copy(snapshot.projectionInverse);
    camera.matrixWorldInverse.copy(snapshot.worldInverse);
    solar.cameraTarget.copy(snapshot.target);
    solar.cameraTween = snapshot.cameraTween;
    solar.cameraAtHome = snapshot.cameraAtHome;
    solar.homeCameraPosition = snapshot.homePosition;
    solar.homeCameraPosition.copy(snapshot.homePositionCopy);
    solar.homeCameraTarget.copy(snapshot.homeTarget);
    for (const [key, value] of Object.entries(snapshot.orbit)) {
      solar.orbitState[key] = snapshot.orbitReferences[key];
      if (solar.orbitState[key]?.copy) solar.orbitState[key].copy(value);
      else if (Array.isArray(value)) solar.orbitState[key].splice(0, solar.orbitState[key].length, ...structuredClone(value));
      else if (value && typeof value === 'object') restorePlainObject(solar.orbitState[key], value);
      else solar.orbitState[key] = value;
    }
    solar.timeSample = snapshot.sample;
    restorePlainObject(solar.timeSample, snapshot.sampleCopy);
    solar.ephemerisStatus = snapshot.status;
    restorePlainObject(solar.ephemerisStatus, snapshot.statusCopy);
    solar.simulationTime = snapshot.simulationTime;
    solar._epochRequestId = snapshot.epochRequestId;
    solar._pendingEpoch = snapshot.pendingEpoch;
    Object.assign(solar.realTimeClock, snapshot.realTimeClock);
    Object.assign(solar.clock, snapshot.clock);
    Object.assign(renderer, snapshot.rendererFlags);
    renderer.setRenderTarget(snapshot.renderTarget, snapshot.activeCubeFace, snapshot.activeMipmapLevel);
    renderer.setViewport(snapshot.viewport);
    renderer.setScissor(snapshot.scissor);
    renderer.setScissorTest(snapshot.scissorTest);
    renderer.setClearColor(snapshot.clearColor, snapshot.clearAlpha);
  }

  sun.onAfterRender = function (...args) {
    snapshot.onAfterRender.apply(this, args);
    const [actualRenderer, actualScene, actualCamera, actualGeometry, actualMaterial] = args;
    const program = actualRenderer.properties.get(actualMaterial).currentProgram;
    lastSunDraw = {
      actualRenderer: actualRenderer === renderer, actualSun: this === sun,
      actualGeometry: actualGeometry === snapshot.geometry, actualMaterial: actualMaterial === snapshot.material,
      sceneUuid: actualScene.uuid, cameraUuid: actualCamera.uuid,
      glCurrentProgramIsMaterial: Boolean(program?.program && gl.getParameter(gl.CURRENT_PROGRAM) === program.program),
      program: programRecord(actualRenderer, actualMaterial, gl),
    };
  };

  function assertPaused() {
    requireValue(!restored && !solar.running && solar.frameId === 0, 'SUN_NATIVE_PAUSE_UNIQUE_RAF', 'production loop is not paused');
    requireValue(JSON.stringify(scientificState()) === JSON.stringify(originalScientific), 'SUN_NATIVE_FROZEN_EPOCH', 'scientific sample or transforms changed');
    requireValue(solar.timeSample === snapshot.sample && solar.ephemerisStatus === snapshot.status
      && JSON.stringify(solar.ephemerisStatus) === snapshot.statusJson, 'SUN_NATIVE_FROZEN_EPOCH', 'epoch object identity or status changed');
    requireValue(renderer.outputColorSpace === snapshot.outputColorSpace && renderer.toneMapping === snapshot.toneMapping
      && renderer.toneMappingExposure === snapshot.exposure, 'SUN_NATIVE_GLOBAL_OUTPUT_UNCHANGED', 'global tone/output changed');
    requireValue(sun.material === snapshot.material && geometryMatches()
      && sun.material.vertexShader === materials[0].vertexShader && sun.material.fragmentShader === materials[0].fragmentShader,
    'SUN_NATIVE_SOURCE_BINDING', 'production source or buffers changed');
    return { running: solar.running, frameId: solar.frameId, rendererFrame: renderer.info.render.frame, scientific: scientificState() };
  }

  function capture(control, home, glow) {
    try { return captureFrame(control, home, glow); } finally {
      if (control === 'glowBackground') {
        for (const entry of sunNodes) if (entry.object.isSprite) restoreTransform(entry);
      }
    }
  }

  function captureFrame(control, home, glow) {
    requireValue(Object.hasOwn(OVERRIDES, control), 'SUN_NATIVE_CONTROL', control);
    assertPaused();
    restoreBaseline();
    for (const [name, value] of Object.entries(OVERRIDES[control])) sun.material.uniforms[name].value = value;
    for (const sprite of glows) sprite.visible = glow && sprite.visible;
    if (control === 'hidden') sun.visible = false;
    if (control === 'glow28') for (const sprite of glows) sprite.scale.set(28, 28, sprite.scale.z);
    if (!home) {
      temporaryScene.attach(sun);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = renderer.autoClearColor = renderer.autoClearDepth = renderer.autoClearStencil = true;
      renderer.setRenderTarget(renderTarget);
      renderer.setScissorTest(false);
    }
    const width = home ? gl.drawingBufferWidth : METHOD.size;
    const height = home ? gl.drawingBufferHeight : METHOD.size;
    const activeScene = home ? solar.scene : temporaryScene;
    const activeCamera = home ? camera : isolatedCamera;
    if (control === 'glowBackground') {
      const displacedCenter = center.clone().addScaledVector(
        new Vector3(1, 0, 0).applyQuaternion(activeCamera.quaternion), 3.2 * radius);
      for (const sprite of glows) sprite.position.copy(sprite.parent.worldToLocal(displacedCenter.clone()));
    }
    lastSunDraw = null;
    const checks = [{ stage: 'before-render', ...collectErrors(gl) }];
    const frameBefore = renderer.info.render.frame;
    const exceptions = [];
    try { renderer.render(activeScene, activeCamera); } catch (error) { exceptions.push({ stage: 'render', error: String(error) }); }
    checks.push({ stage: 'after-render', ...collectErrors(gl) });
    const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    let pixels = null;
    try {
      const readback = new Uint8Array(width * height * 4);
      if (home) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, readback);
      else renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, readback);
      pixels = readback;
    } catch (error) { exceptions.push({ stage: 'read', error: String(error) }); }
    checks.push({ stage: 'after-read', ...collectErrors(gl) });
    const program = lastSunDraw?.program || programRecord(renderer, sun.material, gl);
    checks.push({ stage: 'after-program-diagnostics', ...collectErrors(gl) });
    const mapping = home ? projectedSun(solar, width, height) : {
      centerPixels: [width / 2, height / 2], radiusPixels: METHOD.radiusPixels,
      drawingBuffer: { width, height }, halfExtentR: METHOD.halfExtentR,
      camera: { type: isolatedCamera.type, position: isolatedCamera.position.toArray(), quaternion: isolatedCamera.quaternion.toArray(),
        left: isolatedCamera.left, right: isolatedCamera.right, top: isolatedCamera.top, bottom: isolatedCamera.bottom },
    };
    const record = {
      control, kind: home ? 'actual-home' : 'isolated-linear', captureId: ++captureCount,
      method: METHOD.name, width, height, rowOrder: METHOD.rowOrder,
      colorSpace: home ? renderer.outputColorSpace : renderTarget.texture.colorSpace,
      byteLength: pixels?.byteLength || 0, rgbaBase64: pixels ? base64(pixels) : null,
      frameBefore, frameAfter: renderer.info.render.frame, program, sunDraw: lastSunDraw,
      glChecks: checks, framebufferStatus, framebufferComplete: framebufferStatus === gl.FRAMEBUFFER_COMPLETE,
      exceptions, mapping, scientific: scientificState(),
      pose: { position: sun.position.toArray(), quaternion: sun.quaternion.toArray(), scale: sun.scale.toArray(),
        worldMatrix: sun.matrixWorld.toArray(), referenceWorldMatrix: sunSaved.matrixWorld.toArray() },
      source: { sunUuid: sun.uuid, materialUuid: sun.material.uuid, geometryUuid: sun.geometry.uuid,
        actualHomepageInstance: solar === window.__DBG__.solarSystem, sameRenderer: renderer === solar.renderer,
        sameMaterial: sun.material === snapshot.material, sameGeometry: geometryMatches() },
      uniforms: uniformValues(sun.material),
      glows: glows.map((sprite) => ({ uuid: sprite.uuid, scale: sprite.scale.toArray(), opacity: sprite.material.opacity,
        ...(control === 'glowBackground' ? { position: sprite.position.toArray(),
          worldPosition: new Vector3().setFromMatrixPosition(sprite.matrixWorld).toArray() } : {}) })),
      target: home ? null : { width: renderTarget.width, height: renderTarget.height,
        type: renderTarget.texture.type, format: renderTarget.texture.format, internalFormat: renderTarget.texture.internalFormat,
        colorSpace: renderTarget.texture.colorSpace, samples: renderTarget.samples },
    };
    assertPaused();
    return record;
  }

  function restore() {
    if (restored) return { ok: false, errors: ['SUN_NATIVE_RESTORE_ALREADY_CALLED'] };
    const errors = [];
    const report = {
      originalFrameId: snapshot.frameId, wasRunning: snapshot.running,
      rendererFrameBefore: snapshot.rendererFrame, captures: captureCount,
    };
    const attempt = (name, action) => {
      try { action(); } catch (error) { errors.push(`${name}: ${error}`); }
    };
    const check = (name, action) => {
      report[name] = false;
      attempt(name, () => { report[name] = action(); });
    };
    try {
      attempt('baseline', restoreBaseline);
      attempt('restore-original-render', () => renderer.render(solar.scene, camera));
      attempt('restore-matrices-and-state', restoreBaseline);
      attempt('restore-render-hook', () => { sun.onAfterRender = snapshot.onAfterRender; });
      check('sameSun', () => solar.sun === sun);
      check('sameRenderer', () => solar.renderer === renderer);
      check('sameMaterial', () => sun.material === snapshot.material);
      check('sameGeometryAndSourceBuffers', geometryMatches);
      check('sameSourcesAndMaterialFlags', () => materials.every(materialMatches));
      check('sameTransformsAndChildOrder', () => nodes.every(transformMatches));
      check('sameCamera', () => transformMatches(savedCamera) && camera.projectionMatrix.equals(snapshot.projection)
        && camera.projectionMatrixInverse.equals(snapshot.projectionInverse) && camera.matrixWorldInverse.equals(snapshot.worldInverse)
        && solar.cameraTarget.equals(snapshot.target) && camera.view === snapshot.cameraView
        && Object.entries(snapshot.cameraFields).every(([key, value]) => camera[key] === value));
      check('sameEpochAndScientificTransforms', () => JSON.stringify(scientificState()) === JSON.stringify(originalScientific)
        && solar.timeSample === snapshot.sample && solar.ephemerisStatus === snapshot.status);
      check('sameRendererState', () => renderer.getRenderTarget() === snapshot.renderTarget
        && renderer.getActiveCubeFace() === snapshot.activeCubeFace && renderer.getActiveMipmapLevel() === snapshot.activeMipmapLevel
        && renderer.getViewport(new Vector4()).equals(snapshot.viewport) && renderer.getScissor(new Vector4()).equals(snapshot.scissor)
        && renderer.getScissorTest() === snapshot.scissorTest && renderer.getClearColor(new Color()).equals(snapshot.clearColor)
        && renderer.getClearAlpha() === snapshot.clearAlpha
        && Object.entries(snapshot.rendererFlags).every(([key, value]) => renderer[key] === value)
        && renderer.outputColorSpace === snapshot.outputColorSpace && renderer.toneMapping === snapshot.toneMapping
        && renderer.toneMappingExposure === snapshot.exposure);
      check('sameClock', () => Object.entries(snapshot.clock).every(([key, value]) => solar.clock[key] === value)
        && Object.entries(snapshot.realTimeClock).every(([key, value]) => solar.realTimeClock[key] === value));
      check('sameHomeAndOrbitState', () => {
        report.orbitState = orbitStateDiagnostics(solar.orbitState, snapshot);
        return solar.homeCameraPosition === snapshot.homePosition
          && solar.homeCameraPosition.equals(snapshot.homePositionCopy) && solar.homeCameraTarget.equals(snapshot.homeTarget)
          && solar.cameraAtHome === snapshot.cameraAtHome && solar.cameraTween === snapshot.cameraTween
          && report.orbitState.matches;
      });
      check('sameCurrentProgram', () => renderer.properties.get(sun.material).currentProgram === snapshot.currentProgram);
      check('sameRenderHook', () => sun.onAfterRender === snapshot.onAfterRender);
      attempt('restore-gl-check', () => { report.gl = collectErrors(gl); });
      report.rendererFrameAfter = renderer.info.render.frame;
    } finally {
      attempt('target-dispose', () => renderTarget.dispose());
      attempt('scene-release', () => temporaryScene.clear());
      attempt('restore-running-state', () => { solar.running = snapshot.running; solar.frameId = 0; });
      report.requeuedRafCount = 0;
      if (snapshot.running) attempt('requeue-single-production-raf', () => {
        solar.frameId = requestAnimationFrame(snapshot.tick);
        report.requeuedRafCount = 1;
      });
      restored = true;
    }
    report.targetDisposed = disposed;
    report.temporarySceneEmpty = temporaryScene.children.length === 0;
    report.requeuedFrameId = solar.frameId;
    const booleanChecks = Object.entries(report).filter(([key, value]) => (key.startsWith('same') || key === 'targetDisposed'
      || key === 'temporarySceneEmpty') && typeof value === 'boolean');
    report.ok = errors.length === 0 && booleanChecks.every(([, value]) => value)
      && report.gl?.errors.length === 0 && !report.gl?.contextLost
      && report.requeuedRafCount === (snapshot.running ? 1 : 0);
    report.errors = errors;
    return report;
  }

  try {
    solar.pause();
    requireValue(solar.frameId === 0 && !solar.running, 'SUN_NATIVE_PAUSE_UNIQUE_RAF', 'actual pause failed');
    return {
      metadata: {
        method: METHOD, threeRevision: REVISION, isMobile: solar.isMobile,
        rendererDpr: renderer.getPixelRatio(), deviceDpr: window.devicePixelRatio,
        innerSize: [window.innerWidth, window.innerHeight],
        binding: { sunUuid: sun.uuid, materialUuid: sun.material.uuid, geometryUuid: sun.geometry.uuid,
          materialName: sun.material.name, vertexShader: sun.material.vertexShader, fragmentShader: sun.material.fragmentShader,
          defines: structuredClone(sun.material.defines), uniforms: uniformValues(sun.material),
          buffers: sourceBuffers.map((entry) => ({ name: entry.name, type: entry.array.constructor.name, byteLength: entry.bytes.length,
            itemSize: entry.itemSize, count: entry.count, normalized: entry.normalized, fingerprint: fingerprint(entry.bytes) })),
          parentUuid: snapshot.parent.uuid, parentChildOrder: snapshot.parentChildren.map((object) => object.uuid),
          sunChildOrder: sun.children.map((object) => object.uuid), position: sunSaved.position.toArray(),
          quaternion: sunSaved.quaternion.toArray(), scale: sunSaved.scale.toArray(), matrix: sunSaved.matrix.toArray(),
          matrixWorld: sunSaved.matrixWorld.toArray(), worldRadius: radius, program: programRecord(renderer, sun.material, gl) },
        originalScientific, initialGl: snapshot.initialGl, runningBefore: snapshot.running, cancelledFrameId: snapshot.frameId,
        homeCamera: { position: savedCamera.position.toArray(), quaternion: savedCamera.quaternion.toArray(),
          target: snapshot.target.toArray(), projection: snapshot.projection.toArray(), cameraAtHome: snapshot.cameraAtHome },
        homeMapping: projectedSun(solar, gl.drawingBufferWidth, gl.drawingBufferHeight),
      },
      assertPaused,
      captureIsolated: (control, glow = false) => capture(control, false, glow),
      captureHome: (control, glow = true) => capture(control, true, glow),
      restore,
    };
  } catch (error) {
    const restoration = restore();
    error.message += `; restoration=${JSON.stringify(restoration)}`;
    throw error;
  }
}

export function runUnitTests() {
  const passed = [];
  const check = (name, action) => { action(); passed.push(name); };
  check('untouched-real-spherical-orbit-passes', () => {
    const orbitState = { spherical: new Spherical(10, 0.5, 0.25) };
    const saved = saveOrbitState(orbitState);
    requireValue(orbitState.spherical.equals === undefined, 'UNIT', 'real Spherical has no equals');
    const diagnostics = orbitStateDiagnostics(orbitState, saved);
    requireValue(diagnostics.matches, 'UNIT', JSON.stringify(diagnostics));
  });
  for (const key of ['theta', 'phi', 'radius']) {
    check(`changed-spherical-${key}-rejects`, () => {
      const orbitState = { spherical: new Spherical(10, 0.5, 0.25) };
      const saved = saveOrbitState(orbitState);
      orbitState.spherical[key] += 0.125;
      const diagnostics = orbitStateDiagnostics(orbitState, saved);
      requireValue(!diagnostics.matches && diagnostics.keys.spherical.sameIdentity
        && !diagnostics.keys.spherical.sameValue, 'UNIT', JSON.stringify(diagnostics));
    });
  }
  check('changed-spherical-identity-rejects', () => {
    const orbitState = { spherical: new Spherical(10, 0.5, 0.25) };
    const saved = saveOrbitState(orbitState);
    orbitState.spherical = orbitState.spherical.clone();
    const diagnostics = orbitStateDiagnostics(orbitState, saved);
    requireValue(!diagnostics.matches && !diagnostics.keys.spherical.sameIdentity
      && diagnostics.keys.spherical.sameValue, 'UNIT', JSON.stringify(diagnostics));
  });
  check('plain-orbit-object-identity-and-values', () => {
    const orbitState = { settings: { nested: { radius: 10 } } };
    const saved = saveOrbitState(orbitState);
    requireValue(orbitStateDiagnostics(orbitState, saved).matches, 'UNIT', 'untouched plain object');
    orbitState.settings.nested.radius = 11;
    const changed = orbitStateDiagnostics(orbitState, saved);
    requireValue(!changed.matches && changed.keys.settings.sameIdentity && !changed.keys.settings.sameValue,
      'UNIT', JSON.stringify(changed));
    orbitState.settings = structuredClone(saved.orbit.settings);
    const replaced = orbitStateDiagnostics(orbitState, saved);
    requireValue(!replaced.matches && !replaced.keys.settings.sameIdentity && replaced.keys.settings.sameValue,
      'UNIT', JSON.stringify(replaced));
  });
  check('linear-white-is-one', () => requireValue(Math.abs(luminanceFromRgb(255, 255, 255) - 1) < 1e-15, 'UNIT', 'white'));
  check('linear-rec709-red', () => requireValue(luminanceFromRgb(255, 0, 0) === 0.2126, 'UNIT', 'Rec709'));
  check('linear-is-not-gamma-decoded', () => requireValue(Math.abs(luminanceFromRgb(128, 128, 128) - 128 / 255) < 1e-15, 'UNIT', 'double gamma'));
  check('home-srgb-decoded-once', () => requireValue(Math.abs(luminanceFromRgb(128, 128, 128, SRGBColorSpace) - 0.21586050011389926) < 1e-14, 'UNIT', 'sRGB'));
  check('unsupported-colorspace-rejected', () => {
    let rejected = false;
    try { luminanceFromRgb(1, 2, 3, 'unknown'); } catch (error) { rejected = error.message.startsWith('SUN_NATIVE_COLORSPACE:'); }
    requireValue(rejected, 'UNIT', 'unsupported color space');
  });
  check('object-transform-roundtrip-without-sun-fixture', () => {
    const object = new Object3D();
    object.position.set(2, 3, 4);
    object.rotation.set(0.2, 0.4, 0.6, 'ZYX');
    object.scale.set(1, 2, 3);
    object.updateMatrixWorld(true);
    const saved = saveTransform(object);
    object.position.set(9, 8, 7);
    object.visible = false;
    object.scale.setScalar(5);
    object.updateMatrixWorld(true);
    restoreTransform(saved);
    requireValue(transformMatches(saved), 'UNIT', 'transform restore');
  });
  check('uniform-identity-roundtrip-without-shader-instantiation', () => {
    const material = { version: 1, toneMapped: false, uniforms: {
      scalar: { value: 0.24 }, color: { value: new Color(0.2, 0.3, 0.4) },
    } };
    const saved = saveMaterial(material);
    material.uniforms.scalar.value = 0;
    material.uniforms.color.value.setRGB(1, 1, 1);
    material.toneMapped = true;
    restoreMaterial(saved);
    requireValue(materialMatches(saved), 'UNIT', 'uniform/flag restore');
  });
  return { kind: 'helper-unit-tests-only-not-native-evidence', count: passed.length, passed };
}
