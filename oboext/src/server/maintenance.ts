import { getOption, setOption } from "./options.js";
import type { SessionUser } from "./auth.js";

const OPTION_KEY = "maintenanceSettings";

export interface MaintenanceSettings {
  enabled: boolean;
  title: string;

  message: string;
}

const DEFAULT_SETTINGS: MaintenanceSettings = {
  enabled: false,
  title: "",
  message: "",
};

export async function getMaintenanceSettings(): Promise<MaintenanceSettings> {
  const stored = (await getOption<Partial<MaintenanceSettings>>(OPTION_KEY, {})) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveMaintenanceSettings(
  input: Partial<MaintenanceSettings>,
): Promise<MaintenanceSettings> {
  const current = await getMaintenanceSettings();
  const next: MaintenanceSettings = {
    enabled:
      typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    title:
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim().slice(0, 120)
        : current.title,
    message:
      typeof input.message === "string"
        ? input.message.slice(0, 1000)
        : current.message,
  };
  await setOption(OPTION_KEY, next);
  return next;
}

export async function maintenanceGate(
  user: SessionUser | null | undefined,
): Promise<MaintenanceSettings | null> {
  const settings = await getMaintenanceSettings();
  if (!settings.enabled) return null;
  if (user && (user.role === "admin" || user.role === "editor")) return null;
  return settings;
}
