import type { ReactNode } from "react";
import type { ConfigSection } from "../../app/appTypes";
import styles from "./admin.module.css";

const sections: { id: ConfigSection; label: string }[] = [
  { id: "stats", label: "统计" }, { id: "image", label: "生图配置" },
  { id: "text", label: "优化配置" }, { id: "prompt", label: "提示词配置" },
  { id: "pricing", label: "定价额度" }, { id: "gallery", label: "画廊审核" },
  { id: "users", label: "用户管理" }, { id: "maintenance", label: "维护工具" }
];

export function AdminLayout({ section, onSectionChange, children }: {
  section: ConfigSection; onSectionChange: (section: ConfigSection) => void; children: ReactNode;
}) {
  return <div className={styles.configLayout}>
    <aside className={styles.directory}>
      <header className={styles.directoryTitle}><span aria-hidden="true">管</span><div><h1>管理后台</h1><p>理事有序，落笔从容。</p></div></header>
      <nav className={styles.configTabs} aria-label="配置导航">
        {sections.map(item => <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined} onClick={() => onSectionChange(item.id)}>{item.label}</button>)}
      </nav>
      <p className={styles.directoryFoot}>绘境 · 案后</p>
    </aside>
    <div className={styles.sectionContent}>{children}</div>
  </div>;
}

export function SectionHeading({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <header className={styles.pageHeading}><div><h2>{title}</h2><p>{description}</p></div>{actions}</header>;
}

export function AdminState({ children, error = false, loading = false, action, testId }: {
  children: ReactNode; error?: boolean; loading?: boolean; action?: ReactNode; testId?: string;
}) {
  return <div className={styles.emptyState} role={error ? "alert" : loading ? "status" : undefined} data-error={error || undefined} aria-busy={loading || undefined} data-testid={testId}>
    <span className={styles.enso} aria-hidden="true" /><p>{children}</p>{action}
  </div>;
}
