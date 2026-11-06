import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "../src/app/AppShell";
import { apiClient, type ProviderConfigResponse } from "../src/lib/apiClient";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network blocked in provider tests"));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.open = false; } });
  vi.spyOn(apiClient, "listProviderQuotas").mockResolvedValue([]);
  vi.spyOn(apiClient, "listImageCapabilities").mockResolvedValue({ models: [] });
});
afterEach(() => vi.restoreAllMocks());

for (const kind of ["image", "text"] as const) {
  async function setup() {
    const providers: ProviderConfigResponse[] = ["A", "B", "C"].map(name => ({ id: `${kind}-${name}`, kind, name, model: "original-model", baseUrl: "https://example.invalid", apiKey: "********", mode: kind === "image" ? "generations" : "chat_completions", enabled: true, maxConcurrency: 2, ...(kind === "image" ? { imageCapabilities: { sizeField: "image_size" as const, resolutionField: null, qualities: ["custom"], supportsStreaming: false } } : {}) }));
    vi.spyOn(apiClient, "listProviders").mockResolvedValue(providers);
    render(<AppShell user={{ email: "admin@test.invalid", role: "admin", quota: 100 }} activeModule={kind === "image" ? "config-image" : "config-text"} />);
    await screen.findByRole("button", { name: "编辑接口 A" });
    return providers;
  }
  it(`${kind}: moves down/up and rolls back failed ordering`, async () => {
    await setup();
    const reorder = vi.spyOn(apiClient, "reorderProviders").mockResolvedValue([]);
    const transfer = { setData: vi.fn(), getData: () => `${kind}-B`, effectAllowed: "move", dropEffect: "move" };
    fireEvent.dragStart(screen.getByRole("button", { name: "拖动排序 B" }), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("button", { name: "A" }), { dataTransfer: transfer });
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(kind, [`${kind}-B`, `${kind}-A`, `${kind}-C`]));
    reorder.mockRejectedValueOnce(new Error("offline"));
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动排序 A" }), { key: "ArrowUp" });
    await screen.findByText("优先级同步失败：offline");
  });
  it(`${kind}: drops a row after the lower half of its neighbor`, async () => {
    await setup();
    const reorder = vi.spyOn(apiClient, "reorderProviders").mockResolvedValue([]);
    const target = screen.getByRole("button", {name:"B"});
    vi.spyOn(target.parentElement!, "getBoundingClientRect").mockReturnValue({top:100,height:80} as DOMRect);
    const transfer = {getData: () => `${kind}-A`,setData:vi.fn(),dropEffect:"move"};
    const drop = new Event("drop", {bubbles:true});
    Object.defineProperties(drop, {clientY:{value:170},dataTransfer:{value:transfer}});
    fireEvent(target, drop);
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(kind,[`${kind}-B`,`${kind}-A`,`${kind}-C`]));
  });
  it(`${kind}: lifts the card, moves neighbors, and persists pointer order`, async () => {
    await setup();
    const reorder = vi.spyOn(apiClient, "reorderProviders").mockResolvedValue([]);
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-provider-id]"));
    rows.forEach((row, i) => vi.spyOn(row, "getBoundingClientRect").mockReturnValue({top:i*90,bottom:i*90+80,height:80} as DOMRect));
    const pointer = (type: string, y: number, target: Element | Window) => {
      const event = new Event(type, {bubbles:true});
      Object.defineProperties(event, {button:{value:0},pointerId:{value:1},clientY:{value:y}});
      fireEvent(target, event);
    };
    pointer("pointerdown",40,screen.getByRole("button",{name:"拖动排序 A"}));
    pointer("pointermove",140,window);
    expect(rows[0].dataset.lifted).toBe("true");
    expect(rows[1].style.transform).toBe("translateY(-90px)");
    pointer("pointerup",140,window);
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(kind,[`${kind}-B`,`${kind}-A`,`${kind}-C`]));
    expect(rows[0].style.transform).toBe("");
  });
  it(`${kind}: saves existing configuration without replacing its stored key`, async () => {
    const providers = await setup();
    const update = vi.spyOn(apiClient, "updateProvider").mockResolvedValue(providers[0]);
    fireEvent.click(screen.getByRole("button", { name: "编辑接口 A" }));
    const form = screen.getByTestId(`${kind}-provider-form`);
    const fields = Array.from(form.querySelectorAll("input[name], select[name]")).map(node => node.getAttribute("name"));
    expect(fields.indexOf("baseUrl")).toBeLessThan(fields.indexOf("apiKey"));
    expect(fields.indexOf("apiKey")).toBeLessThan(fields.indexOf("model"));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(`${kind}-A`, expect.objectContaining({ apiKey: "", model: "original-model", maxConcurrency: 2, enabled: true, ...(kind === "image" ? { imageCapabilities: providers[0].imageCapabilities } : {}) })));
  });
  it(`${kind}: closes on Escape and returns focus to the editor or delete trigger`, async () => {
    await setup();
    const edit = screen.getByRole("button", { name: "编辑接口 A" });
    edit.focus();
    fireEvent.click(edit);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(edit).toHaveFocus();
    const remove = screen.getByRole("button", { name: "删除接口 A" });
    remove.focus();
    fireEvent.click(remove);
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(remove).toHaveFocus();
  });
  it(`${kind}: ignores model responses after closing and reopening the editor`, async () => {
    await setup();
    let finish!: (value: { models: string[] }) => void;
    vi.spyOn(apiClient, "listProviderModels").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "编辑接口 A" }));
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑接口 B" }));
    await act(async () => finish({ models: ["stale-model"] }));
    expect(screen.queryByText(/已获取/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("B");
  });
  it(`${kind}: handles deletion failures and an empty list, then creates a fresh channel`, async () => {
    const providers = await setup();
    const remove = vi.spyOn(apiClient, "deleteProvider").mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "删除接口 A" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await screen.findByText("删除失败：offline");
    expect(screen.getByRole("button", { name: "编辑接口 A" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog",{name:"删除接口确认"})).getByRole("button",{name:"取消"}));
    remove.mockResolvedValue(undefined);
    for (const name of ["A", "B", "C"]) {
      fireEvent.click(screen.getByRole("button", { name: `删除接口 ${name}` }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: `编辑接口 ${name}` })).not.toBeInTheDocument());
    }
    expect(screen.getByText("暂无已保存渠道，请点击上方新增。")).toBeInTheDocument();
    const addName = kind === "image" ? "新增生图接口" : "新增优化接口";
    fireEvent.click(screen.getByRole("button", { name: addName }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "discard" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭编辑窗口" }));
    fireEvent.click(screen.getByRole("button", { name: addName }));
    expect(screen.getByLabelText("名称")).toHaveValue("");
    const create = vi.spyOn(apiClient, "createProvider").mockResolvedValue({ ...providers[0], id: "created", name: "Fresh" });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByRole("button", { name: "编辑接口 Fresh" });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it(`${kind}: cancels drafts, preserves key and capabilities, deletes selected row`, async () => {
    const providers = await setup();
    const create = vi.spyOn(apiClient, "createProvider");
    fireEvent.click(screen.getByRole("button", { name: kind === "image" ? "新增生图接口" : "新增优化接口" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "discard me" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(create).not.toHaveBeenCalled();
    expect(within(screen.getByTestId(`${kind}-provider-rail`)).getAllByRole("button", { name: /^编辑接口/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "编辑接口 B" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const update = vi.spyOn(apiClient, "updateProvider").mockResolvedValue({ ...providers[1], enabled: false });
    fireEvent.click(screen.getByRole("button", { name: "禁用接口 B" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(`${kind}-B`, expect.objectContaining({ name: "B", apiKey: "", enabled: false, ...(kind === "image" ? { imageCapabilities: providers[1].imageCapabilities } : {}) })));
    await screen.findByRole("button", { name: "启用接口 B" });
    const remove = vi.spyOn(apiClient, "deleteProvider").mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "删除接口 C" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(`${kind}-C`));
    await waitFor(() => expect(screen.queryByRole("button", { name: "编辑接口 C" })).not.toBeInTheDocument());
  });
}
