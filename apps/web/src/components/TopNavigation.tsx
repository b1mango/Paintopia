import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Github, Landmark, LogOut, Moon, NotebookText, Settings2, Stamp, Sun, User, Users, Wrench } from "lucide-react";
import type { ModuleId } from "../app/appTypes";
import { useResolvedTheme } from "../lib/uiStore";
import type { DailyCheckInControl } from "../features/account/useDailyCheckIn";
import styles from "./TopNavigation.module.css";

interface TopNavigationProps {
  activeModule: ModuleId;
  userEmail: string;
  isAdmin: boolean;
  theme: "light" | "dark" | "system";
  quota?: number;
  checkIn?: DailyCheckInControl;
  onNavigate: (moduleId: ModuleId) => void;
  onToggleTheme: () => void;
  onLogout: () => void;
}

// 管理菜单里单独列出的后台栏目；其余 config-* 归入「管理后台」。
const adminShortcuts: { id: ModuleId; label: string; icon: typeof Users }[] = [
  { id: "config-users", label: "用户管理", icon: Users },
  { id: "config-gallery", label: "画廊审核", icon: Stamp },
  { id: "config-maintenance", label: "维护工具", icon: Wrench }
];

const primaryItems: { id: ModuleId; label: string }[] = [
  { id: "create", label: "创作" },
  { id: "prompt-library", label: "灵感" },
  { id: "gallery", label: "画廊" },
  { id: "assets", label: "我的" }
];

export function TopNavigation({ activeModule, userEmail, isAdmin, theme, quota, checkIn, onNavigate, onToggleTheme, onLogout }: TopNavigationProps) {
  const resolvedTheme = useResolvedTheme(theme);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const userMenuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const initialFocus = useRef(0);
  const sealFocused = useRef(false);
  const checkInPhase = checkIn?.phase;
  const reward = checkIn?.reward ?? 5;
  const canClaim = checkInPhase === "available";
  const userName = userEmail.split("@")[0] || userEmail;
  const inBackstage = activeModule === "config" || activeModule.startsWith("config-") || activeModule === "usage-log" || activeModule === "settings" || activeModule === "profile";

  useEffect(() => { setMenuOpen(false); }, [activeModule, userEmail, isAdmin]);

  // 朱印领取后会消失；若焦点原在朱印上，交还给头像按钮，避免键盘焦点丢失。
  useEffect(() => {
    if (checkInPhase === "claimed" && sealFocused.current) { sealFocused.current = false; triggerRef.current?.focus(); }
  }, [checkInPhase]);

  // 朱砂点：滑到当前栏目下方
  useLayoutEffect(() => {
    const place = () => {
      const dot = dotRef.current;
      const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!dot) return;
      if (!active) { dot.style.opacity = "0"; return; }
      dot.style.opacity = "1";
      dot.style.transform = `translateX(${active.offsetLeft + active.offsetWidth / 2 - 2.5}px)`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [activeModule]);

  useEffect(() => {
    if (!menuOpen) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const index = initialFocus.current < 0 ? (items?.length ?? 1) - 1 : initialFocus.current;
    items?.[index]?.focus();
    const handleOutside = (event: Event) => {
      if (event.target instanceof Node && !userMenuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handleOutside);
    document.addEventListener("focusin", handleOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handleOutside);
      document.removeEventListener("focusin", handleOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuOpen]);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % items.length; break;
      case "ArrowUp": next = (index - 1 + items.length) % items.length; break;
      case "Home": next = 0; break;
      case "End": next = items.length - 1; break;
      case "Tab":
        // Return to the trigger before the browser advances to the next/previous control.
        triggerRef.current?.focus();
        setMenuOpen(false);
        return;
      default: return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  function runMenuAction(action: () => void) {
    setMenuOpen(false);
    triggerRef.current?.focus();
    action();
  }

  function menuItem(label: string, icon: React.ReactNode, action: () => void, current = false) {
    return <button type="button" role="menuitem" tabIndex={-1} className={styles.menuItem} data-current={current || undefined} onClick={() => runMenuAction(action)}>
      {icon}<span>{label}</span>
    </button>;
  }

  return (
    <header className={styles.topNav} data-theme={resolvedTheme}>
      <button type="button" className={styles.brand} onClick={() => onNavigate("create")} aria-label="绘境 · 回到创作">
        <img src={`/media/paintopia-icon-${resolvedTheme === "dark" ? "white" : "black"}-128.png`} width={30} height={30} alt="" />
        <span className={styles.brandText}><span className={styles.brandZh}>绘境</span><span className={styles.brandEn}>PAINTOPIA</span></span>
      </button>
      <nav className={styles.nav} aria-label="主导航" data-theme={resolvedTheme} ref={navRef}>
        {primaryItems.map(({ id, label }) => {
          const active = activeModule === id;
          return <button key={id} type="button" className={styles.navItem} aria-current={active ? "page" : undefined} onClick={() => onNavigate(id)}>{label}</button>;
        })}
        <span className={styles.navDot} ref={dotRef} aria-hidden="true" />
      </nav>
      <div className={styles.right}>
        {typeof quota === "number" ? <span className={styles.quotaGroup}>
          <span className={styles.quota} title="剩余额度">余 <em key={checkIn?.creditedCount ?? 0} data-bump={checkIn?.creditedCount ? true : undefined}>{quota.toLocaleString("zh-CN")}</em></span>
          {checkIn?.creditedCount ? <span key={checkIn.creditedCount} className={styles.quotaGain} aria-hidden="true">+{reward}</span> : null}
          {canClaim || checkInPhase === "claiming" ? <button type="button" className={styles.checkInSeal} aria-label={`每日签到，领取 ${reward} 积分`} title={checkIn?.error || `每日签到 +${reward}`}
            disabled={checkInPhase === "claiming"} aria-busy={checkInPhase === "claiming"} data-error={checkIn?.error ? true : undefined}
            onFocus={() => { sealFocused.current = true; }} onBlur={() => { sealFocused.current = false; }} onClick={() => checkIn?.claim()}>签</button> : null}
        </span> : null}
        <button type="button" className={styles.iconButton} onClick={onToggleTheme}
          aria-label={resolvedTheme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={resolvedTheme === "dark" ? "宣纸" : "夜墨"}>
          {resolvedTheme === "dark" ? <Sun size={17} strokeWidth={1.6} aria-hidden="true" /> : <Moon size={17} strokeWidth={1.6} aria-hidden="true" />}
        </button>
        <div className={styles.userMenu} ref={userMenuRef}>
          <button type="button" ref={triggerRef} className={styles.avatar} data-active={inBackstage || undefined} aria-label="用户菜单" title={userEmail}
            aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined}
            onClick={() => { initialFocus.current = 0; setMenuOpen((open) => !open); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                initialFocus.current = event.key === "ArrowUp" ? -1 : 0;
                setMenuOpen(true);
              }
            }}>
            {Array.from(userName)[0]?.toUpperCase() ?? "墨"}
            {canClaim ? <span className={styles.avatarDot} aria-hidden="true" /> : null}
          </button>
          {menuOpen && <div id={menuId} ref={menuRef} role="menu" aria-label="用户菜单" className={styles.menu} onKeyDown={handleMenuKeyDown}>
            <div className={styles.menuHead} aria-hidden="true">
              <strong>{userName}{isAdmin ? <em className={styles.roleSeal}>管理员</em> : null}</strong>
              <span>{isAdmin ? userEmail : "创作者"}{typeof quota === "number" ? ` · 余 ${quota.toLocaleString("zh-CN")}` : ""}</span>
            </div>
            {menuItem("个人资料", <User size={15} aria-hidden="true" />, () => onNavigate("profile"), activeModule === "profile")}
            {menuItem("使用日志", <NotebookText size={15} aria-hidden="true" />, () => onNavigate("usage-log"), activeModule === "usage-log")}
            {menuItem("界面设置", <Settings2 size={15} aria-hidden="true" />, () => onNavigate("settings"), activeModule === "settings")}
            <a role="menuitem" tabIndex={-1} className={styles.menuItem} href="https://github.com/b1mango/Paintopia" target="_blank" rel="noopener noreferrer" aria-label="Paintopia GitHub 仓库（新窗口打开）" onClick={() => setMenuOpen(false)}>
              <Github size={15} aria-hidden="true" /><span>GitHub</span>
            </a>
            {isAdmin ? <div role="group" aria-labelledby={`${menuId}-admin`} className={styles.menuGroup}>
              <span id={`${menuId}-admin`} className={styles.menuLabel}>管理</span>
              {menuItem("管理后台", <Landmark size={15} aria-hidden="true" />, () => onNavigate("config"),
                (activeModule === "config" || activeModule.startsWith("config-")) && !adminShortcuts.some(item => item.id === activeModule))}
              {adminShortcuts.map(({ id, label, icon: Icon }) => <Fragment key={id}>{menuItem(label, <Icon size={15} aria-hidden="true" />, () => onNavigate(id), activeModule === id)}</Fragment>)}
            </div> : null}
            <span className={styles.menuRule} aria-hidden="true" />
            {menuItem("退出登录", <LogOut size={15} aria-hidden="true" />, onLogout)}
          </div>}
        </div>
      </div>
    </header>
  );
}
