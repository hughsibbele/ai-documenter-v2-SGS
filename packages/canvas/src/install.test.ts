import { describe, it, expect } from "vitest";
import {
  buildReflectionBlock,
  findReflectionBlock,
  findReflectionMarkerBlock,
  hasReflectionMarkerBlock,
  removeReflectionBlock,
  replaceOrAppendReflectionBlock,
} from "./install";

const APP_BASE = "https://ai-documenter-v2-teacher-admin.vercel.app";
const TOKEN = "abc123_def-456";

describe("buildReflectionBlock", () => {
  it("renders the canonical begin/card/end shape", () => {
    const out = buildReflectionBlock({
      appBaseUrl: APP_BASE,
      iframeToken: TOKEN,
      promptVersion: 4,
    });
    expect(out).toContain("<!-- ehs-ai-reflect:begin");
    expect(out).toContain(`iframe-token=${TOKEN}`);
    expect(out).toContain("prompt-version=4");
    expect(out).toContain("v=2");
    expect(out).toContain("<!-- ehs-ai-reflect:end -->");
    // The card itself
    expect(out).toContain('<div style="border:2px solid #7a1e46');
    expect(out).toContain("Episcopal High School");
    expect(out).toContain(`href="${APP_BASE}/r/${TOKEN}"`);
    expect(out).toContain(`src="${APP_BASE}/brand/ehs-horizontal.webp"`);
    expect(out).toContain("Open reflection");
  });

  it("strips a trailing slash from the app base URL", () => {
    const out = buildReflectionBlock({
      appBaseUrl: `${APP_BASE}/`,
      iframeToken: TOKEN,
      promptVersion: 1,
    });
    expect(out).toContain(`href="${APP_BASE}/r/${TOKEN}"`);
    expect(out).not.toContain(`//r/`);
  });

  it("encodes ampersands and HTML-special chars in URLs", () => {
    // Base URLs shouldn't have ampersands in practice, but defensive escaping
    // matters if a future env var carries one.
    const out = buildReflectionBlock({
      appBaseUrl: "https://example.com/a&b",
      iframeToken: TOKEN,
      promptVersion: 1,
    });
    expect(out).toContain("a&amp;b/r/");
    expect(out).not.toContain('a&b/r/"');
  });

  it("rejects iframe tokens with unsafe characters", () => {
    expect(() =>
      buildReflectionBlock({
        appBaseUrl: APP_BASE,
        iframeToken: "abc def",
        promptVersion: 1,
      }),
    ).toThrow(/iframe-token/);
    expect(() =>
      buildReflectionBlock({
        appBaseUrl: APP_BASE,
        iframeToken: "x>y",
        promptVersion: 1,
      }),
    ).toThrow(/iframe-token/);
  });

  it("throws when appBaseUrl is empty", () => {
    expect(() =>
      buildReflectionBlock({
        appBaseUrl: "",
        iframeToken: TOKEN,
        promptVersion: 1,
      }),
    ).toThrow(/appBaseUrl/);
  });
});

describe("findReflectionMarkerBlock", () => {
  it("finds a freshly-built block round-trip", () => {
    const block = buildReflectionBlock({
      appBaseUrl: APP_BASE,
      iframeToken: TOKEN,
      promptVersion: 4,
    });
    const found = findReflectionMarkerBlock(block);
    expect(found).not.toBeNull();
    expect(found!.iframeToken).toBe(TOKEN);
    expect(found!.promptVersion).toBe(4);
    expect(found!.schemaVersion).toBe(2);
    expect(found!.start).toBe(0);
    expect(found!.end).toBe(block.length);
  });

  it("finds a block embedded in surrounding teacher content", () => {
    const block = buildReflectionBlock({
      appBaseUrl: APP_BASE,
      iframeToken: TOKEN,
      promptVersion: 2,
    });
    const html = `<p>Read chapter 3.</p>\n\n${block}\n\n<p>Due Friday.</p>`;
    const found = findReflectionMarkerBlock(html);
    expect(found).not.toBeNull();
    expect(found!.iframeToken).toBe(TOKEN);
    expect(html.slice(found!.start, found!.end)).toBe(block);
  });

  it("tolerates extra whitespace inside the begin/end comments", () => {
    const html =
      `<!--   ehs-ai-reflect:begin   v=2 iframe-token=tok1 prompt-version=2   -->\n` +
      `<div>card</div>\n` +
      `<!--   ehs-ai-reflect:end   -->`;
    const found = findReflectionMarkerBlock(html);
    expect(found).not.toBeNull();
    expect(found!.iframeToken).toBe("tok1");
    expect(found!.promptVersion).toBe(2);
  });

  it("returns null when there's no begin marker", () => {
    expect(findReflectionMarkerBlock("<p>nothing here</p>")).toBeNull();
  });

  it("returns null when begin is present but end is missing (orphan)", () => {
    const html =
      `<!-- ehs-ai-reflect:begin v=2 iframe-token=tok1 prompt-version=2 -->\n` +
      `<div>card</div>`;
    expect(findReflectionMarkerBlock(html)).toBeNull();
  });

  it("does not match a stray end marker without a begin", () => {
    expect(
      findReflectionMarkerBlock("<p>before</p><!-- ehs-ai-reflect:end --><p>after</p>"),
    ).toBeNull();
  });

  it("parses missing prompt-version as null", () => {
    const html =
      `<!-- ehs-ai-reflect:begin v=2 iframe-token=tok1 -->\n` +
      `<div>card</div>\n` +
      `<!-- ehs-ai-reflect:end -->`;
    const found = findReflectionMarkerBlock(html);
    expect(found?.promptVersion).toBeNull();
    expect(found?.iframeToken).toBe("tok1");
  });
});

describe("hasReflectionMarkerBlock", () => {
  it("is true for a valid block", () => {
    const block = buildReflectionBlock({
      appBaseUrl: APP_BASE,
      iframeToken: TOKEN,
      promptVersion: 1,
    });
    expect(hasReflectionMarkerBlock(block)).toBe(true);
  });
  it("is false for empty / unrelated content", () => {
    expect(hasReflectionMarkerBlock("")).toBe(false);
    expect(hasReflectionMarkerBlock("<p>hello</p>")).toBe(false);
  });
});

describe("replaceOrAppendReflectionBlock", () => {
  const blockA = buildReflectionBlock({
    appBaseUrl: APP_BASE,
    iframeToken: "tokA",
    promptVersion: 1,
  });
  const blockB = buildReflectionBlock({
    appBaseUrl: APP_BASE,
    iframeToken: "tokA",
    promptVersion: 2,
  });

  it("appends to empty existing description", () => {
    expect(replaceOrAppendReflectionBlock("", blockA)).toBe(blockA);
  });

  it("appends with separator to non-empty content", () => {
    const out = replaceOrAppendReflectionBlock("<p>Read chapter 3.</p>", blockA);
    expect(out).toBe("<p>Read chapter 3.</p>\n\n" + blockA);
  });

  it("replaces an existing block in place", () => {
    const before = `<p>top</p>\n\n${blockA}\n\n<p>bottom</p>`;
    const after = replaceOrAppendReflectionBlock(before, blockB);
    expect(after).toContain(blockB);
    expect(after).not.toContain("prompt-version=1");
    expect(after).toContain("<p>top</p>");
    expect(after).toContain("<p>bottom</p>");
  });

  it("is idempotent across repeated installs (no duplication)", () => {
    let html = "";
    for (let i = 1; i <= 5; i++) {
      const block = buildReflectionBlock({
        appBaseUrl: APP_BASE,
        iframeToken: TOKEN,
        promptVersion: i,
      });
      html = replaceOrAppendReflectionBlock(html, block);
    }
    // Exactly one begin + one end marker.
    const beginMatches = html.match(/ehs-ai-reflect:begin/g) ?? [];
    const endMatches = html.match(/ehs-ai-reflect:end/g) ?? [];
    expect(beginMatches.length).toBe(1);
    expect(endMatches.length).toBe(1);
    // Carries the latest prompt-version.
    const found = findReflectionMarkerBlock(html);
    expect(found?.promptVersion).toBe(5);
  });

  it("preserves teacher edits to surrounding content across reinstall", () => {
    const before = `<p>Read chapter 3.</p>\n\n${blockA}\n\n<p>Due Friday.</p>`;
    const after = replaceOrAppendReflectionBlock(before, blockB);
    expect(after).toContain("<p>Read chapter 3.</p>");
    expect(after).toContain("<p>Due Friday.</p>");
  });

  it("treats null / undefined existing content as empty string", () => {
    // @ts-expect-error — runtime test for safety
    expect(replaceOrAppendReflectionBlock(null, blockA)).toBe(blockA);
    // @ts-expect-error — runtime test for safety
    expect(replaceOrAppendReflectionBlock(undefined, blockA)).toBe(blockA);
  });
});

describe("removeReflectionBlock", () => {
  const block = buildReflectionBlock({
    appBaseUrl: APP_BASE,
    iframeToken: TOKEN,
    promptVersion: 3,
  });

  it("strips the block and the surrounding blank line", () => {
    const before = `<p>top</p>\n\n${block}\n\n<p>bottom</p>`;
    const after = removeReflectionBlock(before);
    expect(after).toBe("<p>top</p>\n\n<p>bottom</p>");
  });

  it("returns empty string when description was only the block", () => {
    expect(removeReflectionBlock(block)).toBe("");
  });

  it("is a no-op when block is absent", () => {
    expect(removeReflectionBlock("<p>nothing here</p>")).toBe(
      "<p>nothing here</p>",
    );
  });

  it("is idempotent — removing twice yields same result", () => {
    const before = `<p>top</p>\n\n${block}\n\n<p>bottom</p>`;
    const once = removeReflectionBlock(before);
    const twice = removeReflectionBlock(once);
    expect(twice).toBe(once);
  });
});

describe("comment-stripped card fallback", () => {
  // Simulates the Canvas-sanitizer-strips-HTML-comments scenario for the new
  // card: only the bare <div>...</div> survives. The token-aware fallback
  // should still find it by walking outward from the inner anchor's href.
  const TOKEN = "abc123def456";
  const block = buildReflectionBlock({
    appBaseUrl: APP_BASE,
    iframeToken: TOKEN,
    promptVersion: 1,
  });
  // Strip the marker comments, leaving the bare card:
  const stripped = block.replace(/<!--[^>]*-->\n?/g, "").trim();

  it("findReflectionBlock locates a comment-stripped card by token", () => {
    const found = findReflectionBlock(stripped, TOKEN);
    expect(found).not.toBeNull();
    expect(found?.iframeToken).toBe(TOKEN);
    // The match is the full outer card <div>...</div>
    expect(stripped.slice(found!.start, found!.end)).toContain(
      "border:2px solid #7a1e46",
    );
    expect(stripped.slice(found!.start, found!.end)).toContain(
      `/r/${TOKEN}`,
    );
  });

  it("replaceOrAppendReflectionBlock replaces a comment-stripped card in place (no duplication)", () => {
    const before = `<p>Reflect on your AI use:</p>\n\n${stripped}`;
    const after = replaceOrAppendReflectionBlock(before, block, TOKEN);
    expect((after.match(/border:2px solid #7a1e46/g) ?? []).length).toBe(1);
    expect(after).toContain(block);
  });

  it("removeReflectionBlock strips a comment-stripped card by token", () => {
    const before = `<p>top</p>\n\n${stripped}\n\n<p>bottom</p>`;
    const after = removeReflectionBlock(before, TOKEN);
    expect(after).not.toContain("border:2px solid #7a1e46");
    expect(after).toContain("<p>top</p>");
    expect(after).toContain("<p>bottom</p>");
  });

  it("findReflectionBlock without a token falls back to marker-only behavior", () => {
    expect(findReflectionBlock(stripped)).toBeNull();
    expect(findReflectionBlock(`<p>${block}</p>`)).not.toBeNull();
  });

  it("leaves the teacher's own wrapping div alone (innermost wins)", () => {
    const teacherWrap = `<div class="teacher-wrap"><p>preamble</p>${stripped}<p>postscript</p></div>`;
    const after = removeReflectionBlock(teacherWrap, TOKEN);
    expect(after).toContain('<div class="teacher-wrap">');
    expect(after).toContain("preamble");
    expect(after).toContain("postscript");
    expect(after).not.toContain("border:2px solid #7a1e46");
  });
});

describe("pre-M2 legacy iframe cleanup", () => {
  // Simulates the state on disk after a pre-M2 install. Reinstall under M2
  // should swap the iframe block out for the new card.
  const TOKEN = "abc123def456";
  const legacyIframe = `<iframe src="https://app.example.com/?iframe_token=${TOKEN}" width="100%" height="720" style="border:0;"></iframe>`;
  const newBlock = buildReflectionBlock({
    appBaseUrl: APP_BASE,
    iframeToken: TOKEN,
    promptVersion: 1,
  });

  it("reinstall replaces a bare legacy iframe with the new card", () => {
    const before = `<p>Reflect on your AI use:</p>\n\n${legacyIframe}`;
    const after = replaceOrAppendReflectionBlock(before, newBlock, TOKEN);
    expect(after).not.toContain("<iframe");
    expect(after).toContain(newBlock);
    expect(after).toContain("<p>Reflect on your AI use:</p>");
  });

  it("removeReflectionBlock strips a bare legacy iframe by token", () => {
    const before = `<p>top</p>\n\n${legacyIframe}\n\n<p>bottom</p>`;
    const after = removeReflectionBlock(before, TOKEN);
    expect(after).not.toContain("<iframe");
    expect(after).toContain("<p>top</p>");
    expect(after).toContain("<p>bottom</p>");
  });

  it("reinstall converges on a single card when both a marker-wrapped v=1 iframe AND a bare iframe exist", () => {
    // Mixed legacy state: one block with v=1 markers, one duplicate bare iframe
    // (the pre-fix comment-stripping bug). M2 reinstall cleans both up.
    const legacyMarkerBlock = [
      `<!-- ehs-ai-reflect:begin v=1 iframe-token=${TOKEN} prompt-version=1 -->`,
      legacyIframe,
      `<!-- ehs-ai-reflect:end -->`,
    ].join("\n");
    const before = `<p>top</p>\n\n${legacyMarkerBlock}\n\n${legacyIframe}\n\n<p>bottom</p>`;
    const after = replaceOrAppendReflectionBlock(before, newBlock, TOKEN);
    expect((after.match(/<iframe/g) ?? []).length).toBe(0);
    expect((after.match(/ehs-ai-reflect:begin/g) ?? []).length).toBe(1);
    expect(after).toContain("<p>top</p>");
    expect(after).toContain("<p>bottom</p>");
    expect(after).toContain("v=2");
  });
});
