// Marker-block helpers for the install-it-for-you flow.
//
// The teacher's Canvas assignment description is HTML they own. We embed our
// reflection card inside a pair of HTML comment markers so we can find,
// replace, and remove our block without disturbing anything else they wrote:
//
//   <!-- ehs-ai-reflect:begin v=2 iframe-token=abc123 prompt-version=4 -->
//   <div style="border:..."> ... EHS card ... </div>
//   <!-- ehs-ai-reflect:end -->
//
// Operations are pure (no I/O) so they can be unit-tested in isolation. The
// network-touching install flow (read description → patch → PUT) lives one
// layer up in the teacher-admin app.
//
// History: pre-M2, the inner block was an <iframe>. M2 swapped to a Canvas-
// description card so students follow a link to the standalone reflection app
// rather than running it embedded. The legacy-iframe-by-token fallback below
// stays so reinstalls cleanly replace pre-M2 blocks with the new card.

const BEGIN_RE =
  /<!--\s*ehs-ai-reflect:begin(\s+[^>]*?)?\s*-->/i;
const END_RE = /<!--\s*ehs-ai-reflect:end\s*-->/i;

export type MarkerBlockMeta = {
  iframeToken: string | null;
  promptVersion: number | null;
  schemaVersion: number | null;
};

export type FoundMarkerBlock = MarkerBlockMeta & {
  /** Index in the source HTML where the block starts. */
  start: number;
  /** Index immediately after the end of the block. */
  end: number;
  /** The block's full text as it appeared (for replace operations). */
  raw: string;
};

export type BuildReflectionBlockArgs = {
  /**
   * App origin where the standalone reflection lives. Used to construct both
   * the CTA link (`${base}/r/${iframeToken}`) and the logo image src
   * (`${base}/brand/ehs-horizontal.webp`).
   *
   * Example: "https://ai-documenter-v2-teacher-admin.vercel.app" or
   * "http://localhost:3001". Trailing slash is fine; we strip it.
   */
  appBaseUrl: string;
  /** Random per-assignment token (URL slug, NOT the Canvas assignment ID). */
  iframeToken: string;
  /** Monotonic prompt version, bumped on every prompt save. */
  promptVersion: number;
};

const SCHEMA_VERSION = 2;

/**
 * Render the marker-wrapped EHS reflection card. Pure string concat — caller
 * is responsible for ensuring appBaseUrl is the right origin for the
 * environment (NEXT_PUBLIC_APP_URL in our app — legacy name
 * NEXT_PUBLIC_STUDENT_FORM_URL still read as fallback during M4.3 transition).
 *
 * Output goes into a Canvas assignment description, which is sanitized HTML.
 * We rely only on tags + inline styles Canvas's RCE permits: `div`, `img`,
 * `h3`, `p`, `a`, and inline `style` attrs. No classes (Canvas may strip
 * unknown ones), no data attrs (likewise), no JS.
 */
export function buildReflectionBlock(args: BuildReflectionBlockArgs): string {
  const base = args.appBaseUrl.replace(/\/$/, "");
  if (!base) {
    throw new Error("buildReflectionBlock: appBaseUrl is required");
  }
  const token = escapeMarkerAttr(args.iframeToken);
  const reflectionUrl = escapeHtmlAttr(`${base}/r/${token}`);
  const logoUrl = escapeHtmlAttr(`${base}/brand/ehs-horizontal.webp`);
  return [
    `<!-- ehs-ai-reflect:begin v=${SCHEMA_VERSION} iframe-token=${token} prompt-version=${args.promptVersion} -->`,
    `<div style="border:2px solid #7a1e46;border-radius:4px;padding:28px;margin:16px 0;background:#ffffff;font-family:Georgia,'Times New Roman',serif;">`,
    `<img src="${logoUrl}" alt="Episcopal High School" style="display:block;height:50px;width:auto;margin-bottom:18px;" />`,
    `<div style="color:#54565b;font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;">AI Use Reflection &middot; Required for credit</div>`,
    `<h3 style="margin:0 0 10px 0;color:#1a1a1a;font-size:20px;font-weight:normal;line-height:1.3;">Reflect on your AI use for this assignment</h3>`,
    `<p style="margin:0 0 22px 0;color:#333;font-size:15px;line-height:1.6;">Before this assignment is complete, you'll have a brief Socratic conversation about how you used AI tools while working &mdash; Gemini, ChatGPT, Claude, or others. It takes 5&ndash;10 minutes, and your reflection submits to Canvas automatically when you finish.</p>`,
    `<a href="${reflectionUrl}" style="display:inline-block;padding:12px 26px;background:#7a1e46;color:#ffffff;border-radius:3px;text-decoration:none;font-family:Georgia,'Times New Roman',serif;font-weight:bold;font-size:15px;letter-spacing:0.3px;">Open reflection &rarr;</a>`,
    `<p style="margin:14px 0 0 0;color:#54565b;font-size:12px;font-style:italic;">Sign in with your @episcopalhighschool.org Google account.</p>`,
    `</div>`,
    `<!-- ehs-ai-reflect:end -->`,
  ].join("\n");
}

/**
 * Locate the first marker block in `html`. Returns null if absent.
 * If a begin marker has no matching end marker, returns null (orphan markers
 * are treated as "not present" so a subsequent install repairs them).
 */
export function findReflectionMarkerBlock(html: string): FoundMarkerBlock | null {
  const beginMatch = BEGIN_RE.exec(html);
  if (!beginMatch) return null;
  const beginStart = beginMatch.index;
  const beginEnd = beginStart + beginMatch[0].length;

  const tail = html.slice(beginEnd);
  const endMatch = END_RE.exec(tail);
  if (!endMatch) return null;

  const end = beginEnd + endMatch.index + endMatch[0].length;
  const raw = html.slice(beginStart, end);
  const meta = parseBeginAttrs(beginMatch[1] ?? "");
  return { ...meta, start: beginStart, end, raw };
}

export function hasReflectionMarkerBlock(html: string): boolean {
  return findReflectionMarkerBlock(html) !== null;
}

/**
 * Locate our block via comment markers first, then by token-based fallbacks
 * for the (rare) case where Canvas's sanitizer stripped the comments. With
 * iframeToken, we'll find:
 *   - A bare card `<div>...</div>` whose CTA anchor points at /r/<token>
 *   - A legacy bare iframe whose src carries iframe_token=<token> (pre-M2)
 */
export function findReflectionBlock(
  html: string,
  iframeToken?: string,
): FoundMarkerBlock | null {
  const marker = findReflectionMarkerBlock(html);
  if (marker) return marker;
  if (!iframeToken) return null;
  const card = findCardBlockByToken(html, iframeToken);
  if (card) return card;
  return findLegacyIframeBlockByToken(html, iframeToken);
}

/**
 * Strip every block we own from the description: marker-wrapped blocks AND
 * (with iframeToken) bare cards by token AND legacy bare iframes by token.
 * Used by replace/remove to converge on "exactly zero of our blocks", so
 * past duplications and pre-M2 blocks get cleaned up automatically on the
 * next reinstall.
 */
function stripAllBlocks(html: string, iframeToken?: string): string {
  let out = html ?? "";
  const drain = (find: () => FoundMarkerBlock | null) => {
    while (true) {
      const m = find();
      if (!m) break;
      const before = out.slice(0, m.start).replace(/\s+$/, "");
      const after = out.slice(m.end).replace(/^\s+/, "");
      if (before === "") out = after;
      else if (after === "") out = before;
      else out = before + "\n\n" + after;
    }
  };
  drain(() => findReflectionMarkerBlock(out));
  if (iframeToken) {
    drain(() => findCardBlockByToken(out, iframeToken));
    drain(() => findLegacyIframeBlockByToken(out, iframeToken));
  }
  return out;
}

/**
 * Insert the block, ensuring exactly one of our blocks ends up in the
 * description. Strips any pre-existing block (marker-wrapped, card-by-token,
 * legacy-iframe-by-token, or duplicates of any) before inserting fresh.
 */
export function replaceOrAppendReflectionBlock(
  existingHtml: string,
  newBlockHtml: string,
  iframeToken?: string,
): string {
  const stripped = stripAllBlocks(existingHtml ?? "", iframeToken);
  const trimmed = stripped.replace(/\s+$/, "").replace(/^\s+/, "");
  if (trimmed === "") return newBlockHtml;
  return trimmed + "\n\n" + newBlockHtml;
}

/**
 * Strip every block we own from the description (and tidy surrounding
 * whitespace). With iframeToken, catches comment-stripped cards and legacy
 * iframes too. No-op when nothing is found.
 */
export function removeReflectionBlock(
  existingHtml: string,
  iframeToken?: string,
): string {
  const stripped = stripAllBlocks(existingHtml ?? "", iframeToken);
  if (stripped === (existingHtml ?? "")) return existingHtml ?? "";
  return stripped.replace(/\s+$/, "").replace(/^\s+/, "");
}

// ---------------------------------------------------------------------------
// Comment-stripped fallbacks. Canvas's sanitizer drops HTML comments on some
// edit paths; the inner block survives but loses its begin/end markers.

/**
 * Find a bare reflection card by its CTA anchor pointing at /r/<token>.
 * Returns the bounds of the INNERMOST enclosing `<div>`, which is the card
 * wrapper (the teacher's own wrapping containers, if any, are left alone).
 */
function findCardBlockByToken(
  html: string,
  iframeToken: string,
): FoundMarkerBlock | null {
  const safe = iframeToken.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return null;

  // Find an anchor whose href contains "/r/<token>". The full <a>...</a>
  // element is the locator; we then walk outward to find the enclosing div.
  const hrefRe = new RegExp(
    `<a\\b[^>]*\\bhref="[^"]*\\/r\\/${safe}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/a\\s*>`,
    "i",
  );
  const aMatch = hrefRe.exec(html);
  if (!aMatch) return null;
  const aStart = aMatch.index;
  const aEnd = aStart + aMatch[0].length;

  // Find all <div> openings BEFORE the anchor.
  const beforeA = html.slice(0, aStart);
  const opens: Array<{ index: number; end: number }> = [];
  const openTagRe = /<div\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = openTagRe.exec(beforeA)) !== null) {
    opens.push({ index: m.index, end: m.index + m[0].length });
  }
  if (opens.length === 0) return null;

  // Try INNERMOST first (last in opens). For each candidate, find the
  // matching </div> using depth counting. The first one whose close lands
  // after the anchor is our wrapper.
  for (let i = opens.length - 1; i >= 0; i--) {
    const open = opens[i];
    const closeEnd = findMatchingDivClose(html, open.end);
    if (closeEnd < 0) continue;
    if (closeEnd >= aEnd) {
      return {
        iframeToken: safe,
        promptVersion: null,
        schemaVersion: null,
        start: open.index,
        end: closeEnd,
        raw: html.slice(open.index, closeEnd),
      };
    }
  }
  return null;
}

/** Walk forward from `fromPos` counting <div>/</div> nesting; return the
 * position right after the matching </div>, or -1 if not found. */
function findMatchingDivClose(html: string, fromPos: number): number {
  let pos = fromPos;
  let depth = 1;
  const tagRe = /<(\/?)div\b[^>]*>/gi;
  while (depth > 0) {
    tagRe.lastIndex = pos;
    const m = tagRe.exec(html);
    if (!m) return -1;
    pos = m.index + m[0].length;
    if (m[1] === "/") {
      depth--;
      if (depth === 0) return pos;
    } else {
      depth++;
    }
  }
  return -1;
}

/**
 * Pre-M2 fallback: find a bare `<iframe>` element whose src carries
 * `iframe_token=<token>`. Kept so reinstalls converge on the new card even
 * when the teacher's assignment description still has a legacy iframe block.
 */
function findLegacyIframeBlockByToken(
  html: string,
  iframeToken: string,
): FoundMarkerBlock | null {
  const safe = iframeToken.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return null;
  const re = new RegExp(
    `<iframe\\b[^>]*\\biframe_token=${safe}\\b[^>]*>\\s*</iframe\\s*>`,
    "i",
  );
  const m = re.exec(html);
  if (!m) return null;
  return {
    iframeToken: safe,
    promptVersion: null,
    schemaVersion: null,
    start: m.index,
    end: m.index + m[0].length,
    raw: m[0],
  };
}

// ---------------------------------------------------------------------------

function parseBeginAttrs(attrText: string): MarkerBlockMeta {
  // attrText looks like " v=2 iframe-token=abc123 prompt-version=4"
  const meta: MarkerBlockMeta = {
    iframeToken: null,
    promptVersion: null,
    schemaVersion: null,
  };
  const ATTR_RE = /([a-z][a-z0-9-]*)\s*=\s*("([^"]*)"|([^\s]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrText)) !== null) {
    const key = m[1]?.toLowerCase();
    const value = m[3] ?? m[4] ?? "";
    if (key === "iframe-token") meta.iframeToken = value;
    else if (key === "prompt-version") {
      const n = Number(value);
      meta.promptVersion = Number.isFinite(n) ? n : null;
    } else if (key === "v") {
      const n = Number(value);
      meta.schemaVersion = Number.isFinite(n) ? n : null;
    }
  }
  return meta;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Marker attrs are inside an HTML comment — restrict to URL-safe chars. */
function escapeMarkerAttr(s: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new Error(
      `iframe-token must match /^[A-Za-z0-9_-]+$/. Got: ${JSON.stringify(s)}`,
    );
  }
  return s;
}
