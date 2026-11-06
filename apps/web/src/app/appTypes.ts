

export type PaintopiaUser = { id?: string; email: string; role: "admin" | "user"; quota: number };

export type ConfigSection = "stats" | "image" | "text" | "prompt" | "pricing" | "gallery" | "users" | "maintenance";

export type ModuleId = "create" | "prompt-library" | "gallery" | "assets" | "usage-log" | "settings" | "profile" | "config" | "config-image" | "config-text" | "config-prompt" | "config-pricing" | "config-gallery" | "config-users" | "config-maintenance";
