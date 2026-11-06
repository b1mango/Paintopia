import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChangePassword } from "../src/features/account/ChangePassword";
import { ProfileView } from "../src/app/AccountViews";
import { apiClient } from "../src/lib/apiClient";

afterEach(() => vi.restoreAllMocks());

function fill(current = "current-password", next = "next-password", confirmation = next) {
  fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("新密码", { exact: true }), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: confirmation } });
}

it("validates required, short, repeated and mismatched passwords before sending", () => {
  const change = vi.spyOn(apiClient, "changePassword");
  render(<ChangePassword />);
  fireEvent.submit(screen.getByRole("form", { name: "修改密码" }));
  expect(screen.getByRole("alert")).toHaveTextContent("请输入当前密码");
  fill("current-password", "short");
  fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
  expect(screen.getByRole("alert")).toHaveTextContent("6–128 位");
  fill("current-password", "current-password");
  fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
  expect(screen.getByRole("alert")).toHaveTextContent("不能与当前密码相同");
  fill("current-password", "next-password", "does-not-match");
  fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
  expect(screen.getByRole("alert")).toHaveTextContent("两次输入的新密码不一致");
  expect(screen.getByLabelText("确认新密码")).toHaveFocus();
  expect(change).not.toHaveBeenCalled();
});

it("waits for success, prevents duplicate submission and clears password fields", async () => {
  let resolve!: (result: { ok: true }) => void;
  const change = vi.spyOn(apiClient, "changePassword").mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<ChangePassword />);
  fill();
  const form = screen.getByRole("form", { name: "修改密码" });
  fireEvent.submit(form); fireEvent.submit(form);
  expect(change).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenCalledWith({ currentPassword: "current-password", newPassword: "next-password" });
  expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
  expect(screen.getByLabelText("当前密码")).toBeDisabled();
  expect(screen.queryByRole("link", { name: "使用新密码登录" })).not.toBeInTheDocument();
  await act(async () => resolve({ ok: true }));
  expect(screen.getByRole("status")).toHaveTextContent("密码已修改，所有设备均已退出登录");
  expect(screen.getByRole("link", { name: "使用新密码登录" })).toHaveAttribute("href", "/login");
  expect(screen.queryByRole("form", { name: "修改密码" })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue("next-password")).not.toBeInTheDocument();
});

it("shows server errors and preserves inputs for a corrected retry", async () => {
  const change = vi.spyOn(apiClient, "changePassword").mockRejectedValueOnce(new Error("当前密码不正确，请重新输入")).mockResolvedValueOnce({ ok: true });
  render(<ChangePassword />);
  fill("wrong-password");
  fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("当前密码不正确，请重新输入");
  expect(screen.getByRole("button", { name: "保存新密码" })).toBeEnabled();
  expect(screen.getByLabelText("新密码", { exact: true })).toHaveValue("next-password");
  fill();
  fireEvent.click(screen.getByRole("button", { name: "保存新密码" }));
  await screen.findByRole("link", { name: "使用新密码登录" });
  expect(change).toHaveBeenCalledTimes(2);
});

it("keeps the password form collapsed until requested and restores focus on cancel", async () => {
  const change = vi.spyOn(apiClient, "changePassword");
  render(<ProfileView user={{ id: "artist", email: "artist", quota: 66, role: "user" }} />);
  expect(screen.queryByRole("form", { name: "修改密码" })).not.toBeInTheDocument();
  expect(screen.getByText("登录密码")).toBeInTheDocument();
  const edit = screen.getByRole("button", { name: "修改" });
  fireEvent.click(edit);
  expect(screen.getByRole("form", { name: "修改密码" })).toBeInTheDocument();
  expect(screen.getByLabelText("当前密码")).toHaveFocus();
  expect(screen.getByLabelText("当前密码")).toHaveAttribute("autocomplete", "current-password");
  for (const label of ["新密码", "确认新密码"]) {
    expect(screen.getByLabelText(label, { exact: true })).toHaveAttribute("type", "password");
    expect(screen.getByLabelText(label, { exact: true })).toHaveAttribute("autocomplete", "new-password");
  }
  fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "typed" } });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("form", { name: "修改密码" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "修改" })).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: "修改" }));
  expect(screen.getByLabelText("当前密码")).toHaveValue("");
  expect(change).not.toHaveBeenCalled();
  expect(screen.queryByText("积分可直接用于创作")).not.toBeInTheDocument();
  expect(screen.queryByText("北京时间每天 0 点更新")).not.toBeInTheDocument();
});
