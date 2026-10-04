// Texture loading: CC0 surfaces from Poly Haven, webp, with mipmaps and anisotropy.
import * as THREE from 'three';

// the ground's layers load as one array (loadArray); only the pier's planks are still sampled as a plain texture
const NAMES = ['weathered_planks'];

export async function loadTextures(renderer, onProgress) {
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const out = {};
  let done = 0;
  const total = NAMES.length * 2;
  const one = (name, kind) =>
    new Promise((res) => {
      loader.load(
        `./assets/tex/${name}_${kind}.webp`,
        (t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = aniso;
          t.colorSpace = kind === 'c' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.generateMipmaps = true;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          out[`${name}_${kind}`] = t;
          done++;
          onProgress?.(done / total);
          res();
        },
        undefined,
        () => { done++; onProgress?.(done / total); res(); }
      );
    });
  await Promise.all(NAMES.flatMap((n) => [one(n, 'c'), one(n, 'n')]));
  return out;
}

// Pack several square textures into one sampler2DArray (keeps the terrain under the sampler limit).
export async function loadArray(names, kind, size = 1024) {
  const cv = new OffscreenCanvas(size, size);
  const g = cv.getContext('2d', { willReadFrequently: true });
  const data = new Uint8Array(size * size * 4 * names.length);
  await Promise.all(
    names.map(async (n, i) => {
      const blob = await (await fetch(`./assets/tex/${n}_${kind}.webp`)).blob();
      const bmp = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      // drawing is serialised by the shared canvas; copy each layer out right after drawing it
      data.set(drawLayer(g, bmp, size), i * size * size * 4);
      bmp.close();
    })
  );
  const t = new THREE.DataArrayTexture(data, size, size, names.length);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = kind === 'c' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function drawLayer(g, bmp, size) {
  g.clearRect(0, 0, size, size);
  g.drawImage(bmp, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}
