// Colours for borders, navigation, footer and side menu, and named extra colours. Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BRAND_COLOR_ROLES, MORE_COLORS, brandStyleLines, parseBrandStyle, serializeBrandStyle, validateBrandStyle, validateColorLabels, validateMoreColors } from "@/lib/business/assets";

const blank = Array.from({ length: 9 }, () => "");

describe("colours of the page parts", () => {
  it("borders are separate from links, and each part of the page has its own colours", () => {
    assert.equal(BRAND_COLOR_ROLES[8], "Links");
    assert.ok(!BRAND_COLOR_ROLES.some((r) => /border/i.test(r)));
    const keys = MORE_COLORS.map((m) => m.key);
    for (const k of ["borders", "navBg", "navText", "navLink", "footerBg", "footerHeading", "footerText", "footerLink", "sideBg", "sideHeading", "sideText", "sideLink"]) assert.ok(keys.includes(k as never), k);
    assert.deepEqual([...new Set(MORE_COLORS.map((m) => m.group))], ["Borders", "Navigation bar", "Footer", "Side menu"]);
  });
  it("tidies the codes, leaves out empty ones and ignores unknown keys", () => {
    assert.deepEqual(validateMoreColors({ navLink: "0b3d91", footerBg: "#0bf", navBg: "", sideText: "  ", nope: "#111111" }), { navLink: "#0B3D91", footerBg: "#00BBFF" });
    assert.deepEqual(validateMoreColors(undefined), {});
  });
  it("refuses a bad code and says which colour", () => {
    assert.throws(() => validateMoreColors({ footerLink: "blue" }), /Footer link: not a valid colour code/);
    assert.throws(() => validateMoreColors({ sideBg: "#12" }), /Side menu background/);
    assert.throws(() => validateMoreColors("x"), /not valid/);
  });
  it("is saved with the brand style and read back; a style without them has no such key", () => {
    const saved = serializeBrandStyle({ colors: blank, fonts: [], more: { navBg: "#112233", borders: "#CCCCCC" } });
    assert.notEqual(saved, "", "page colours alone count as something provided");
    assert.deepEqual(parseBrandStyle(saved).more, { navBg: "#112233", borders: "#CCCCCC" });
    assert.ok(!("more" in validateBrandStyle({ colors: blank, fonts: [] })));
  });
});

describe("named extra colours", () => {
  const eleven = [...blank, "#112233", "#445566"];
  it("keep the name given to each, in order, and show blank names as Extra colour N", () => {
    const s = validateBrandStyle({ colors: eleven, fonts: [], labels: ["Sale badge", ""] });
    assert.deepEqual(s.labels, ["Sale badge", ""]);
    assert.equal(s.colors.length, 11);
    const lines = brandStyleLines(s).join("\n");
    assert.match(lines, /- Sale badge: #112233/);
    assert.match(lines, /- Extra colour 2: #445566/);
  });
  it("tidy spaces, drop names when none was given, and match the number of extra colours", () => {
    assert.deepEqual(validateColorLabels(["  Hero   overlay "], 1), ["Hero overlay"]);
    assert.deepEqual(validateColorLabels(["a", "b", "c"], 2), ["a", "b"]);
    assert.deepEqual(validateColorLabels(undefined, 2), ["", ""]);
    assert.ok(!("labels" in validateBrandStyle({ colors: eleven, fonts: [], labels: ["", ""] })));
  });
  it("refuse a name with odd characters or that is too long, and say which colour", () => {
    assert.throws(() => validateColorLabels(["<b>x</b>"], 1), /Colour 10: the name can have letters/);
    assert.throws(() => validateColorLabels(["a".repeat(41)], 1), /up to 40 characters/);
  });
  it("saved colours from before (no names) still open and keep their order", () => {
    const old = JSON.stringify({ colors: ["#0B3D91", ...Array(8).fill(""), "#ABCDEF"], fonts: [] });
    const s = parseBrandStyle(old);
    assert.equal(s.colors[9], "#ABCDEF");
    assert.match(brandStyleLines(s).join("\n"), /- Extra colour 1: #ABCDEF/);
  });
});

describe("what the generator is told about the colours", () => {
  it("lists navigation, footer and side menu colours by name and says where each is used", () => {
    const s = validateBrandStyle({ colors: ["#0B3D91", ...Array(8).fill("")], fonts: [], more: { navBg: "#111111", navText: "#EEEEEE", navLink: "#FFD166", footerBg: "#222222", footerLink: "#9ECBFF", sideBg: "#0F172A", sideLink: "#93C5FD", borders: "#CBD5E1" } });
    const text = brandStyleLines(s).join("\n");
    assert.match(text, /- Navigation background: #111111/);
    assert.match(text, /- Navigation link: #FFD166/);
    assert.match(text, /- Footer link: #9ECBFF/);
    assert.match(text, /- Side menu link: #93C5FD/);
    assert.match(text, /- Borders and dividers: #CBD5E1/);
    assert.match(text, /Use the navigation colours only in the top navigation bar, the footer colours only in the footer, the side menu colours only in the side navigation/);
  });
  it("adds no placement rule for parts that have no colours", () => {
    const text = brandStyleLines(validateBrandStyle({ colors: ["#0B3D91", ...Array(8).fill("")], fonts: [], more: { footerBg: "#222222" } })).join("\n");
    assert.match(text, /Use the footer colours only in the footer\./);
    assert.ok(!/navigation colours|side menu colours/.test(text));
    assert.ok(!/Use the .* colours only/.test(brandStyleLines(validateBrandStyle({ colors: ["#0B3D91", ...Array(8).fill("")], fonts: [] })).join("\n")));
  });
});
