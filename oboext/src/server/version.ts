/**
 * oboext program version — single authoritative source.
 * Three-segment x.y.z, each digit 0-9; bumped only at milestones and kept
 * in sync with package.json (and the oboext-<version> backup
 * folder name — the running version must never drift from the folder).
 * Pure constants, safe for plugins to import.
 */
export const APP_NAME = "oboext";
export const APP_VERSION = "0.1.9";

export const APP_BRAND = `${APP_NAME} v${APP_VERSION}`;

