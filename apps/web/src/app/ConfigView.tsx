import { useEffect, useState } from "react";
import styles from "../features/admin/admin.module.css";
import { AdminLayout } from "../features/admin/AdminLayout";
import { apiClient, type ProviderConfigResponse } from "../lib/apiClient";
import { StatsView } from "./StatsView";
import { GalleryReviewConfig } from "./GalleryReviewConfig";
import { ImageConfig } from "./ImageConfig";
import { TextConfig } from "./TextConfig";
import { PromptConfig } from "./PromptConfig";
import { PricingConfig } from "./PricingConfig";
import { UsersConfig } from "./UsersConfig";
import { MaintenanceView } from "./MaintenanceView";
import { type ConfigSection } from "./appTypes";

type ProviderSection = Exclude<ConfigSection, "stats" | "maintenance">;

export function ConfigView({ section, onSectionChange }: { section: ConfigSection; onSectionChange: (section: ConfigSection) => void }) {
  return (
    <AdminLayout section={section} onSectionChange={onSectionChange}>
      {section === "stats" ? <StatsView isAdmin={true} />
        : section === "maintenance" ? <MaintenanceView />
        : <AdminView section={section} />}
    </AdminLayout>
  );
}

export function AdminView({ section }: { section: ProviderSection }) {
  const [savedProviders, setSavedProviders] = useState<ProviderConfigResponse[] | null>(null);
  const [providerLoadError, setProviderLoadError] = useState("");


  useEffect(() => {
    let cancelled = false;
    apiClient.listProviders()
      .then((items) => {
        if (cancelled) return;
        setSavedProviders(items);
        setProviderLoadError("");
      })
      .catch((error) => {
        if (cancelled) return;
        setSavedProviders([]);
        setProviderLoadError(error instanceof Error ? `加载接口失败：${error.message}` : "加载接口失败");
      });
    return () => {
      cancelled = true;
    };
  }, [section]);

  return (
    <div className={styles.stack}>
      {section === "image" ? <ImageConfig savedProviders={savedProviders} providerLoadError={providerLoadError} /> : null}
      {section === "text" ? <TextConfig savedProviders={savedProviders} providerLoadError={providerLoadError} /> : null}
      {section === "prompt" ? <PromptConfig /> : null}
      {section === "pricing" ? <PricingConfig /> : null}
      {section === "gallery" ? <GalleryReviewConfig /> : null}
      {section === "users" ? <UsersConfig /> : null}
    </div>
  );
}
