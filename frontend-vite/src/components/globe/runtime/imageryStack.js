import { installEarthImagery } from '../imageryProviders.js';
import { installMaptilerLayer } from '../maptilerLayer.js';

export async function installImageryStack(globe) {
  await installEarthImagery(globe);
  installMaptilerLayer(globe);
  if (globe._maptilerLayer) {
    globe._maptilerLayer.show = false;
    globe._maptilerLayer.alpha = 0.0;
  }
}
