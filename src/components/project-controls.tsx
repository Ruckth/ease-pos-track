import { FormEvent, useCallback, useEffect, useState, type ReactNode } from "react";
import { useProjects, useCreateProject, useProjectMembers } from "@/app/adapter";
import { toast } from "sonner";
import { ChevronDown, FolderKanban, Loader2, Plus, Trash2 } from "lucide-react";
import type { Id } from "../../convex/_generated/dataModel";
import { suggestProjectKey } from "../../shared/ticket-numbers";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger, useMenuAction,
} from "@/components/ui/dropdown-menu";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { localizeError, useI18n } from "@/lib/i18n";
import { pickProject } from "@/lib/projects";
import type { ListView } from "@/app/workspace-search";

import type { ProjectSummary } from "@/lib/types";

/**
 * The Projects this account can use and the one currently open. The open
 * Project lives in the URL, so a refresh or a shared link keeps it.
 */
export function useCurrentProject(
  requestedKey: string | undefined,
  navigateProject: (key: string, replace: boolean, view?: ListView) => void,
) {
  const projects = useProjects();
  const current = projects ? pickProject(projects, requestedKey ?? null) : undefined;
  // An Undo closure belongs to the Project and session that produced it.
  useEffect(() => () => { toast.dismiss(); }, [current?.key]);

  useEffect(() => {
    if (current && requestedKey !== current.key) navigateProject(current.key, true);
  }, [current, requestedKey, navigateProject]);

  const select = useCallback((key: string, view?: ListView) => {
    if (key !== current?.key) navigateProject(key, false, view);
  }, [current, navigateProject]);

  return { projects, current, select };
}

const projectLabel = (project: ProjectSummary) => `${project.name} (${project.key})`;

/**
 * The open Project. With several Projects it is a single-choice menu; with one
 * it is a plain label. Create Project, when offered, is a separate action.
 */
export function ProjectSwitcher({
  projects,
  current,
  onSelect,
  onCreate,
  compact = false,
}: {
  projects: ProjectSummary[];
  current: ProjectSummary;
  onSelect: (key: string) => void;
  onCreate?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const menu = useMenuAction();
  const visibleLabel = compact ? <>
    <span className="truncate min-[480px]:hidden">{current.key}</span>
    <span className="hidden truncate min-[480px]:block">{projectLabel(current)}</span>
  </> : <span className="truncate">{projectLabel(current)}</span>;
  if (projects.length === 1) {
    return (
      <span className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-lg bg-field px-3 text-sm font-medium" title={projectLabel(current)}>
        <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {visibleLabel}
      </span>
    );
  }
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger ref={menu.triggerRef} render={<Button type="button" variant="outline" className="h-auto min-h-11 min-w-0 max-w-full justify-start gap-2 rounded-lg px-3 text-left" />}
        aria-label={`${t("chooseProject")}: ${projectLabel(current)}`} title={projectLabel(current)}>
        <FolderKanban className="text-muted-foreground" aria-hidden="true" />
        {visibleLabel}
        <ChevronDown className="ml-auto text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 min-w-0 max-w-[var(--available-width)]">
        <DropdownMenuRadioGroup value={current.key} onValueChange={value => onSelect(String(value))}>
          {projects.map(project => (
            <DropdownMenuRadioItem key={project._id} value={project.key} closeOnClick className="whitespace-normal break-words">
              {projectLabel(project)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {onCreate ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => menu.run(onCreate)}><Plus aria-hidden="true" />{t("newProject")}…</DropdownMenuItem>
        </> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function NoProjects({ action }: { action?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="aurora-panel grid min-h-72 place-items-center p-8 text-center">
      <div className="max-w-sm">
        <FolderKanban className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-semibold">{t("noProjectsTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{action ? t("noProjectsStaff") : t("noProjectsCustomer")}</p>
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}

export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: string) => void;
}) {
  const { t } = useI18n();
  const createProject = useCreateProject();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) return;
    setName("");
    setKey("");
    setKeyEdited(false);
  }, [open]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const project = await createProject({ name, key });
      toast.success(t("projectCreated", { key: project.key }));
      onCreated(project.key);
      onOpenChange(false);
    } catch (error) {
      toast.error(localizeError(error, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)} title={t("newProject")} description={t("newProjectDescription")}>
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">{t("projectName")}</span>
          <Input
            value={name}
            maxLength={80}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
              if (!keyEdited) setKey(suggestProjectKey(event.target.value));
            }}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">{t("projectKey")}</span>
          <Input
            className="font-mono uppercase"
            value={key}
            maxLength={10}
            onChange={(event) => {
              setKey(event.target.value.toUpperCase());
              setKeyEdited(true);
            }}
          />
          <span className="block text-xs text-muted-foreground">{t("projectKeyHint")}</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="submit" disabled={busy || !name.trim() || !key.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            {busy ? t("creatingProject") : t("createProject")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProjectMembersDialog({
  project,
  owner,
  open,
  onOpenChange,
}: {
  project: ProjectSummary;
  owner: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { members, invitations, createInvitation, revokeInvitation, removeMember, setAccess } = useProjectMembers(project._id, open, owner);
  const [eligible, setEligible] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try { await work(); } catch (error) { toast.error(localizeError(error, t)); } finally { setBusy(false); }
  }
  const onInvite = () => run(async () => {
    if (!eligible) return;
    const created = await createInvitation({ projectId: project._id, eligibilityConfirmed: true });
    setEligible(false);
    setLink(`${window.location.origin}/customer/join#invite=${encodeURIComponent(created.secret)}`);
  });
  const onRemove = (member: { customerId: Id<"customers">; displayName: string }) => run(async () => {
    await removeMember({ projectId: project._id, customerId: member.customerId });
    toast.success(t("memberRemoved", { name: member.displayName }));
  });

  return (
    <Dialog
      open={open}
      onOpenChange={next => { if (!next) { setEligible(false); setLink(""); } onOpenChange(next); }}
      title={t("projectMembersTitle", { name: project.name })}
      description={t("projectMembersDescription")}
    >
      {owner ? <section className="space-y-2" aria-labelledby="customer-invite-heading">
        <p id="customer-invite-heading" className="text-sm text-muted-foreground">{t("customerInviteDescription")}</p>
        <label className="flex min-h-11 items-start gap-2 py-2 text-sm">
          <input type="checkbox" checked={eligible} disabled={busy} onChange={event => setEligible(event.target.checked)} className="mt-1" />
          {t("confirmCustomerEligibility")}
        </label>
        <Button type="button" className="min-h-11" disabled={busy || !eligible} onClick={() => void onInvite()}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}{t("createInviteLink")}
        </Button>
        {link ? <div className="space-y-2 rounded-lg bg-muted/50 p-3" role="status">
          <output className="block break-all rounded bg-muted p-2 font-mono text-xs">{link}</output>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success(t("linkCopied")), () => undefined)}>{t("copyLink")}</Button>
        </div> : null}
        {invitations?.length ? <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t("invitationsPending", { count: String(invitations.length) })}</span>
          {invitations.map(invite => <Button key={invite.invitationId} type="button" size="sm" variant="ghost" className="min-h-11" disabled={busy}
            onClick={() => void run(async () => { await revokeInvitation({ invitationId: invite.invitationId }); })}>
            {t("revoke")}{invite.expired ? ` (${t("expired")})` : ""}
          </Button>)}
        </div> : null}
      </section> : null}
      <div className="mt-4">
        {members === undefined ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noMembers")}</p>
        ) : (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-lg bg-muted/40">
            {members.map((member) => (
              <li key={member.customerId} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-sm">
                  {member.displayName} <span className="text-muted-foreground">{member.username}</span>
                  {member.status === "disabled" ? <span className="ml-2 text-xs">{t("statusDisabled")}</span> : null}
                </span>
                {owner ? <span className="flex shrink-0 gap-1">
                  <Button type="button" variant="ghost" size="sm" className="min-h-11" disabled={busy}
                    onClick={() => void run(async () => {
                      await setAccess({ customerId: member.customerId, status: member.status === "active" ? "disabled" : "active" });
                      toast.success(t("accessUpdated"));
                    })}>
                    {t(member.status === "active" ? "disableAccess" : "enableAccess")}
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11" disabled={busy}
                    aria-label={t("removeMember", { name: member.displayName })}
                    onClick={() => void onRemove(member)}>
                    <Trash2 />
                  </Button>
                </span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
