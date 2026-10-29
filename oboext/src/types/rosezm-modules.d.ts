// Local declarations for the Rosezm subpaths the app imports. The package's
// exports map ships no `types` entries (BUG.md CE), so tsc would otherwise
// treat these modules as `any` — delete this file once the framework
// publishes real declarations. Signatures mirror the framework source.
declare module "rosezm/runtime" {
  export interface RosezmStore<T> {
    get(): T;
    set(v: T): void;
    update(fn: (v: T) => T): void;
  }
  export function $store<T>(name: string, initial: T): RosezmStore<T>;
  export function $data<T>(fn: () => T | Promise<T>): Promise<T>;
}
declare module "rosezm/export" {
  export type TargetName =
    | "weapp"
    | "qq"
    | "alipay"
    | "baidu"
    | "toutiao"
    | "flutter"
    | "android"
    | "arkts"
    | "xcode"
    | "electron"
    | "python"
    | "dotnet"
    | "java"
    | "cpp";
  export interface TargetInfo {
    name: TargetName;
    family: "mini-program" | "native" | "desktop";
    dir: string;
    status: "ready" | "planned";
    summary: string;
  }
  export const TARGETS: Record<TargetName, TargetInfo>;
  export function isTarget(name: string): name is TargetName;
  export function targetList(): string;
  export interface ExportOptions {
    apiBase?: string;
    outRoot?: string;
    cloud?: boolean;
    cloudEnv?: string;
  }
  export interface ExportResult {
    target: TargetName;
    outDir: string;
    pages: string[];
    components: string[];
    warnings: string[];
  }
  export function exportProject(
    target: TargetName,
    projectRoot: string,
    opts?: ExportOptions,
  ): Promise<ExportResult>;
}
