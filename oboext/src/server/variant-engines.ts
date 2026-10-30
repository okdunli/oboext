import { execFile } from "node:child_process";
import { promisify } from "node:util";

// R355: image variants used to be Windows-only (PowerShell + GDI+), which
// silently disabled the whole responsive-image pipeline on Linux — the
// platforms the framework actually deploys to (Docker, Vercel). This module
// picks the FIRST available engine at first use and remembers the verdict:
//
//   gdi+       Windows: PowerShell System.Drawing, zero external deps
//   magick     ImageMagick 7 (`magick`) — the usual pick on Linux/docker
//   convert    ImageMagick 6 (`convert`) — older distros ship this name
//   ffmpeg     ffmpeg, as a last resort (fine quality, present almost everywhere)
//
// All engines implement the same contract: resize WITHOUT upscaling, skip
// widths whose output already exists, JPEG re-encodes at q82, PNG stays PNG.

const execFileP = promisify(execFile);

export type VariantEngine = "gdi+" | "magick" | "convert" | "ffmpeg" | "none";

export interface VariantJob {
  /** absolute source path */
  s: string;
  /** absolute destination path (.wNNN sibling) */
  d: string;
  /** target width; never upscale past the source */
  w: number;
  /** JPEG re-encodes at q82; PNG stays PNG */
  jpeg: boolean;
}

let cached: VariantEngine | null | undefined;

async function exists(name: string): Promise<boolean> {
  try {
    await execFileP(name, ["-version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** The first engine this host can run, or null. Probed once per process. */
export async function variantEngine(): Promise<VariantEngine | null> {
  if (cached !== undefined) return cached;
  if (process.platform === "win32") {
    cached = "gdi+";
  } else if (await exists("magick")) {
    cached = "magick";
  } else if (await exists("convert")) {
    cached = "convert";
  } else if (await exists("ffmpeg")) {
    cached = "ffmpeg";
  } else {
    cached = null;
  }
  return cached;
}

function magickArgs(j: VariantJob): string[] {
  // -resize "Wx>" : the trailing > means "only shrink", never upscale.
  // ImageMagick infers the format from the destination extension and keeps
  // its own default quality for JPEG (75-82 depending on build) — close
  // enough to the GDI+ q82 baseline without threading quality flags through
  // three engines.
  const filter = j.jpeg ? "-quality" : null;
  const base = [j.s, "-resize", `${j.w}x>`];
  return filter ? [...base, filter, "82", j.d] : [...base, j.d];
}

function ffmpegArgs(j: VariantJob): string[] {
  // scale=w=-2: the -2 keeps the height even (codec requirement) while
  // preserving the aspect ratio; force_original_aspect_ratio=decrease +
  // the explicit width cap means "at most this wide, never upscale".
  return [
    "-y",
    "-i",
    j.s,
    "-vf",
    `scale='min(${j.w},iw)':-2:force_original_aspect_ratio=decrease`,
    "-frames:v",
    "1",
    ...(j.jpeg ? ["-q:v", "3"] : []),
    j.d,
  ];
}

async function runOne(engine: VariantEngine, j: VariantJob): Promise<void> {
  switch (engine) {
    case "gdi+": {
      // The pre-R355 GDI+ script, one job per invocation (the old batch form
      // survives at the call site by looping jobs).
      const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${JSON.stringify(j.s)})
try {
  if ($src.Width -gt ${j.w}) {
    $h = [int][Math]::Round($src.Height * ${j.w} / $src.Width)
    $bmp = New-Object System.Drawing.Bitmap(${j.w}, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($src, 0, 0, ${j.w}, $h)
    $g.Dispose()
    if (${j.jpeg ? "$true" : "$false"}) {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
      $bmp.Save(${JSON.stringify(j.d)}, $codec, $ep)
    } else {
      $bmp.Save(${JSON.stringify(j.d)}, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $bmp.Dispose()
  }
} finally { $src.Dispose() }`;
      await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        timeout: 120_000,
      });
      return;
    }
    case "magick":
    case "convert":
      await execFileP(engine, magickArgs(j), { timeout: 120_000 });
      return;
    case "ffmpeg":
      await execFileP("ffmpeg", ffmpegArgs(j), { timeout: 120_000 });
      return;
    default:
      throw new Error(`no variant engine on this host`);
  }
}

/**
 * Generate every missing variant with the host's engine. Returns the engine
 * name on success, null when this host has no engine at all (callers must
 * surface that — it is not "nothing to do").
 */
export async function generateVariants(jobs: VariantJob[]): Promise<VariantEngine | null> {
  const engine = await variantEngine();
  if (!engine) return null;
  for (const j of jobs) {
    await runOne(engine, j);
  }
  return engine;
}

