import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * A design reference is often one very long page picture (a whole home page is easily 5,000 pixels tall). An AI reads a picture at a
 * limited size, so a long one turns into a blurry thumbnail where small text, icons and spacing are lost. Long pictures are therefore
 * cut into parts that overlap a little, and the parts are what the generator opens, in order. (server-only)
 */

export const SLICE_HEIGHT = 1100;
export const SLICE_OVERLAP = 100;
/** A picture up to this tall is read as it is. */
export const MAX_WHOLE_HEIGHT = 1600;

type Sharp = typeof import("sharp");

/**
 * Replaces each tall picture in the list by its parts (`name-parts/name-part-01.png`, ...); everything else is left as it is.
 * If the image library is missing or a picture cannot be read, that picture stays in the list whole: nothing is ever dropped.
 */
export async function sliceDesignImages(projectDir: string, design: string[]): Promise<string[]> {
  let sharp: Sharp["default"];
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return design;
  }
  const out: string[] = [];
  for (const rel of design) {
    const full = path.join(projectDir, rel);
    if (!/\.(png|jpe?g|webp)$/i.test(rel) || !existsSync(full)) {
      out.push(rel);
      continue;
    }
    try {
      const { width = 0, height = 0 } = await sharp(full).metadata();
      if (!width || height <= MAX_WHOLE_HEIGHT) {
        out.push(rel);
        continue;
      }
      const dirRel = path.posix.dirname(rel.replace(/\\/g, "/"));
      const base = path.posix.basename(rel).replace(/\.[^.]+$/, "");
      const partsRel = path.posix.join(dirRel, `${base}-parts`);
      mkdirSync(path.join(projectDir, partsRel), { recursive: true });
      const parts: string[] = [];
      for (let top = 0, n = 1; top < height; top += SLICE_HEIGHT - SLICE_OVERLAP, n += 1) {
        const h = Math.min(SLICE_HEIGHT, height - top);
        // A sliver at the very end is already inside the previous part.
        if (n > 1 && h <= SLICE_OVERLAP + 40) break;
        const name = `${base}-part-${String(n).padStart(2, "0")}.png`;
        await sharp(full).extract({ left: 0, top, width, height: h }).png().toFile(path.join(projectDir, partsRel, name));
        parts.push(path.posix.join(partsRel, name));
        if (top + h >= height) break;
      }
      out.push(...(parts.length ? parts : [rel]));
    } catch {
      out.push(rel);
    }
  }
  return out;
}
