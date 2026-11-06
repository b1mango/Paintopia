import { describe, expect, it } from "vitest";
import { moduleFromPath, pathForModule } from "../src/app/App";

const routes = [
  ["create", "/app/create"],
  ["prompt-library", "/app/prompt-library"],
  ["gallery", "/app/gallery"],
  ["assets", "/app/assets"],
  ["usage-log", "/app/usage-log"],
  ["settings", "/app/settings"],
  ["profile", "/app/settings/profile"],
  ["config", "/app/config"],
  ["config-image", "/app/config/image"],
  ["config-text", "/app/config/text"],
  ["config-prompt", "/app/config/prompt"],
  ["config-pricing", "/app/config/pricing"],
  ["config-gallery", "/app/config/gallery"],
  ["config-users", "/app/config/users"],
  ["config-maintenance", "/app/config/maintenance"]
] as const;

describe("app route mapping", () => {
  it.each(routes)("maps %s to its product route %s", (moduleId, path) => {
    expect(pathForModule(moduleId)).toBe(path);
    expect(moduleFromPath(path)).toBe(moduleId);
  });
  it.each(routes.filter(([id]) => id.startsWith("config-")))(
    "matches %s before the config parent, including nested paths",
    (moduleId, path) => {
      expect(moduleFromPath(path + "/")).toBe(moduleId);
      expect(moduleFromPath(path + "/details")).toBe(moduleId);
      expect(moduleFromPath(path + "-old")).toBe("config");
    }
  );
  it("matches profile before its settings parent", () => {
    expect(moduleFromPath("/app/settings/profile/")).toBe("profile");
    expect(moduleFromPath("/app/settings/profile/details")).toBe("profile");
    expect(moduleFromPath("/app/settings/")).toBe("settings");
  });
  it.each(["/app/config/account", "/app/config/settings"])(
    "sends retired admin account route %s to the admin overview",
    (path) => expect(moduleFromPath(path)).toBe("config")
  );
  it.each(["/app/admin", "/app/stats", "/app/account", "/app/prompt-tools"])(
    "does not retain retired module route %s",
    (path) => expect(moduleFromPath(path)).toBe("create")
  );
  it.each(["/", "/unknown", "/app/configuration", "/app/assets-old"])(
    "falls back to create for unrecognized path %s",
    (path) => expect(moduleFromPath(path)).toBe("create")
  );
});
