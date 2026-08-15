import { loadGoldLut } from './gold-lut.js';

export const GOLD_LUT_ASSET_URL = new URL('../../assets/gold-lut.d489076d.bin.gz', import.meta.url);

export async function loadGoldLutTexture({ device, registry, source = GOLD_LUT_ASSET_URL }) {
  const lut = await loadGoldLut(source);
  const texture = registry.createTexture({
    label: 'look-gold-response-lut',
    size: [lut.width, lut.height],
    format: 'rgba8unorm-srgb',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    lut.pixels,
    { bytesPerRow: lut.width * lut.channelCount, rowsPerImage: lut.height },
    [lut.width, lut.height, 1],
  );
  return Object.freeze({ ...lut, texture, view: texture.createView() });
}
