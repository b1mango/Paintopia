import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import styles from "../features/admin/admin.module.css";
import { AdminState, SectionHeading } from "../features/admin/AdminLayout";
import { ConfirmDialog } from "../features/admin/AdminDialog";
import { apiClient, type AdminInviteCode, type AdminUser } from "../lib/apiClient";
import { StyledSelect } from "../components/StyledSelect";
import { formatDateTime } from "./formatters";

export function UsersConfig() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<AdminInviteCode[]>([]);
  const [inviteQuery, setInviteQuery] = useState("");
  const [inviteStatus, setInviteStatus] = useState("all");
  const [message, setMessage] = useState("");
  const [userError, setUserError] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingInvites, setLoadingInvites] = useState(true);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [destroyTarget, setDestroyTarget] = useState<AdminInviteCode | null>(null);
  const inviteRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    apiClient.listUsers().then(value => { if (!cancelled) setUsers(value); })
      .catch(() => { if (!cancelled) setUserError("用户加载失败，请刷新重试"); })
      .finally(() => { if (!cancelled) setLoadingUsers(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    void filterInvites("", "all");
    return () => { inviteRequest.current += 1; };
  }, []);

  async function save(user: AdminUser, quota: number) {
    setMessage(""); setUserError("");
    try {
      const updated = await apiClient.updateUserQuota(user.id, quota);
      setUsers(value => value.map(item => item.id === user.id ? updated : item));
      setMessage("额度已保存");
    } catch (error) { setUserError(error instanceof Error ? `额度保存失败：${error.message}` : "额度保存失败，请重试"); }
  }
  async function filterInvites(nextQuery: string, nextStatus: string) {
    const version = ++inviteRequest.current;
    setLoadingInvites(true); setInviteError("");
    try {
      const filtered = await apiClient.listInviteCodes({ q: nextQuery, status: nextStatus });
      if (version === inviteRequest.current) setInvites(filtered);
    } catch (error) { if (version === inviteRequest.current) setInviteError(error instanceof Error ? `邀请码加载失败：${error.message}` : "邀请码加载失败，请刷新重试"); }
    finally { if (version === inviteRequest.current) setLoadingInvites(false); }
  }
  async function createInvite() {
    setInviteBusy(true); setInviteError("");
    try {
      const invite = await apiClient.createInviteCode();
      setInvites(value => [...value, invite]);
    } catch (error) { setInviteError(error instanceof Error ? `生成失败：${error.message}` : "邀请码生成失败，请重试"); }
    finally { setInviteBusy(false); }
  }
  async function destroyInvite(inviteId: string) {
    setInviteBusy(true); setInviteError("");
    try {
      const updated = await apiClient.destroyInviteCode(inviteId);
      setInvites(value => value.map(invite => invite.id === inviteId ? updated : invite));
      setDestroyTarget(null);
    } catch (error) { setInviteError(error instanceof Error ? `销毁失败：${error.message}` : "邀请码销毁失败，请重试"); }
    finally { setInviteBusy(false); }
  }
  return <div className={styles.userManagementStack}>
    <SectionHeading title="用户管理" description="查看用户与账户状态，就地调整创作额度；邀请码也在这里发放。" />
    <section className={styles.panel}>
      <header className={styles.sectionHeader}><div><h2>用户与额度</h2><p>改动额度后逐行保存。</p></div></header>
      <div className={styles.userTable} role="table" aria-label="用户额度管理">
        <div className={styles.userTableHead} role="row">{["用户名称", "角色", "状态", "注册日期", "额度", "保存"].map(label => <span role="columnheader" key={label}>{label}</span>)}</div>
        {users.map(user => <UserRow key={user.id} user={user} onSave={save} />)}
      </div>
      {loadingUsers ? <AdminState loading>正在读取用户…</AdminState> : !userError && !users.length ? <AdminState>这里还没有用户。</AdminState> : null}
      {userError ? <AdminState error>{userError}</AdminState> : null}
      {message ? <p className={styles.statusText} role="status">{message}</p> : null}
    </section>
    <section className={styles.panel}>
      <div className={styles.sectionHeader}><div><h2>邀请码管理</h2><p>生成、检索与销毁邀请码。</p></div><button type="button" className={styles.primaryActionButton} disabled={inviteBusy} onClick={() => void createInvite()}><Plus size={14} aria-hidden="true" />生成邀请码</button></div>
      <div className={styles.userToolbar}>
        <label>搜索邀请码<input aria-label="搜索邀请码" value={inviteQuery} onChange={event => { const value = event.target.value; setInviteQuery(value); void filterInvites(value, inviteStatus); }} /></label>
        <label>筛选邀请码<StyledSelect ariaLabel="筛选邀请码状态" value={inviteStatus} onChange={value => { setInviteStatus(value); void filterInvites(inviteQuery, value); }} options={[{ value: "all", label: "全部" }, { value: "active", label: "可用" }, { value: "used", label: "已使用" }, { value: "destroyed", label: "已销毁" }]} /></label>
      </div>
      <div className={styles.inviteTable} role="table" aria-label="邀请码列表" aria-busy={loadingInvites}>
        <div className={styles.inviteTableHead} role="row">{["邀请码", "状态", "创建者", "使用者", "创建时间", "操作"].map(label => <span role="columnheader" key={label}>{label}</span>)}</div>
        {invites.map(invite => <div key={invite.id} className={styles.inviteTableRow} role="row">
          <strong role="cell">{invite.code}</strong><span role="cell">{invite.status === "active" ? "可用" : invite.status === "used" ? "已使用" : "已销毁"}</span><span role="cell">{invite.createdByEmail ?? "--"}</span><span role="cell">{invite.usedByEmail ?? "--"}</span><span role="cell" className={styles.inviteTimeCell}>{formatDateTime(invite.createdAt)}</span>
          <span role="cell" className={styles.inviteActionCell}><button type="button" className={styles.dangerAction} aria-label={"销毁邀请码 " + invite.code} disabled={inviteBusy || invite.status !== "active"} onClick={() => setDestroyTarget(invite)}>销毁</button></span>
        </div>)}
      </div>
      {loadingInvites ? <AdminState loading>正在查找邀请码…</AdminState> : !inviteError && !invites.length ? <AdminState>没有符合条件的邀请码。</AdminState> : null}
      {inviteError ? <AdminState error>{inviteError}</AdminState> : null}
    </section>
    {destroyTarget ? <ConfirmDialog label="销毁邀请码确认" title="销毁这枚邀请码？" confirmLabel="确认销毁" busy={inviteBusy} onCancel={() => setDestroyTarget(null)} onConfirm={() => void destroyInvite(destroyTarget.id)}><p>销毁后将无法使用此邀请码注册：<br />{destroyTarget.code}</p>{inviteError ? <p role="alert">{inviteError}</p> : null}</ConfirmDialog> : null}
  </div>;
}

function UserRow({ user, onSave }: { user: AdminUser; onSave: (user: AdminUser, quota: number) => void | Promise<void> }) {
  const [quota, setQuota] = useState(user.quota);
  const [saving, setSaving] = useState(false);
  return <div className={styles.userTableRow} role="row">
    <strong role="cell">{user.email}</strong><span role="cell">{user.role === "admin" ? "管理员" : "用户"}</span><span role="cell">{user.status === "active" ? "正常" : "已封禁"}</span>
    <span role="cell" className={styles.inviteTimeCell}><time dateTime={user.createdAt} title={formatDateTime(user.createdAt)}>{formatDateTime(user.createdAt).slice(0, 10)}</time></span>
    <label className={styles.quotaEditor} role="cell"><span>{`修改 ${user.email} 额度`}</span><input type="number" min={0} value={quota} disabled={saving} onChange={event => setQuota(Number(event.target.value))} /></label>
    <span role="cell"><button type="button" className={styles.secondaryAction} disabled={saving || !Number.isFinite(quota) || quota < 0} onClick={async () => { setSaving(true); try { await onSave(user, quota); } finally { setSaving(false); } }}>保存</button></span>
  </div>;
}
