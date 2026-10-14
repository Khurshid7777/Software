import sharp from "sharp";

export interface ProcessedImage {
  /** Normalised JPEG stored for the listing (max 1600px, EXIF stripped, rotated). */
  full: Buffer;
  /** Small JPEG sent to the AI (max 1024px) to keep token costs low. */
  ai: Buffer;
  width: number;
  height: number;
  /** 64-bit difference hash, hex. Used for duplicate detection (stage 4). */
  phash: string;
}

/** Rejects decompression bombs: 40 MP covers any phone camera (a 1 GB raw decode does not). */
const LIMIT_INPUT_PIXELS = 40_000_000;
sharp.concurrency(2);

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const base = sharp(input, { failOn: "error", limitInputPixels: LIMIT_INPUT_PIXELS }).rotate();
  const full = await base
    .clone()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const ai = await base
    .clone()
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  return { full: full.data, ai, width: full.info.width, height: full.info.height, phash: await dHash(full.data) }; // hash the normalised copy: one decode less, same structure
}

/** Difference hash: 9x8 greyscale, compare neighbours → 64 bits. Robust to resizing and recompression. */
export async function dHash(input: Buffer): Promise<string> {
  const px = await sharp(input, { limitInputPixels: LIMIT_INPUT_PIXELS }).rotate().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x]! > px[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
