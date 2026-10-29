#!/usr/bin/env node
/**
 * Icon optimizer for Oboext's admin icon set.
 *
 * ## Why this exists
 *
 * The 1539 SVGs under `oboext/public/icons/` are consumed two different ways:
 *
 *   1. As a CSS mask (the admin chrome):
 *        .adm-ic { mask-image: var(--i); background-color: currentColor; }
 *        <span class="adm-ic" style="--i: url(/public/icons/database-backup.svg)">
 *   2. Inlined into the page as markup (the public themes), by
 *        `lucideSvg()` in oboext/src/server/theme-chrome.ts, which reads the
 *        SAME files off disk and rewrites the colour:
 *        svg.replace(/stroke="#[0-9a-fA-F]{3,8}"/, 'stroke="currentColor"')
 *
 * Nothing is fetched eagerly - a page requests only the icons it references -
 * so the "1539 requests" problem the previous version of this file claimed
 * does not exist. What DOES cost bytes is per-file overhead repeated 1539
 * times: the fixed width/height, the lucide class names, and the
 * pretty-printing.
 *
 * ## The trap this file previously fell into
 *
 * An earlier version stripped `stroke="#a1a1aa"` on the reasoning that "a mask
 * only reads the shape, the colour comes from currentColor". **That was wrong,
 * and it blanked every icon on the site.** A CSS mask uses the image's ALPHA
 * channel, and these files are `fill="none"` outlines: the paths are painted
 * by `stroke` and by nothing else. With `stroke` absent the SVG spec's initial
 * value `stroke: none` applies, nothing is painted, alpha is 0 everywhere, and
 * the mask resolves to "hide this element". Worse, `lucideSvg()`'s
 * colour-rewrite regex then had nothing to match, so the INLINED theme icons
 * lost their stroke too and rendered as blank boxes.
 *
 * The colour VALUE is indeed irrelevant under a mask, but the ATTRIBUTE is
 * load-bearing: it is what makes the geometry get painted at all. So this tool
 * normalises the colour to `currentColor` (which is correct for consumer (2)
 * and harmless for consumer (1)) instead of deleting the attribute.
 *
 * So this tool does NOT build a sprite. A sprite would be worse: inlining every
 * path as a `data:` URI means a page showing 6 icons downloads all 1539 shapes,
 * and mask-image cannot address a sprite without `use`/`symbol` plumbing the
 * current markup does not have.
 *
 * ## What it does, per file
 *   - normalise `stroke="#rrggbb"` to `stroke="currentColor"` (never removed)
 *   - drop `width`/`height` (CSS sizes the box; the viewBox scales)
 *   - drop `class="lucide lucide-*"` (nothing selects on it in this app)
 *   - collapse the pretty-printing whitespace between tags
 *
 * ## Safety
 *
 * - Default is a DRY RUN that only reports the saving. Pass `--apply` to write.
 * - Every rewrite is re-validated before acceptance: root <svg> present, the
 *   viewBox unchanged, the element count unchanged, and **a `stroke=` attribute
 *   still present**. A file that fails any check is left untouched and reported
 *   rather than written, and the process exits non-zero so a half-done rewrite
 *   cannot pass silently in CI.
 * - `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `fill`, `opacity` and
 *   `transform` are never touched: they all affect the rendered geometry.
 * - Output is deterministic - identical input yields identical bytes, so a
 *   rebuild produces no spurious diffs.
 *
 * ## Usage
 *
 *   node tools/build-svg-sprite.mjs            # dry run, report the saving
 *   node tools/build-svg-sprite.mjs --verify   # check only, never write
 *   node tools/build-svg-sprite.mjs --apply    # rewrite in place
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS_DIR = join(ROOT, "oboext", "public", "icons");

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const VERIFY = args.has("--verify");

/**
 * Normalise what is safe to change, and nothing else.
 *
 * The one rule: an attribute may only be removed when CSS already supplies the
 * same thing. `stroke` may be REWRITTEN but never removed - see the trap
 * described at the top of this file.
 */
function minify(svg) {
  let out = svg;

  // A mask ignores the colour VALUE, but the attribute is what makes these
  // fill="none" outlines get painted at all. `currentColor` is also exactly
  // what lucideSvg() would have rewritten it to, so inlining stays correct.
  out = out.replace(/\bstroke="(#[0-9a-fA-F]{3,8})"/g, 'stroke="currentColor"');

  // CSS sizes the box; the viewBox does the scaling - so the root <svg>'s
  // width/height are redundant. ONLY the root tag: a global replace also strips
  // the width/height off every nested <rect>/<image>/<svg>, and that is
  // GEOMETRY, not presentation. A <rect> with no width renders nothing, so the
  // icon comes out with holes in it. That bug shipped here once already.
  // Applied twice because these are independent attributes and one pass each
  // can leave the second behind.
  for (let i = 0; i < 2; i++) {
    out = out.replace(/^(<svg\b[^>]*?)\s+(?:width|height)="\d+(?:\.\d+)?"/, (m, head) => head);
  }
  // Nothing in the admin stylesheet selects on the lucide class names.
  out = out.replace(/\s+class="lucide[^"]*"/g, "");
  // Pretty-printing: whitespace between tags carries no meaning in SVG. The
  // pattern only matches '>' ... '<' runs, so whitespace INSIDE an attribute
  // value is never touched.
  out = out.replace(/>\s+</g, "><");

  return out.trim();
}

/**
 * Every element that needs an explicit size to render at all.
 *
 * A <rect> without width renders nothing. A <circle> without r renders nothing.
 * These are GEOMETRY, and no amount of CSS can supply them - unlike the root
 * <svg>'s width/height, which the stylesheet does override. So the optimizer
 * must never touch them, and the validator must prove it didn't.
 */
function sizedElements(svg) {
  const out = [];
  const re = /<(rect|circle|ellipse|line|image)\b[^>]*>/g;
  let m;
  while ((m = re.exec(svg))) {
    out.push(m[0].trim());
  }
  return out;
}

/** Does a sized element still carry the attribute that makes it render? */
function isRenderable(tag) {
  const kind = /^<([a-zA-Z]+)/.exec(tag)?.[1];
  switch (kind) {
    case "rect":
      // A zero/absent width makes it invisible; x/y alone are enough for position.
      return /\bwidth\s*=/.test(tag) && /\bheight\s*=/.test(tag);
    case "circle":
      return /\br\s*=/.test(tag);
    case "ellipse":
      return /\brx\s*=/.test(tag) && /\bry\s*=/.test(tag);
    case "line":
      return /\bx1\s*=/.test(tag) && /\by2\s*=/.test(tag);
    case "image":
      return /\bwidth\s*=/.test(tag) && /\bheight\s*=/.test(tag);
    default:
      return true;
  }
}

/** The viewBox is the one thing that must survive: it is what makes the shape
 *  scale into the CSS-sized box. */
function viewBoxOf(svg) {
  const m = /\bviewBox="([^"]+)"/.exec(svg);
  return m ? m[1].trim() : "";
}

/**
 * A shape-preserving check, not merely "does it parse": a rewrite that dropped
 * the viewBox or a path would still be well-formed XML and would silently
 * render as nothing at all. Comparing element counts catches that.
 */
function countTags(svg) {
  return {
    opens: (svg.match(/<(?!\/)[a-zA-Z]/g) || []).length,
    closes: (svg.match(/<\//g) || []).length,
  };
}

let files;
try {
  files = readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg"));
} catch {
  console.error("icon directory not found: %s", ICONS_DIR);
  process.exit(1);
}

let checked = 0;
let changed = 0;
let skipped = 0;
let before = 0;
let after = 0;
const problems = [];

for (const file of files) {
  const fp = join(ICONS_DIR, file);
  const src = readFileSync(fp, "utf8");
  const min = minify(src);
  checked++;
  before += Buffer.byteLength(src);

  if (!min.startsWith("<svg")) {
    skipped++;
    problems.push(`${file}: root <svg> lost`);
    continue;
  }
  if (!viewBoxOf(src) || viewBoxOf(min) !== viewBoxOf(src)) {
    skipped++;
    problems.push(`${file}: viewBox lost or changed`);
    continue;
  }
  const a = countTags(src);
  const b = countTags(min);
  if (a.opens !== b.opens || a.closes !== b.closes) {
    skipped++;
    problems.push(`${file}: element count changed (${a.opens}/${a.closes} -> ${b.opens}/${b.closes})`);
    continue;
  }
  // The check whose absence caused the outage: these are fill="none" outlines,
  // so without a stroke attribute the file paints nothing and every consumer
  // (CSS mask AND inline markup) renders an empty box.
  if (!/\bstroke="/.test(min)) {
    skipped++;
    problems.push(`${file}: no stroke attribute - the paths would not paint`);
    continue;
  }
  // The second outage, same shape of mistake: a global width/height strip takes
  // the dimensions off nested <rect>/<circle>/<image> too. Those are geometry -
  // nothing in CSS supplies them - so a <rect width="16"> losing its width stops
  // being drawn and the icon renders with holes. Compare element-by-element
  // rather than by count: a count check passes while a rect silently emptied.
  const srcSized = sizedElements(src);
  const minSized = sizedElements(min);
  let emptied = null;
  if (srcSized.length !== minSized.length) {
    emptied = `sized element count ${srcSized.length} -> ${minSized.length}`;
  } else {
    for (let i = 0; i < srcSized.length; i++) {
      if (!isRenderable(minSized[i]) && isRenderable(srcSized[i])) {
        emptied = `element lost its size: ${srcSized[i]}`;
        break;
      }
    }
  }
  if (emptied) {
    skipped++;
    problems.push(`${file}: ${emptied}`);
    continue;
  }

  after += Buffer.byteLength(min);
  if (min !== src) {
    changed++;
    if (APPLY) writeFileSync(fp, min, "utf8");
  }
}

const saved = before - after;
const pct = before ? ((saved / before) * 100).toFixed(1) : "0.0";
console.log(`icons : ${checked} checked, ${changed} changed, ${skipped} skipped`);
console.log(`size  : ${(before / 1024).toFixed(1)} KB -> ${(after / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB, ${pct}%)`);
console.log(`mode  : ${VERIFY ? "verify" : APPLY ? "APPLY (written)" : "dry run (pass --apply to write)"}`);

if (problems.length) {
  console.log(`\n${problems.length} file(s) left untouched:`);
  for (const p of problems.slice(0, 20)) console.log("  " + p);
  if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`);
  process.exitCode = 1;
}
