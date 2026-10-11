import fs from "fs";

export function rmSyncRetry(target: string, attempts = 8): void {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw e;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60 * (i + 1));
  }
  if (fs.existsSync(target)) throw lastErr ?? new Error(`删除失败：${target}`);
}
