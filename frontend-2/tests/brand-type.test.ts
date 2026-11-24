// Text sizes and weights (H1 to H6, paragraph...) in the brand fonts section. Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STANDARD_TYPE_SCALE, TYPE_KEYS, brandStyleLines, parseBrandStyle, serializeBrandStyle, validateBrandStyle, validateTypeScale } from "@/lib/business/assets";

describe("reading the text styles", () => {
  it("keeps what was filled in, as numbers, and leaves out rows without a size", () => {
    const t = validateTypeScale({ h1: { size: "56", mobileSize: "36", weight: 700, lineHeight: "1.1" }, h2: { size: "", weight: 700 }, p: { size: 16 } });
    assert.deepEqual(t, { h1: { size: 56, mobileSize: 36, weight: 700, lineHeight: 1.1 }, p: { size: 16, weight: 400 } });
  });
  it("refuses sizes, weights and line heights that make no sense, saying which row", () => {
    assert.throws(() => validateTypeScale({ h1: { size: 3 } }), /Heading 1 \(H1\): the size must be a number from 8 to 200/);
    assert.throws(() => validateTypeScale({ h3: { size: 500 } }), /Heading 3/);
    assert.throws(() => validateTypeScale({ p: { size: 16, mobileSize: 2 } }), /Paragraph: the mobile size/);
    assert.throws(() => validateTypeScale({ p: { size: 16, weight: 450 } }), /Paragraph: choose a weight/);
    assert.throws(() => validateTypeScale({ small: { size: 14, lineHeight: 9 } }), /Small text: the line height/);
    assert.throws(() => validateTypeScale({ small: { size: "big" } }), /Small text/);
    assert.throws(() => validateTypeScale("h1"), /not valid/);
  });
  it("ignores unknown keys (an old button style too) and treats nothing as nothing", () => {
    assert.deepEqual(validateTypeScale({ h9: { size: 20 }, button: { size: 16, weight: 600 }, __proto__: { size: 20 } }), {});
    assert.deepEqual(validateTypeScale(undefined), {});
    assert.deepEqual(validateTypeScale(null), {});
  });
});

describe("the text styles travel with the brand style", () => {
  it("are saved and read back, and a brand style without them is exactly as before", () => {
    const saved = serializeBrandStyle({ colors: [], fonts: [], type: { h1: { size: 48, weight: 700 } } } as never);
    assert.notEqual(saved, "");
    assert.deepEqual(parseBrandStyle(saved).type, { h1: { size: 48, weight: 700 } });
    const plain = validateBrandStyle({ colors: [], fonts: [] });
    assert.ok(!("type" in plain), "no empty type key appears");
    assert.equal(serializeBrandStyle({ colors: [], fonts: [] }), "", "nothing filled in is still nothing");
  });
  it("text styles alone count as something provided", () => {
    assert.notEqual(serializeBrandStyle({ colors: [], fonts: [], type: { p: { size: 16, weight: 400 } } } as never), "");
  });
  it("the standard scale is valid, covers every element and grows from small text to H1", () => {
    assert.deepEqual(Object.keys(validateTypeScale(STANDARD_TYPE_SCALE)), [...TYPE_KEYS]);
    const s = STANDARD_TYPE_SCALE;
    assert.ok(s.h1.size > s.h2.size && s.h2.size > s.h3.size && s.h3.size > s.h4.size && s.h4.size > s.h5.size && s.h5.size >= s.h6.size);
    assert.ok(s.p.size > s.small.size);
  });
});

describe("what the generator is told", () => {
  it("lists each fixed style exactly, with the mobile size and the line height, and says which are not fixed", () => {
    const style = validateBrandStyle({ colors: [], fonts: [], type: { h1: { size: 56, mobileSize: 36, weight: 700, lineHeight: 1.1 }, p: { size: 16, weight: 400 } } });
    const text = brandStyleLines(style).join("\n");
    assert.match(text, /Typography \(use these exact sizes and weights/);
    assert.match(text, /- Heading 1 \(H1\): 56px \(mobile 36px\), bold \(700\), line-height 1.1/);
    assert.match(text, /- Paragraph: 16px, regular \(400\)$/m);
    assert.match(text, /Not fixed by the brand \(Heading 2 \(H2\)/);
  });
  it("says nothing about typography when none was given", () => {
    assert.ok(!brandStyleLines(validateBrandStyle({ colors: ["#112233"], fonts: [] })).join("\n").includes("Typography"));
  });
});
