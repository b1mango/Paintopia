import { useId, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import styles from "../features/admin/admin.module.css";
import { StyledSelect } from "../components/StyledSelect";
import { type PaintopiaUser } from "./appTypes";
import { DailyCheckIn } from "../features/account/DailyCheckIn";
import { ChangePassword } from "../features/account/ChangePassword";
import type { DailyCheckInControl } from "../features/account/useDailyCheckIn";

export function ProfileView({ user, checkIn, onLogout }: { user: PaintopiaUser; checkIn?: DailyCheckInControl; onLogout?: () => void }) {
  const [editingPassword, setEditingPassword] = useState(false);
  const passwordRegion = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const closePassword = () => { setEditingPassword(false); requestAnimationFrame(() => editButton.current?.focus()); };
  return (
    <section className={styles.panel}>
      <header className={styles.accountHeader}><span className={styles.accountMonogram} aria-hidden="true">{Array.from(user.email)[0]?.toUpperCase() ?? "墨"}</span><div><h2>个人资料</h2></div></header>
      <div className={styles.accountInfoGrid}>
        <div><span>邮箱</span><strong>{user.email}</strong></div>
        <div><span>角色</span><strong>{user.role === "admin" ? "管理员" : "普通用户"}</strong></div>
        <div className={styles.accountQuotaRow}><span>剩余额度</span><span className={styles.accountRowValue}>{checkIn ? <DailyCheckIn checkIn={checkIn} /> : null}<strong>{user.quota}</strong></span></div>
        <div><span>登录密码</span><span className={styles.accountRowValue}>
          <strong aria-label="已设置" className={styles.accountMask}>••••••</strong>
          {editingPassword ? null : <button ref={editButton} type="button" className={styles.accountRowAction} aria-expanded={false} aria-controls={passwordRegion} onClick={() => setEditingPassword(true)}>修改</button>}
        </span></div>
      </div>
      {editingPassword ? <ChangePassword key={`password:${user.id ?? user.email}`} id={passwordRegion} onCancel={closePassword} /> : null}
      <button type="button" className={styles.dangerAction} onClick={() => onLogout?.()}>
        <LogOut size={16} />
        退出登录
      </button>
    </section>
  );
}

export function SettingsView({ theme, reduceMotion, setTheme, setReduceMotion }: { theme: string; language?: string; reduceMotion: boolean; setTheme: (value: "dark" | "light" | "system") => void; setLanguage?: (value: "zh" | "en") => void; setReduceMotion: (value: boolean) => void }) {
  return (
    <section className={styles.panel}>
      <h2>界面设置</h2>
      <p className={styles.panelDescription}>更改自动保存在当前浏览器</p>
      <div className={styles.settingsList}>
        <label className={styles.settingRow}><span className={styles.settingCopy}>主题<small>夜墨、宣纸或跟随系统外观</small></span><StyledSelect ariaLabel="主题" value={theme} onChange={(value) => setTheme(value as "dark" | "light" | "system")} options={[{ value: "dark", label: "深色" }, { value: "light", label: "浅色" }, { value: "system", label: "跟随系统" }]} /></label>
        <label className={styles.inlineSetting}><span className={styles.settingCopy}>减少动态效果<small>关闭页面过渡与入场动画，仅保留生成进度反馈</small></span><input type="checkbox" aria-label="减少动态效果" checked={reduceMotion} onChange={(event) => setReduceMotion(event.target.checked)} /></label>
      </div>
    </section>
  );
}
