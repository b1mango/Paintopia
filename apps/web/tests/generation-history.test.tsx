import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GenerationHistoryPanel } from "../src/features/history/GenerationHistoryPanel";
import { apiClient } from "../src/lib/apiClient";
afterEach(() => vi.restoreAllMocks());
it("submits five filters with ISO times and resets pagination when querying", async () => {
  const fetch = vi.spyOn(apiClient, "listGenerationHistory").mockResolvedValue({ items: [], total: 45, page: 1, pageSize: 20, options:{models:["flare-c"],providers:["Yeelo"]} });
  render(<GenerationHistoryPanel allUsers />);
  await waitFor(() => expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(fetch).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 }, "all"));
  fireEvent.change(screen.getByLabelText("用户"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("模型"), { target: { value: "flare-c" } });
  fireEvent.change(screen.getByLabelText("接口来源"), { target: { value: "Yeelo" } });
  fireEvent.change(screen.getByLabelText("状态"), { target: { value: "failed" } });
  fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-10-01T00:00" } });
  fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-10-09T23:59" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "查询" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "查询" }));
  await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, user: "alice", model: "flare-c", provider: "Yeelo", status: "failed", from: new Date("2026-10-01T00:00").toISOString(), to: new Date("2026-10-09T23:59").toISOString() }), "all"));
});
it("shows only own-record scope and no user filter for ordinary users", async () => {
  vi.spyOn(apiClient, "listGenerationHistory").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  render(<GenerationHistoryPanel />);
  expect(screen.queryByLabelText("用户")).not.toBeInTheDocument();
  expect(screen.getByText(/我的记录.*仅显示本站额度消耗/)).toBeInTheDocument();
  await screen.findByText("没有符合条件的调用记录");
  expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
});
it("rejects an inverted date range without sending a query", async () => {
  const fetch = vi.spyOn(apiClient, "listGenerationHistory").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  render(<GenerationHistoryPanel allUsers />);
  await screen.findByText("没有符合条件的调用记录");
  fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-10-09T00:00" } });
  fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-10-01T00:00" } });
  fireEvent.click(screen.getByRole("button", { name: "查询" }));
  expect(screen.getByRole("alert")).toHaveTextContent("开始时间不能晚于结束时间");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps ordinary-user usage logs scoped to their personal history", async () => {
  const { AppShell } = await import("../src/app/AppShell");
  const personal = vi.spyOn(apiClient, "getGenerationStats").mockResolvedValue({ total: 0, succeeded: 0, failed: 0 } as never);
  const admin = vi.spyOn(apiClient, "getAdminGenerationStats");
  vi.spyOn(apiClient, "listGenerationHistory").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  render(<AppShell user={{ email: "member", role: "user", quota: 10 }} activeModule="usage-log" />);
  const nav = screen.getByRole("navigation", { name: "主导航" });
  expect(screen.getByRole("button", { name: "用户菜单" })).toHaveAttribute("data-active");
  await screen.findByText("没有符合条件的调用记录");
  expect(personal).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("用户")).not.toBeInTheDocument();
  expect(within(nav).queryByRole("button", { name: "配置" })).not.toBeInTheDocument();
  expect(admin).not.toHaveBeenCalled();
  expect(screen.queryByText("用户统计")).not.toBeInTheDocument();
});


it("opens portal details without expanding the table and restores focus on Escape", async () => {
  vi.spyOn(apiClient, "listGenerationHistory").mockResolvedValue({ items: [{
    id: "job-detail", userId: "u1", userEmail: "alice@example.com", providerId: "p1", providerName: "来源 A",
    model: "gpt-image-2.5-flare-c", status: "failed", createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:02Z",
    params: { resolution: "2K", quality: "high", n: 2 }, quotaCost: 0, durationMs: 2000, error: "上游拒绝请求", attempts: []
  }], total: 1, page: 1, pageSize: 20 });
  const { container } = render(<GenerationHistoryPanel allUsers />);
  const trigger = await screen.findByRole("button", { name: "查看调用详情 job-detail" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "调用详情" });
  expect(container.contains(dialog)).toBe(false);
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(within(dialog).getByText("gpt-image-2.5-flare-c")).toBeInTheDocument();
  expect(within(dialog).getByText("上游拒绝请求")).toBeInTheDocument();
  expect(within(dialog).getByText("请求分辨率")).toBeInTheDocument();
  const raw = within(dialog).getByText("原始请求参数与调用尝试").closest("details")!;
  expect(raw).not.toHaveAttribute("open");
  raw.open = true;
  expect(within(dialog).getByText(/"resolution": "2K"/)).toBeInTheDocument();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(within(dialog).getByRole("button", { name: "复制请求参数与调用尝试" }));
  expect(await within(dialog).findByRole("status")).toHaveTextContent("已复制请求参数与调用尝试");
  expect(JSON.parse(writeText.mock.calls[0]![0])).toHaveProperty("attempts");
  writeText.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(within(dialog).getByRole("button", { name: "复制请求参数与调用尝试" }));
  await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("复制失败"));
  const closeIcon = within(dialog).getByRole("button", { name: "关闭调用详情" });
  const closeFooter = within(dialog).getByRole("button", { name: /^关闭$/ });
  expect(closeIcon).toHaveFocus();
  fireEvent.keyDown(closeIcon, { key: "Tab", shiftKey: true });
  expect(closeFooter).toHaveFocus();
  fireEvent.keyDown(closeFooter, { key: "Tab" });
  expect(closeIcon).toHaveFocus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(document.body.style.overflow).not.toBe("hidden");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "关闭调用详情" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("uses filtered server totals and restores defaults after reset",async()=>{
  vi.spyOn(apiClient,"listGenerationHistory").mockImplementation(async q=>({items:[],total:q?.model?2:30,page:1,pageSize:20,options:{models:["flare-c"],providers:["Yeelo"]},summary:{total:q?.model?2:30,succeeded:q?.model?1:20,failed:q?.model?1:10,successRate:q?.model?0.5:2/3,averageDurationMs:1000}}));
  render(<GenerationHistoryPanel allUsers />);
  await screen.findByText("66.7%");
  fireEvent.change(screen.getByLabelText("模型"),{target:{value:"flare-c"}});
  fireEvent.click(screen.getByRole("button",{name:"查询"}));
  expect(await screen.findByText("50.0%")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"重置"}));
  expect(await screen.findByText("66.7%")).toBeInTheDocument();
});
