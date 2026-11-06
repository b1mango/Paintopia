import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DailyCheckIn } from "../src/features/account/DailyCheckIn";
import { useDailyCheckIn } from "../src/features/account/useDailyCheckIn";
import { AppShell } from "../src/app/AppShell";
import { apiClient } from "../src/lib/apiClient";
import type { DailyCheckInStatus } from "@paintopia/shared";

const initial: DailyCheckInStatus = {day:"2026-11-03",timeZone:"Asia/Shanghai",reward:5,checkedIn:false,nextResetAt:"2099-01-01T16:00:00Z",remainingQuota:66};
beforeEach(()=>vi.spyOn(apiClient,"getDailyCheckIn").mockResolvedValue({...initial,nextResetAt:new Date(Date.now()+60000).toISOString()}));
afterEach(()=>{ vi.restoreAllMocks(); vi.useRealTimers(); });

function Harness({account="alice",onQuotaChange}:{account?:string;onQuotaChange?:(quota:number)=>void}) {
  return <DailyCheckIn checkIn={useDailyCheckIn(account,onQuotaChange)} />;
}

it("waits for saved credit, prevents double clicks and updates the balance",async()=>{
  let resolve!: (value: DailyCheckInStatus & {credited:boolean})=>void;
  const claim = vi.spyOn(apiClient,"claimDailyCheckIn").mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const onQuotaChange=vi.fn();
  render(<Harness onQuotaChange={onQuotaChange} />);
  const button=await screen.findByRole("button",{name:"签到 +5"});
  fireEvent.click(button); fireEvent.click(button);
  expect(claim).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button",{name:"领取中…"})).toBeDisabled();
  expect(onQuotaChange).not.toHaveBeenCalledWith(71);
  await act(async()=>resolve({...initial,checkedIn:true,remainingQuota:71,credited:true}));
  expect(screen.getByRole("button",{name:"今日已签"})).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("已领取 5 积分");
  expect(onQuotaChange).toHaveBeenLastCalledWith(71);
});

it("recovers from a rejected claim without changing the balance and retries safely",async()=>{
  const claim=vi.spyOn(apiClient,"claimDailyCheckIn").mockRejectedValueOnce(new Error("网络中断，请重试")).mockResolvedValueOnce({...initial,checkedIn:true,remainingQuota:71,credited:false});
  const change=vi.fn(); render(<Harness onQuotaChange={change} />);
  fireEvent.click(await screen.findByRole("button",{name:"签到 +5"}));
  expect(await screen.findByRole("alert")).toHaveTextContent("网络中断，请重试");
  expect(change).toHaveBeenLastCalledWith(66);
  fireEvent.click(screen.getByRole("button",{name:"签到 +5"}));
  expect(await screen.findByRole("button",{name:"今日已签"})).toBeDisabled();
  expect(claim).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status")).toHaveTextContent("今日已签到，明天再来");
});

it("reloads failed status and restores a persisted claimed state",async()=>{
  vi.mocked(apiClient.getDailyCheckIn).mockRejectedValueOnce(new Error("状态读取失败")).mockResolvedValueOnce({...initial,checkedIn:true,remainingQuota:71});
  render(<Harness />);
  expect(await screen.findByRole("alert")).toHaveTextContent("状态读取失败");
  fireEvent.click(screen.getByRole("button",{name:"重新加载签到"}));
  expect(await screen.findByRole("button",{name:"今日已签"})).toBeDisabled();
});

it("revalidates at the server reset time and throttles focus refreshes",async()=>{
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-03T15:59:59Z"));
  vi.mocked(apiClient.getDailyCheckIn).mockResolvedValueOnce({...initial,checkedIn:true,nextResetAt:"2026-11-03T16:00:00Z"}).mockResolvedValue({...initial,day:"2026-11-04",nextResetAt:"2026-11-04T16:00:00Z"});
  render(<Harness />);
  await act(async()=>{});
  expect(screen.getByRole("button",{name:"今日已签"})).toBeDisabled();
  await act(async()=>{ await vi.advanceTimersByTimeAsync(2001); });
  expect(screen.getByRole("button",{name:"签到 +5"})).toBeEnabled();
  await act(async()=>{ window.dispatchEvent(new Event("focus")); });
  expect(apiClient.getDailyCheckIn).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date("2026-11-03T16:06:00Z"));
  await act(async()=>{ window.dispatchEvent(new Event("focus")); });
  expect(apiClient.getDailyCheckIn).toHaveBeenCalledTimes(3);
});

it("does not let an older focus response overwrite a successful claim",async()=>{
  let resolve!: (value:DailyCheckInStatus)=>void;
  vi.mocked(apiClient.getDailyCheckIn).mockResolvedValueOnce(initial).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  vi.spyOn(apiClient,"claimDailyCheckIn").mockResolvedValue({...initial,checkedIn:true,remainingQuota:71,credited:true});
  const change=vi.fn(); render(<Harness onQuotaChange={change} />);
  await screen.findByRole("button",{name:"签到 +5"});
  const now=Date.now(); vi.spyOn(Date,"now").mockReturnValue(now+6*60*1000);
  fireEvent(window,new Event("focus"));
  expect(apiClient.getDailyCheckIn).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button",{name:"签到 +5"}));
  await screen.findByRole("button",{name:"今日已签"});
  await act(async()=>resolve(initial));
  expect(screen.getByRole("button",{name:"今日已签"})).toBeDisabled();
  expect(change).toHaveBeenLastCalledWith(71);
});

it("claims from the profile row and updates both balances, then the top seal disappears",async()=>{
  vi.spyOn(apiClient,"listImageCapabilities").mockResolvedValue({models:[]});
  vi.spyOn(apiClient,"listQuotaPricing").mockResolvedValue([]);
  vi.spyOn(apiClient,"claimDailyCheckIn").mockResolvedValue({...initial,checkedIn:true,remainingQuota:71,credited:true});
  render(<AppShell user={{email:"alice",role:"user",quota:66}} activeModule="profile" />);
  expect(await screen.findByRole("button",{name:"每日签到，领取 5 积分"})).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button",{name:"签到 +5"}));
  await waitFor(()=>expect(screen.getByTitle("剩余额度")).toHaveTextContent("71"));
  expect(screen.getByText("剩余额度").parentElement).toHaveTextContent("71");
  expect(screen.queryByRole("button",{name:"每日签到，领取 5 积分"})).not.toBeInTheDocument();
  expect(apiClient.claimDailyCheckIn).toHaveBeenCalledTimes(1);
});
