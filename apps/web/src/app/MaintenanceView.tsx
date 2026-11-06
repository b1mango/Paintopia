import styles from "../features/admin/admin.module.css";
import { SectionHeading } from "../features/admin/AdminLayout";
import { AdminImport } from "./AdminImport";
import { ThumbnailMaintenance } from "./ThumbnailMaintenance";

export function MaintenanceView() {
  return <div className={styles.stack}>
    <SectionHeading title="维护工具" description="一次性的数据迁移与修复。日常创作无需操作，不会触发生图或扣费。" />
    <div className={styles.toolGrid}>
      <AdminImport />
      <ThumbnailMaintenance />
    </div>
  </div>;
}
