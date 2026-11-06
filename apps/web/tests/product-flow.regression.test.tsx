import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, type ModuleId, type PaintopiaUser } from "../src/app/AppShell";
import { apiClient } from "../src/lib/apiClient";
import { PromptConfig } from "../src/app/PromptConfig";

const admin = { email: "admin@example.test", role: "admin" as const, quota: 100 };
const member = { email: "member@example.test", role: "user" as const, quota: 25 };
const savedProvider = {
  id: "saved-image", kind: "image" as const, name: "已有渠道",
  baseUrl: "https://provider.example.test", apiKey: "********",
  model: "image-model", mode: "generations", enabled: true, maxConcurrency: 1
};

function NavigableShell({ user, initial = "settings", onLogout }: { user: PaintopiaUser; initial?: ModuleId; onLogout?: () => void }) {
  const [activeModule, setActiveModule] = useState<ModuleId>(initial);
  return <AppShell user={user} activeModule={activeModule} onNavigate={setActiveModule} onLogout={onLogout} />;
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).startsWith("/api/assets?scope=mine&")) return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20 }), { status: 200 });
    throw new Error("Unexpected unmocked request: " + String(input));
  });
  // jsdom does not implement the native dialog top layer. Keep open/closed
  // semantics while exercising the real drawer and its handlers.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  vi.spyOn(apiClient, "listQuotaPricing").mockResolvedValue([]);
  vi.spyOn(apiClient, "listImageCapabilities").mockResolvedValue({ models: [] });
  vi.spyOn(apiClient, "listProviders").mockResolvedValue([savedProvider]);
  vi.spyOn(apiClient, "listProviderQuotas").mockResolvedValue([]);
  vi.spyOn(apiClient, "getAdminGenerationStats").mockResolvedValue({ total: 0, completed: 0, succeeded: 0, failed: 0, running: 0, queued: 0, successRate: 0, averageDurationMs: 0 });
  vi.spyOn(apiClient, "listGenerationHistory").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
});
afterEach(() => vi.restoreAllMocks());

describe("product navigation regressions", () => {
  it("navigates a member through settings, personal profile and usage logs", async () => {
    const onLogout = vi.fn();
    render(<NavigableShell user={member} onLogout={onLogout} />);
    const nav = screen.getByRole("navigation");
    expect(within(nav).queryByRole("button", { name: "配置" })).not.toBeInTheDocument();
    for (const retired of ["管理员", "统计", "账户", "提示词处理"]) {
      expect(within(nav).queryByRole("button", { name: retired })).not.toBeInTheDocument();
    }
    // 界面设置与个人资料各自独立成页，不再有切换滑块。
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "界面设置" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "个人资料" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "个人资料" }));
    expect(screen.queryByRole("heading", { name: "界面设置" })).not.toBeInTheDocument();
    const profile = screen.getByRole("heading", { name: "个人资料" }).closest("section")!;
    expect(within(profile).getByText(member.email)).toBeInTheDocument();
    expect(within(profile).getByText("剩余额度").parentElement).toHaveTextContent("25");
    fireEvent.click(within(profile).getByRole("button", { name: "退出登录" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "使用日志" }));
    await screen.findByText("没有符合条件的调用记录");
    expect(screen.queryByLabelText("用户")).not.toBeInTheDocument();
    expect(apiClient.getAdminGenerationStats).not.toHaveBeenCalled();
    expect(apiClient.listGenerationHistory).toHaveBeenLastCalledWith(expect.anything(), "mine");
  });

  it("keeps an administrator's usage log personal while config stats list every user", async () => {
    render(<NavigableShell user={admin} initial="usage-log" />);
    await screen.findByText("没有符合条件的调用记录");
    expect(screen.getByText(/我的记录/)).toBeInTheDocument();
    expect(screen.queryByLabelText("用户")).not.toBeInTheDocument();
    expect(apiClient.listGenerationHistory).toHaveBeenLastCalledWith(expect.anything(), "mine");
    expect(apiClient.listGenerationHistory).not.toHaveBeenCalledWith(expect.anything(), "all");
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "管理后台" }));
    await screen.findByText(/全部用户/);
    expect(screen.getByLabelText("用户")).toBeInTheDocument();
    expect(apiClient.listGenerationHistory).toHaveBeenLastCalledWith(expect.anything(), "all");
  });

  it("opens administrator sections only through config and fetches stats once", async () => {
    render(<NavigableShell user={admin} />);
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "管理后台" }));
    await screen.findByText("没有符合条件的调用记录");
    expect(apiClient.getAdminGenerationStats).toHaveBeenCalledTimes(1);
    const configNav = screen.getByRole("navigation", { name: "配置导航" });
    expect(within(configNav).getAllByRole("button").map(button => button.textContent)).toEqual([
      "统计", "生图配置", "优化配置", "提示词配置", "定价额度", "画廊审核", "用户管理", "维护工具"
    ]);
    expect(screen.queryByRole("button", { name: "管理员" })).not.toBeInTheDocument();
    fireEvent.click(within(configNav).getByRole("button", { name: "维护工具" }));
    expect(within(configNav).getByRole("button", { name: "维护工具" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("region", { name: "导入本地创作" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "图片缩略图维护" })).toBeInTheDocument();
    expect(screen.getByLabelText("导入文件")).toHaveAttribute("type", "file");
    fireEvent.click(screen.getByRole("button", { name: "生图配置" }));
    await screen.findByRole("button", { name: savedProvider.name });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([admin, member])("opens the correct personal account from the user menu: $role", async (user) => {
    const logout = vi.fn();
    render(<NavigableShell user={user} initial="create" onLogout={logout} />);
    fireEvent.click(screen.getByRole("button", { name: "用户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "个人资料" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const account = screen.getByRole("heading", { name: "个人资料" }).closest("section")!;
    expect(within(account).getByText(user.email)).toBeInTheDocument();
    expect(within(account).getByText("剩余额度").parentElement).toHaveTextContent(String(user.quota));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "界面设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "配置导航" })).not.toBeInTheDocument();
    fireEvent.click(within(account).getByRole("button", { name: "退出登录" }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it.each<ModuleId>(["config", "config-image", "config-text", "config-prompt", "config-pricing", "config-gallery", "config-users", "config-maintenance"])("does not render administrative module %s for a member", (module) => {
    render(<AppShell user={member} activeModule={module} />);
    expect(screen.queryByRole("navigation", { name: "配置导航" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("image-provider-rail")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理员" })).not.toBeInTheDocument();
    expect(apiClient.listProviders).not.toHaveBeenCalled();
    expect(apiClient.getAdminGenerationStats).not.toHaveBeenCalled();
  });
});

describe("provider editor regressions", () => {
  it.each([
    { label: "undefined defaults to resolution", field: undefined, selected: "resolution", submitted: "resolution" },
    { label: "explicit null remains disabled", field: null, selected: "none", submitted: null },
    { label: "explicit image_size remains unchanged", field: "image_size" as const, selected: "image_size", submitted: "image_size" }
  ])("preserves the resolution field when only renaming a channel: $label", async ({ field, selected, submitted }) => {
    const provider = { ...savedProvider, imageCapabilities: { resolutionField: field } };
    vi.mocked(apiClient.listProviders).mockResolvedValue([provider]);
    const update = vi.spyOn(apiClient, "updateProvider").mockImplementation(async (id, input) => ({ ...input, id }));
    render(<AppShell user={admin} activeModule="config-image" />);
    fireEvent.click(await screen.findByRole("button", { name: provider.name }));
    const drawer = screen.getByRole("dialog", { name: "编辑生图渠道" });
    expect(within(drawer).getByLabelText("档位字段")).toHaveValue(selected);
    fireEvent.change(within(drawer).getByLabelText("名称"), { target: { value: "仅改名称" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(provider.id, expect.objectContaining({
      name: "仅改名称", model: provider.model, imageCapabilities: expect.objectContaining({ resolutionField: submitted })
    })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "仅改名称" }));
    expect(within(screen.getByRole("dialog")).getByLabelText("档位字段")).toHaveValue(selected);
  });

  it("restores the last saved text model and fields when discarding later edits", async () => {
    const provider = { ...savedProvider, id: "saved-text", kind: "text" as const, name: "文本渠道", model: "text-original", mode: "chat_completions" };
    vi.mocked(apiClient.listProviders).mockResolvedValue([provider]);
    const update = vi.spyOn(apiClient, "updateProvider").mockImplementation(async (id, input) => ({ ...input, id }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AppShell user={admin} activeModule="config-text" />);
    fireEvent.click(await screen.findByRole("button", { name: provider.name }));
    let drawer = screen.getByRole("dialog", { name: "编辑文本渠道" });
    fireEvent.change(within(drawer).getByLabelText("手动添加文本模型"), { target: { value: "text-saved" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "使用模型" }));
    fireEvent.change(within(drawer).getByLabelText("名称"), { target: { value: "已保存文本渠道" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledWith(provider.id, expect.objectContaining({ name: "已保存文本渠道", model: "text-saved" }));
    fireEvent.click(screen.getByRole("button", { name: "已保存文本渠道" }));
    drawer = screen.getByRole("dialog", { name: "编辑文本渠道" });
    fireEvent.change(within(drawer).getByLabelText("手动添加文本模型"), { target: { value: "text-unsaved" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "使用模型" }));
    fireEvent.change(within(drawer).getByLabelText("名称"), { target: { value: "未保存文本渠道" } });
    fireEvent.change(within(drawer).getByLabelText("Base URL"), { target: { value: "https://unsaved.example.test" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "关闭编辑窗口" }));
    expect(window.confirm).toHaveBeenCalledWith("有未保存的修改，确认关闭并放弃这些修改？");
    fireEvent.click(screen.getByRole("button", { name: "已保存文本渠道" }));
    drawer = screen.getByRole("dialog", { name: "编辑文本渠道" });
    expect(within(drawer).getByLabelText("名称")).toHaveValue("已保存文本渠道");
    expect(within(drawer).getByLabelText("模型")).toHaveValue("text-saved");
    expect(within(drawer).getByLabelText("Base URL")).toHaveValue(provider.baseUrl);
    expect(within(drawer).getByLabelText("手动添加文本模型")).toHaveValue("");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("opens an existing channel, saves edits and closes the drawer", async () => {
    const update = vi.spyOn(apiClient, "updateProvider").mockImplementation(async (id, input) => ({ ...input, id }));
    render(<AppShell user={admin} activeModule="config-image" />);
    const channel = await screen.findByRole("button", { name: savedProvider.name });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(channel);
    const drawer = screen.getByRole("dialog", { name: "编辑生图渠道" });
    expect(drawer).toHaveAttribute("open");
    fireEvent.change(within(drawer).getByLabelText("名称"), { target: { value: "更新渠道" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(savedProvider.id, expect.objectContaining({ name: "更新渠道", apiKey: "", model: "image-model" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "更新渠道" }));
    expect(within(screen.getByRole("dialog")).getByLabelText("名称")).toHaveValue("更新渠道");
  });

  it("keeps candidate model discovery unsaved and prompts before discarding edits", async () => {
    const update = vi.spyOn(apiClient, "updateProvider");
    vi.spyOn(apiClient, "listProviderModels").mockResolvedValue({ models: ["image-model", "candidate-model"] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<AppShell user={admin} activeModule="config-image" />);
    fireEvent.click(await screen.findByRole("button", { name: savedProvider.name }));
    const drawer = screen.getByRole("dialog", { name: "编辑生图渠道" });
    fireEvent.click(within(drawer).getByRole("button", { name: "获取模型" }));
    await within(drawer).findByText(/已获取 2 个候选模型/);
    expect(within(drawer).getByLabelText("模型名称")).toHaveValue(["image-model"]);
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(within(drawer).getByLabelText("名称"), { target: { value: "未保存名称" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "关闭编辑窗口" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(drawer).toHaveAttribute("open");
    confirm.mockReturnValue(true);
    fireEvent.click(within(drawer).getByRole("button", { name: "关闭编辑窗口" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: savedProvider.name }));
    expect(within(screen.getByRole("dialog")).getByLabelText("名称")).toHaveValue(savedProvider.name);
  });
});

describe("admin template deletion", () => {
  it("confirms deletion, retains a failed template, and retries the same saved item", async () => {
    vi.spyOn(apiClient, "listTemplates").mockResolvedValue([
      { id: "custom-translation", name: "自定义翻译", type: "optimize", targetModel: "general", content: "saved instruction", isDefault: false },
      { id: "optimize", name: "优化规则", type: "optimize", targetModel: "image-model", content: "optimizer", isDefault: true }
    ]);
    const remove = vi.spyOn(apiClient, "deleteTemplate").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    render(<PromptConfig />);
    const translation = screen.getByRole("region", { name: /优化模板/ });
    fireEvent.click(await within(translation).findByRole("button", { name: "自定义翻译" }));
    await within(translation).findByDisplayValue("自定义翻译");
    const trigger = within(translation).getByRole("button", { name: "删除模板" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(remove).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "删除模板确认" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await within(dialog).findByText("删除失败：offline");
    expect(within(translation).getByLabelText("模板名称")).toHaveValue("自定义翻译");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove).toHaveBeenNthCalledWith(1, "custom-translation");
    expect(remove).toHaveBeenNthCalledWith(2, "custom-translation");
    expect(within(translation).getByLabelText("模板名称")).toHaveValue("优化规则");
  });
});
