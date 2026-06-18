import * as Cesium from 'cesium';

export function startRenderLoop(globe, {
  midViewHeight,
  autoRotateSpeed,
} = {}) {
  const tick = (now) => {
    if (globe._destroyed) return;
    const dt = globe._lastTime ? (now - globe._lastTime) / 1000 : 0;
    globe._lastTime = now;
    const h = globe.viewer.camera.positionCartographic?.height || 12_000_000;
    if (!globe._userInteracting && h > midViewHeight && dt > 0 && dt < 1) {
      globe.viewer.camera.rotateRight(Cesium.Math.toRadians(autoRotateSpeed * dt));
    }
    // Do not force roll back to 0: free north→south→north tumble needs camera roll freedom.
    globe._updateAtmosphereAndClouds();
    globe._updateLOD();
    globe._animFrame = requestAnimationFrame(tick);
  };
  globe._animFrame = requestAnimationFrame(tick);
}
