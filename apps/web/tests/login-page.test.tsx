import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/pages/LoginPage";

describe("LoginPage", () => {
  it("renders the replica login surface without a screenshot close button", () => {
    render(<LoginPage onLogin={vi.fn()} onRegister={vi.fn()} status="idle" />);

    expect(screen.getByLabelText("用户名")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(screen.getByLabelText("用户名")).toHaveValue("");
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(screen.getByRole("button", { name: "入境" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
  });

  it("switches to the left-panel invite-code registration form from the small text link", () => {
    const onRegister = vi.fn();
    render(<LoginPage onLogin={vi.fn()} onRegister={onRegister} status="idle" />);

    expect(screen.queryByLabelText("邀请码")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "持邀请码注册" }));

    const textboxes = screen.getAllByRole("textbox");
    expect(textboxes[0]).toHaveAccessibleName("用户名");
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(textboxes[1]).toHaveAccessibleName("邀请码");
    expect(screen.getByRole("button", { name: "立契" })).toBeInTheDocument();
  });
});
