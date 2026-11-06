import {clearMediaCache} from "../lib/useMediaFeed";
import { Suspense, useEffect, useState } from "react";
import type { ModuleId, PaintopiaUser } from "./appTypes";
import { lazyPage } from "../lib/lazyPage";
import { LoginPage } from "../pages/LoginPage";
import { apiClient } from "../lib/apiClient";

const DEFAULT_APP_PATH = "/app/create";

// 工作台单独拆包：登录页不加载它；已登录路径上与 /auth/me 并行下载
const AppShell = lazyPage(() => import("./AppShell"), "AppShell");
if (typeof window !== "undefined" && window.location.pathname !== "/login") void AppShell.preload();
export const preloadApp = () => AppShell.preload().then(module => module.preloadAppPages());

export function App() {
  const route = useBrowserRoute();
  const [user, setUser] = useState<PaintopiaUser | null>(null);
  const [status, setStatus] = useState<"checking" | "idle" | "loading" | "error">("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient.me()
      .then((currentUser) => {
        if (!cancelled) {
          setUser(currentUser);
          setStatus("idle");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("idle");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (status === "checking" || route.path !== "/") {
      return;
    }
    navigateTo(user ? DEFAULT_APP_PATH : "/login");
  }, [route.path, status, user]);

  async function handleLogin(credentials: { email: string; password: string }) {
    void AppShell.preload();
    setStatus("loading");
    setError(null);
    try {
      const loggedInUser = await apiClient.login(credentials);
      setUser(loggedInUser);
      setStatus("idle");
      navigateTo(DEFAULT_APP_PATH);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
      setStatus("error");
    }
  }

  async function handleRegister(input: { email: string; password: string; inviteCode: string }) {
    void AppShell.preload();
    setStatus("loading");
    setError(null);
    try {
      const registeredUser = await apiClient.register(input);
      setUser(registeredUser);
      setStatus("idle");
      navigateTo(DEFAULT_APP_PATH);
    } catch (registerError) {
      setError(registerError instanceof Error ? registerError.message : "注册失败");
      setStatus("error");
    }
  }

  async function handleLogout() {
    clearMediaCache();
    await apiClient.logout();
    setUser(null);
    navigateTo("/login");
  }

  if (status === "checking" && route.path !== "/login") {
    return <div className="boot-screen">Paintopia</div>;
  }

  if (route.path === "/login") {
    return <LoginPage onLogin={handleLogin} onRegister={handleRegister} status={status === "checking" ? "idle" : status} error={error} />;
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} onRegister={handleRegister} status={status === "checking" ? "idle" : status} error={error} />;
  }

  const activeModule = moduleFromPath(route.path);
  return (
    <Suspense fallback={<div className="boot-screen">Paintopia</div>}>
    <AppShell
      user={user}
      activeModule={activeModule}
      onNavigate={(moduleId) => navigateTo(pathForModule(moduleId))}
      onLogout={handleLogout}
    />
    </Suspense>
  );
}

function useBrowserRoute() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const updatePath = () => setPath(window.location.pathname);
    window.addEventListener("popstate", updatePath);
    window.addEventListener("paintopia:navigate", updatePath);
    return () => {
      window.removeEventListener("popstate", updatePath);
      window.removeEventListener("paintopia:navigate", updatePath);
    };
  }, []);

  return { path };
}

function navigateTo(path: string) {
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
  }
  window.dispatchEvent(new Event("paintopia:navigate"));
}

const modulePaths: Record<ModuleId, string> = {
  create: "/app/create", "prompt-library": "/app/prompt-library", gallery: "/app/gallery", assets: "/app/assets",
  "usage-log": "/app/usage-log", settings: "/app/settings", profile: "/app/settings/profile", config: "/app/config",
  "config-image": "/app/config/image",
  "config-text": "/app/config/text",
  "config-prompt": "/app/config/prompt",
  "config-pricing": "/app/config/pricing",
  "config-gallery": "/app/config/gallery",
  "config-users": "/app/config/users",
  "config-maintenance": "/app/config/maintenance"
};
export function moduleFromPath(path: string): ModuleId {
  return (Object.entries(modulePaths).sort((a,b) => b[1].length-a[1].length).find(([, value]) => path === value || path.startsWith(value + "/"))?.[0] as ModuleId) ?? "create";
}
export function pathForModule(moduleId: ModuleId): string { return modulePaths[moduleId]; }
