import { useState } from "react";
import { Eye, EyeOff, Moon, Sun } from "lucide-react";
import { useResolvedTheme, useUiStore } from "../lib/uiStore";
import styles from "./LoginPage.module.css";

type LoginPageProps = {
  onLogin: (credentials: { email: string; password: string }) => Promise<void> | void;
  onRegister: (input: { email: string; password: string; inviteCode: string }) => Promise<void> | void;
  status: "idle" | "loading" | "error";
  error?: string | null;
};

/** 入境：左为一幅墨，右为一纸契。 */
export function LoginPage({ onLogin, onRegister, status, error }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [showPassword, setShowPassword] = useState(false);
  const theme = useResolvedTheme();
  const setTheme = useUiStore((state) => state.setTheme);
  const register = mode === "register";
  const loading = status === "loading";

  return (
    <main className={styles.page}>
      <div className={styles.art} aria-hidden="true">
        <img src="/media/ink-pavilion.webp" alt="" width={1200} height={1200} decoding="async" fetchPriority="high" />
      </div>

      <section className={styles.side} aria-label="绘境 登录">
        <header className={styles.brand}>
          <h1>绘境</h1>
          <p>以言入画</p>
          <span className={styles.seal} aria-hidden="true"><i>绘</i><i>境</i></span>
        </header>

        <form
          className={styles.form}
          data-mode={mode}
          onSubmit={(event) => {
            event.preventDefault();
            if (register) void onRegister({ email, password, inviteCode });
            else void onLogin({ email, password });
          }}
        >
          <p className={styles.lead}>{register ? "持邀请码，立契入境" : "执笔，入境"}</p>

          <label className={styles.field}>
            <input aria-label="用户名" type="text" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" placeholder=" " required />
            <span aria-hidden="true">用户名</span>
          </label>

          <label className={styles.field}>
            <input aria-label="密码" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)}
              autoComplete={register ? "new-password" : "current-password"} placeholder=" " required />
            <span aria-hidden="true">密码</span>
            <button type="button" className={styles.reveal} onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>
              {showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            </button>
          </label>

          {register ? (
            <label className={`${styles.field} ${styles.enter}`}>
              <input aria-label="邀请码" type="text" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} autoComplete="off" placeholder=" " required />
              <span aria-hidden="true">邀请码</span>
            </label>
          ) : null}

          {error ? <p className={styles.error} role="alert">{error}</p> : null}

          <button className={styles.submit} type="submit" disabled={loading} aria-busy={loading}>
            {loading ? (register ? "立契中…" : "入境中…") : register ? "立契" : "入境"}
          </button>

          <button type="button" className={styles.switch} onClick={() => setMode(register ? "login" : "register")}>
            {register ? "已有账号，返回入境" : "持邀请码注册"}
          </button>
        </form>
      </section>

      <button type="button" className={styles.theme} aria-label={theme === "dark" ? "切换为浅色" : "切换为深色"}
        title={theme === "dark" ? "昼" : "夜"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <Sun size={16} strokeWidth={1.5} aria-hidden="true" /> : <Moon size={16} strokeWidth={1.5} aria-hidden="true" />}
      </button>
    </main>
  );
}
