/**
 * A deterministic stand-in for a phone photo: smooth lighting, sensor-like
 * noise and a sprinkle of small saturated details (think flowers or price
 * stickers). The details are what 4:2:0 chroma subsampling smears, so a strict
 * per-channel comparison rejects every lossy encoding of this image, while its
 * brightness stays intact.
 */
export function photographicPixels(width: number, height: number) {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width, v = y / height;
      const light = 0.55 + 0.35 * Math.sin(u * 5.1 + v * 2.3) * Math.cos(v * 3.7 - u);
      const grain = (random() - 0.5) * 18;
      const at = (y * width + x) * 3;
      pixels[at] = clamp(70 + 120 * light * (0.8 + 0.2 * Math.sin(v * 9)) + grain);
      pixels[at + 1] = clamp(95 + 110 * light + grain);
      pixels[at + 2] = clamp(60 + 90 * light * (0.7 + 0.3 * Math.cos(u * 7)) + grain);
    }
  }
  // Small saturated details on about 0.2% of the area.
  const details = Math.round((width * height) / 4000);
  for (let index = 0; index < details; index++) {
    const cx = Math.floor(random() * (width - 4)), cy = Math.floor(random() * (height - 4));
    const red = random() < 0.5;
    for (let dy = 0; dy < 3; dy++)
      for (let dx = 0; dx < 3; dx++) {
        const at = ((cy + dy) * width + cx + dx) * 3;
        pixels.set(red ? [220, 30, 40] : [240, 200, 20], at);
      }
  }
  return pixels;
}

function clamp(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
