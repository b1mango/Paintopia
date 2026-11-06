import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/app/AppShell";
import { apiClient } from "../src/lib/apiClient";
import { detectPromptAspectRatio, needsAspectHint } from "../src/lib/promptAspect";

describe("detectPromptAspectRatio", () => {
  it.each([
    ["山间晨雾，16:9", "16:9", "16:9"],
    ["海边日落 16：9 电影感", "16:9", "16：9"],
    ["人像，9比16", "9:16", "9比16"],
    ["poster --ar 2:3", "2:3", "2:3"],
    ["宽银幕 2.35:1 构图", "21:9", "2.35:1"],
    ["尺寸 1920x1080", "16:9", "1920x1080"],
    ["1080×1920 的海报", "9:16", "1080×1920"],
    ["做一张手机壁纸", "9:16", "手机壁纸"],
    ["超宽屏城市夜景", "21:9", "超宽屏"],
  ])("reads %s", (prompt, ratio, text) => {
    expect(detectPromptAspectRatio(prompt)).toEqual({ ratio, text });
  });

  it.each([
    "下午 12:30 的咖啡馆",
    "3x3 九宫格表情包",
    "方形的木盒子",
    "比例 5:4 的相框",
    "一只猫",
    "vertical stripes on a shirt",
    "portrait of a cat",
    "landscape painting of mountains",
    "竖起大拇指",
    "横幅标语",
  ])("ignores %s", (prompt) => {
    expect(detectPromptAspectRatio(prompt)).toBeNull();
  });

  it.each([
    ["横版插画，雪山", "16:9", "横版"],
    ["竖构图的人像", "9:16", "竖构图"],
    ["poster, vertical composition", "9:16", "vertical"],
    ["Horizontal format banner", "16:9", "Horizontal"],
    ["portrait orientation, studio light", "9:16", "portrait"],
    ["cinematic widescreen shot", "16:9", "widescreen"],
  ])("reads orientation only from %s", (prompt, ratio, text) => {
    expect(detectPromptAspectRatio(prompt)).toEqual({ ratio, text, loose: true });
  });

  it.each([
    ["Vertical 16:9 composition, fashion photography", "9:16", "16:9", "Vertical"],
    ["竖屏海报，21:9", "9:21", "21:9", "竖屏"],
    ["landscape orientation, 3:4", "4:3", "3:4", "landscape"],
  ])("flags the orientation conflict in %s", (prompt, ratio, text, conflict) => {
    expect(detectPromptAspectRatio(prompt)).toEqual({ ratio, text, conflict });
  });

  it("keeps a ratio that agrees with the orientation word", () => {
    expect(detectPromptAspectRatio("Vertical 3:4 composition, fashion photography")).toEqual({ ratio: "3:4", text: "3:4" });
    expect(detectPromptAspectRatio("横版 16:9")).toEqual({ ratio: "16:9", text: "16:9" });
  });

  it("only asks about an orientation when the canvas points the other way", () => {
    const vertical = { ratio: "9:16", text: "竖屏", loose: true };
    expect(needsAspectHint(vertical, "3:4")).toBe(false);
    expect(needsAspectHint(vertical, "2:3")).toBe(false);
    expect(needsAspectHint(vertical, "16:9")).toBe(true);
    expect(needsAspectHint(vertical, "1:1")).toBe(true);
    expect(needsAspectHint(vertical, "auto")).toBe(true);
    expect(needsAspectHint({ ratio: "3:4", text: "3:4" }, "2:3")).toBe(true);
  });

  it("prefers an explicit ratio over keywords", () => {
    expect(detectPromptAspectRatio("竖屏海报，比例 3:4")?.ratio).toBe("3:4");
  });
});

describe("prompt aspect hint", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).startsWith("/api/assets?scope=mine&")) return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20 }), { status: 200 });
      throw new Error("Unexpected unmocked request: " + String(input));
    });
    vi.spyOn(apiClient, "listImageCapabilities").mockResolvedValue({ models: [{ model: "gpt-image-2", resolutions: ["1K", "2K", "4K"] }] });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const user = { email: "admin@paintopia.local", role: "admin" as const, quota: 100 };

  it("offers to switch to the ratio written in the prompt", async () => {
    render(<AppShell user={user} />);
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "雪山湖泊，16:9" } });

    const hint = await screen.findByRole("group", { name: "识别到画幅比例" });
    expect(hint).toHaveTextContent("识别到比例 16:9，是否切换画幅？");
    fireEvent.click(screen.getByRole("button", { name: "切换画幅为 16:9" }));

    expect(screen.getByRole("button", { name: /^画幅 16:9/ })).toBeInTheDocument();
    const width = Number((screen.getByLabelText("图片宽度") as HTMLInputElement).value);
    const height = Number((screen.getByLabelText("图片高度") as HTMLInputElement).value);
    expect(width / height).toBeCloseTo(16 / 9, 1);
    expect(screen.queryByRole("group", { name: "识别到画幅比例" })).not.toBeInTheDocument();
  });

  it("does not ask again after keeping the current ratio", async () => {
    render(<AppShell user={user} />);
    const prompt = screen.getByLabelText("提示词");
    fireEvent.change(prompt, { target: { value: "竖屏海报" } });
    expect(await screen.findByRole("group", { name: "识别到画幅比例" })).toHaveTextContent("识别到「竖屏」，切换画幅为 9:16？");
    fireEvent.click(await screen.findByRole("button", { name: "保持 1:1" }));

    fireEvent.change(prompt, { target: { value: "竖屏海报，霓虹灯" } });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(screen.queryByRole("group", { name: "识别到画幅比例" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^画幅 1:1/ })).toBeInTheDocument();

    fireEvent.change(prompt, { target: { value: "竖屏海报，2:3" } });
    await waitFor(() => expect(screen.getByRole("group", { name: "识别到画幅比例" })).toHaveTextContent("识别到比例 2:3，是否切换画幅？"));
  });

  it("warns when the prompt's orientation contradicts its own ratio", async () => {
    render(<AppShell user={user} />);
    const prompt = screen.getByLabelText("提示词");
    fireEvent.change(prompt, { target: { value: "Fashion poster. Vertical 16:9 composition." } });
    expect(await screen.findByRole("group", { name: "识别到画幅比例" })).toHaveTextContent("「Vertical」与「16:9」方向相反，画面可能被拉伸变形。切换画幅为 9:16？");
    fireEvent.click(screen.getByRole("button", { name: "切换画幅为 9:16" }));
    expect(screen.getByRole("button", { name: /^画幅 9:16/ })).toBeInTheDocument();
  });

  it("stays quiet when an orientation word already matches the canvas", async () => {
    render(<AppShell user={user} />);
    const prompt = screen.getByLabelText("提示词");
    fireEvent.change(prompt, { target: { value: "竖屏海报，3:4" } });
    fireEvent.click(await screen.findByRole("button", { name: "切换画幅为 3:4" }));
    fireEvent.change(prompt, { target: { value: "竖屏海报" } });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(screen.queryByRole("group", { name: "识别到画幅比例" })).not.toBeInTheDocument();
  });
});
