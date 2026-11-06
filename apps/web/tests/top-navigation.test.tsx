import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DailyCheckInControl } from "../src/features/account/useDailyCheckIn";

let TopNavigation: typeof import("../src/components/TopNavigation").TopNavigation;
let useUiStore: typeof import("../src/lib/uiStore").useUiStore;
let useResolvedTheme: typeof import("../src/lib/uiStore").useResolvedTheme;
let dark = false;
const listeners = new Set<() => void>();
const media = {
  get matches() { return dark; },
  media: "(prefers-color-scheme: dark)",
  addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
  removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
};

beforeAll(async () => {
  window.matchMedia = vi.fn(() => media as unknown as MediaQueryList);
  vi.resetModules();
  ({ useUiStore, useResolvedTheme } = await import("../src/lib/uiStore"));
  ({ TopNavigation } = await import("../src/components/TopNavigation"));
});
beforeEach(() => {
  dark = false;
  localStorage.clear();
  act(() => useUiStore.setState({ theme: "system", language: "zh", reduceMotion: false }));
});
afterEach(() => vi.restoreAllMocks());

function changeSystemTheme(value: boolean) {
  act(() => { dark = value; listeners.forEach((listener) => listener()); });
}
function control(overrides: Partial<DailyCheckInControl> = {}): DailyCheckInControl {
  return { phase: "available", reward: 5, notice: "", error: "", creditedCount: 0, claim: vi.fn(), reload: vi.fn(), ...overrides };
}
function setup(overrides: Partial<React.ComponentProps<typeof TopNavigation>> = {}) {
  const props: React.ComponentProps<typeof TopNavigation> = {
    activeModule: "create", userEmail: "artist@example.com", isAdmin: false, theme: "system",
    onNavigate: vi.fn(), onToggleTheme: vi.fn(), onLogout: vi.fn(), ...overrides
  };
  return { ...render(<TopNavigation {...props} />), props };
}

describe("TopNavigation", () => {
  it("keeps four primary destinations and moves secondary pages into the user menu", () => {
    const checkIn = control();
    const { props } = setup({ quota: 1280, checkIn });
    for (const [label, id] of [["创作", "create"], ["灵感", "prompt-library"], ["画廊", "gallery"], ["我的", "assets"]]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(props.onNavigate).toHaveBeenLastCalledWith(id);
    }
    expect(screen.getByRole("button", { name: "创作" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByTitle("剩余额度")).toHaveTextContent("余 1,280");
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["个人资料", "使用日志", "界面设置", "GitHub", "退出登录"]);
    expect(screen.queryByRole("group", { name: "管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /每日签到/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "使用日志" }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("usage-log");
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "界面设置" }));
    expect(props.onNavigate).toHaveBeenLastCalledWith("settings");
  });
  it("adds a separate management group to the admin menu", () => {
    const { props } = setup({ isAdmin: true, activeModule: "config" });
    for (const label of ["创作", "灵感", "画廊", "我的"]) expect(screen.getByRole("button", { name: label })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "用户菜单" })).toHaveAttribute("data-active");
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    const management = screen.getByRole("group", { name: "管理" });
    expect(within(management).getAllByRole("menuitem").map(item => item.textContent)).toEqual(["管理后台", "用户管理", "画廊审核", "维护工具"]);
    expect(screen.getByRole("menuitem", { name: "管理后台" })).toHaveAttribute("data-current");
    fireEvent.click(screen.getByRole("menuitem", { name: "管理后台" }));
    expect(props.onNavigate).toHaveBeenCalledWith("config");
    for (const [label, id] of [["用户管理", "config-users"], ["画廊审核", "config-gallery"], ["维护工具", "config-maintenance"], ["界面设置", "settings"], ["个人资料", "profile"]]) {
      fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      expect(props.onNavigate).toHaveBeenLastCalledWith(id);
    }
  });
  it("offers in-place check-in from the quota seal and the avatar dot until claimed", () => {
    const checkIn = control();
    const { rerender, props, container } = setup({ quota: 66, checkIn });
    const seal = screen.getByRole("button", { name: "每日签到，领取 5 积分" });
    expect(container.querySelector("[class*=avatarDot]")).not.toBeNull();
    seal.focus();
    fireEvent.click(seal);
    expect(checkIn.claim).toHaveBeenCalledOnce();
    rerender(<TopNavigation {...props} quota={66} checkIn={control({ phase: "claiming" })} />);
    expect(screen.getByRole("button", { name: "每日签到，领取 5 积分" })).toBeDisabled();
    rerender(<TopNavigation {...props} quota={71} checkIn={control({ phase: "claimed", notice: "已领取 5 积分", creditedCount: 1 })} />);
    expect(screen.queryByRole("button", { name: "每日签到，领取 5 积分" })).not.toBeInTheDocument();
    expect(container.querySelector("[class*=avatarDot]")).toBeNull();
    expect(screen.getByTitle("剩余额度")).toHaveTextContent("余 71");
    expect(screen.getByRole("button", { name: "用户菜单" })).toHaveFocus();
  });
  it("hides the quota seal when the check-in status failed to load", () => {
    setup({ quota: 66, checkIn: control({ phase: "error", error: "签到状态加载失败" }) });
    expect(screen.queryByRole("button", { name: /每日签到/ })).not.toBeInTheDocument();
  });
  it("marks the user menu for profile and navigates through it", () => {
    const { props } = setup({ activeModule: "profile" });
    const trigger = screen.getByRole("button", { name: "用户菜单" });
    expect(trigger).toHaveAttribute("data-active");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "个人资料" })).toHaveAttribute("data-current");
    fireEvent.click(screen.getByRole("menuitem", { name: "个人资料" }));
    expect(props.onNavigate).toHaveBeenCalledWith("profile");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(props.onLogout).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });
  it.each(["config-image", "config-text", "config-prompt", "config-pricing"] as const)("highlights the admin backend for %s", (activeModule) => {
    setup({ isAdmin: true, activeModule });
    expect(screen.getByRole("button", { name: "创作" })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    expect(screen.getByRole("menuitem", { name: "管理后台" })).toHaveAttribute("data-current");
  });
  it.each([["config-users", "用户管理"], ["config-gallery", "画廊审核"], ["config-maintenance", "维护工具"]] as const)("highlights the %s shortcut instead of the backend", (activeModule, label) => {
    setup({ isAdmin: true, activeModule });
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute("data-current");
    expect(screen.getByRole("menuitem", { name: "管理后台" })).not.toHaveAttribute("data-current");
  });
  it("routes the admin profile to the shared profile page", () => {
    const { props } = setup({ isAdmin: true, activeModule: "profile" });
    const trigger = screen.getByRole("button", { name: "用户菜单" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "个人资料" })).toHaveAttribute("data-current");
    fireEvent.click(screen.getByRole("menuitem", { name: "个人资料" }));
    expect(props.onNavigate).toHaveBeenCalledWith("profile");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("uses the existing transparent brand asset for the resolved theme and exposes the repository link", () => {
    const { container } = setup();
    const logo = container.querySelector("img")!;
    expect(logo).toHaveAttribute("src", "/media/paintopia-icon-black-128.png");
    expect(logo).toHaveAttribute("alt", "");
    changeSystemTheme(true);
    expect(logo).toHaveAttribute("src", "/media/paintopia-icon-white-128.png");
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    const repository = screen.getByRole("menuitem", { name: "Paintopia GitHub 仓库（新窗口打开）" });
    expect(repository).toHaveAttribute("href", "https://github.com/b1mango/Paintopia");
    expect(repository).toHaveAttribute("target", "_blank");
    expect(repository).toHaveAttribute("rel", "noopener noreferrer");
  });
  it("toggles on click and closes on Escape, outside pointer or outside focus", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "用户菜单" });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    act(() => screen.getByRole("button", { name: "创作" }).focus());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("supports arrows, Home/End, Tab dismissal and restores trigger focus", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "用户菜单" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const profile = screen.getByRole("menuitem", { name: "个人资料" });
    const logout = screen.getByRole("menuitem", { name: "退出登录" });
    expect(logout).toHaveFocus();
    fireEvent.keyDown(logout, { key: "ArrowDown" });
    expect(profile).toHaveFocus();
    fireEvent.keyDown(profile, { key: "ArrowUp" });
    expect(logout).toHaveFocus();
    fireEvent.keyDown(logout, { key: "Home" });
    expect(profile).toHaveFocus();
    fireEvent.keyDown(profile, { key: "End" });
    expect(logout).toHaveFocus();
    fireEvent.keyDown(logout, { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("closes on external navigation and resolves the system theme label", () => {
    const { rerender, props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    rerender(<TopNavigation {...props} activeModule="assets" />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation")).toHaveAttribute("data-theme", "light");
    changeSystemTheme(true);
    expect(screen.getByRole("navigation")).toHaveAttribute("data-theme", "dark");
    fireEvent.click(screen.getByRole("button", { name: "切换到浅色主题" }));
    expect(props.onToggleTheme).toHaveBeenCalledOnce();
  });
});

describe("navigation theme preferences", () => {
  it("syncs root attributes without a mounted component and follows system changes", () => {
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    changeSystemTheme(true);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    act(() => useUiStore.getState().setReduceMotion(true));
    expect(document.documentElement).toHaveAttribute("data-reduce-motion", "true");
    act(() => useUiStore.getState().setTheme("light"));
    changeSystemTheme(false);
    changeSystemTheme(true);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    act(() => useUiStore.getState().setReduceMotion(false));
    expect(document.documentElement).toHaveAttribute("data-reduce-motion", "false");
  });
  it("exports a reactive resolved hook without replacing the stored system preference", () => {
    const { result, unmount } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("light");
    changeSystemTheme(true);
    expect(result.current).toBe("dark");
    expect(useUiStore.getState().theme).toBe("system");
    act(() => useUiStore.getState().setTheme("light"));
    expect(result.current).toBe("light");
    const before = listeners.size;
    unmount();
    expect(listeners.size).toBe(before - 1);
  });
  it("persists and rehydrates valid preferences and syncs the document", async () => {
    act(() => {
      useUiStore.getState().setTheme("dark");
      useUiStore.getState().setLanguage("en");
      useUiStore.getState().setReduceMotion(true);
    });
    const saved = localStorage.getItem("paintopia-ui")!;
    expect(JSON.parse(saved).state).toEqual({ theme: "dark", language: "en", reduceMotion: true });
    act(() => useUiStore.setState({ theme: "light", language: "zh", reduceMotion: false }));
    localStorage.setItem("paintopia-ui", saved);
    await act(async () => { await useUiStore.persist.rehydrate(); });
    expect(useUiStore.getState()).toMatchObject({ theme: "dark", language: "en", reduceMotion: true });
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-reduce-motion", "true");
  });
  it("ignores invalid persisted preference values and keeps setters intact", async () => {
    localStorage.setItem("paintopia-ui", JSON.stringify({ state: { theme: "invalid", language: null, reduceMotion: "false", setTheme: "bad" }, version: 0 }));
    await act(async () => { await useUiStore.persist.rehydrate(); });
    expect(useUiStore.getState()).toMatchObject({ theme: "system", language: "zh", reduceMotion: false });
    expect(typeof useUiStore.getState().setTheme).toBe("function");
  });
  it("keeps preferences working when storage writes are denied", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("denied"); });
    expect(() => useUiStore.getState().setTheme("dark")).not.toThrow();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});
