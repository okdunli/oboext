#!/usr/bin/env node
/**
 * make-variants.mjs — generate `.wNNN` responsive variants for the images the
 * rosezm compiler turns into srcset (framework A4).
 *
 * A source image `public/img/hero.jpg` produces `hero.w400.jpg`,
 * `hero.w800.jpg`, `hero.w1600.jpg` (same directory, same format, downscaled,
 * never upscaled). The compiler picks them up automatically at build time —
 * run this once after adding a big image, then build as usual.
 *
 * Zero npm dependencies: the resize runs through Windows PowerShell's
 * System.Drawing (GDI+), which every Windows box has. JPEG sources get
 * quality 82; PNG sources stay PNG (lossless-ish, keep the alpha).
 *
 * Usage (from the app root, i.e. the directory containing oboext/):
 *   node oboext/tools/make-variants.mjs public/img/hero.jpg [more.jpg ...]
 *   node oboext/tools/make-variants.mjs --widths 480,960,1440 public/img/*.jpg
 *   node oboext/tools/make-variants.mjs --force public/img/hero.jpg
 *
 * Existing variants are skipped unless --force. Only files larger than the
 * variant width are downscaled.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const args = process.argv.slice(2);

let widths = [400, 800, 1600];
let force = false;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--widths") {
    widths = (args[++i] || "").split(",").map((n) => Number(n.trim())).filter((n) => n > 0);
    if (!widths.length) { console.error("E-USAGE: --widths needs comma-separated positive numbers"); process.exit(1); }
  } else if (args[i] === "--force") {
    force = true;
  } else {
    inputs.push(args[i]);
  }
}
if (!inputs.length) {
  console.error("Usage: node oboext/tools/make-variants.mjs [--widths 400,800,1600] [--force] <image...>");
  process.exit(1);
}

const JPEG = /\.(jpe?g)$/i;
const PNG = /\.png$/i;
const supported = (f) => JPEG.test(f) || PNG.test(f);

const jobs = [];
for (const input of inputs) {
  const abs = path.resolve(appRoot, input);
  if (!fs.existsSync(abs) || !supported(abs)) {
    console.error(`SKIP ${input} (missing or not jpg/png)`);
    continue;
  }
  for (const w of widths) {
    const ext = path.extname(abs);
    const variant = abs.slice(0, -ext.length) + `.w${w}` + ext;
    if (!force && fs.existsSync(variant)) {
      console.log(`SKIP ${path.basename(variant)} (exists)`);
      continue;
    }
    jobs.push({ src: abs, dst: variant, width: w, jpeg: JPEG.test(abs) });
  }
}
if (!jobs.length) { console.log("Nothing to do."); process.exit(0); }

const psJobs = JSON.stringify(jobs.map((j) => ({ s: j.src, d: j.dst, w: j.width, jpeg: j.jpeg })));
const ps = `
$jobs = '${psJobs.replace(/'/g, "''")}' | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
foreach ($j in $jobs) {
  $src = [System.Drawing.Image]::FromFile($j.s)
  try {
    if ($src.Width -le $j.w) { Write-Output ("SKIP " + $j.d + " (source smaller)"); continue }
    $h = [int][Math]::Round($src.Height * $j.w / $src.Width)
    $bmp = New-Object System.Drawing.Bitmap($j.w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, $j.w, $h)
    $g.Dispose()
    if ($j.jpeg) {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
      $bmp.Save($j.d, $codec, $ep)
    } else {
      $bmp.Save($j.d, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $bmp.Dispose()
    Write-Output ("OK " + $j.d)
  } finally { $src.Dispose() }
}
`;

try {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  process.stdout.write(out);
} catch (err) {
  console.error(String(err.stdout || ""));
  console.error("E-RESIZE: PowerShell/System.Drawing failed —", err.message);
  process.exit(1);
}
console.log(`Done: ${jobs.length} variant job(s).`);
