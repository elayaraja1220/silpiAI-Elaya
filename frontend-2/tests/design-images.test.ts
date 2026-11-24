// Very tall design pictures are cut into readable parts. Run: npm test
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { MAX_WHOLE_HEIGHT, SLICE_HEIGHT, SLICE_OVERLAP, sliceDesignImages } from "@/lib/execution/design-images";

describe("long design pictures", () => {
  const root = mkdtempSync(path.join(tmpdir(), "silpi-design-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const dirRel = ".silpi/client-assets/design/design-reference";
  mkdirSync(path.join(root, dirRel), { recursive: true });

  async function picture(name: string, width: number, height: number) {
    const sharp = (await import("sharp")).default;
    await sharp({ create: { width, height, channels: 3, background: { r: 240, g: 240, b: 250 } } }).png().toFile(path.join(root, dirRel, name));
    return `${dirRel}/${name}`;
  }

  it("a tall picture becomes ordered, overlapping parts that together cover all of it", async () => {
    const sharp = (await import("sharp")).default;
    const rel = await picture("home.png", 600, 5538);
    const out = await sliceDesignImages(root, [rel]);
    const step = SLICE_HEIGHT - SLICE_OVERLAP;
    const expected = Math.ceil((5538 - SLICE_OVERLAP) / step);
    assert.ok(out.length >= expected - 1 && out.length <= expected + 1, `${out.length} parts`);
    assert.deepEqual(out.slice(0, 2), [`${dirRel}/home-parts/home-part-01.png`, `${dirRel}/home-parts/home-part-02.png`]);
    let covered = 0;
    for (const [i, p] of out.entries()) {
      assert.ok(existsSync(path.join(root, p)), p);
      const meta = await sharp(path.join(root, p)).metadata();
      assert.equal(meta.width, 600);
      assert.ok((meta.height ?? 0) <= SLICE_HEIGHT);
      covered = i === 0 ? meta.height ?? 0 : covered + (meta.height ?? 0) - SLICE_OVERLAP;
    }
    assert.ok(covered >= 5538 - 5, `the parts reach the bottom of the picture (${covered} of 5538)`);
  });

  it("a picture that is not tall, a PDF, a missing file and a list of several are left exactly as they are", async () => {
    const small = await picture("phone.png", 390, MAX_WHOLE_HEIGHT);
    writeFileSync(path.join(root, dirRel, "spec.pdf"), "%PDF-1.4");
    const list = [small, `${dirRel}/spec.pdf`, `${dirRel}/missing.png`];
    assert.deepEqual(await sliceDesignImages(root, list), list);
  });

  it("order is kept when only some pictures are cut", async () => {
    const a = await picture("a.png", 300, 100);
    const tall = await picture("tall.png", 300, 2500);
    const b = await picture("b.png", 300, 100);
    const out = await sliceDesignImages(root, [a, tall, b]);
    assert.equal(out[0], a);
    assert.equal(out.at(-1), b);
    assert.ok(out.slice(1, -1).every((p) => /tall-part-0\d\.png$/.test(p)));
    assert.equal(out.length, 2 + 3, "2500 px is three parts of at most 1100");
  });

  it("a damaged picture stays in the list whole instead of being dropped", async () => {
    writeFileSync(path.join(root, dirRel, "broken.png"), "not a picture");
    assert.deepEqual(await sliceDesignImages(root, [`${dirRel}/broken.png`]), [`${dirRel}/broken.png`]);
  });
});
