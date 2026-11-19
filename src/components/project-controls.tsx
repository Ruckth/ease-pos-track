import { FormEvent, useCallback, useEffect, useState, type ReactNode } from "react";
import { useProjects, useCreateProject, useProjectMembers } from "@/app/adapter";
import { toast } from "sonner";
import { FolderKanban, Loader2, Plus, Trash2, Users } from "lucide-react";
import type { Id } from "../../convex/_generated/dataModel";
import { suggestProjectKey } from "../../shared/ticket-numbers";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { localizeError, useI18n } from "@/lib/i18n";
import { pickProject, readProjectParam, withProjectParam } from "@/lib/projects";

import type { ProjectSummary } from "@/lib/types";

/**
 * The Projects this account can use and the one currently open. The open
 * Project lives in the URL, so a refresh or a shared link keeps it.
 */
export function useCurrentProject() {
  const projects = useProjects();
  const [requestedKey, setRequestedKey] = useState(() => readProjectParam(window.location.search));
  const current = projects ? pickProject(projects, requestedKey) : undefined;
  // An Undo closure belongs to the Project and session that produced it.
  useEffect(() => () => { toast.dismiss(); }, [current?.key]);

  useEffect(() => {
    const sync = () => setRequestedKey(readProjectParam(window.location.search));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // Rewrite a missing or unusable key to the Project actually shown.
  useEffect(() => {
    if (current && readProjectParam(window.location.search) !== current.key) {
      const requested = readProjectParam(window.location.search);
      window.history.replaceState(requested ? null : window.history.state, "", withProjectParam(window.location.href, current.key, Boolean(requested)));
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [current]);

  const select = useCallback((key: string, view?: string) => {
    const destination = new URL(withProjectParam(window.location.href, key, true), window.location.origin);
    if (view === "queue") destination.searchParams.delete("view");
    else if (view) destination.searchParams.set("view", view);
    window.history.pushState(null, "", destination);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  return { projects, current, select };
}

const selectClassName = "min-h-11 min-w-0 w-full max-w-56 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** A plain select of Projects. Hidden behind a label when there is only one. */
export function ProjectSwitcher({
  projects,
  current,
  onSelect,
  onCreate,
}: {
  projects: ProjectSummary[];
  current: ProjectSummary;
  onSelect: (key: string) => void;
  onCreate?: () => void;
}) {
  const { t } = useI18n();
  if (projects.length === 1) {
    return (
      <span className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm font-medium" title={current.name}>
        <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{current.name} ({current.key})</span>
      </span>
    );
  }
  return (
    <select
      className={selectClassName}
      aria-label={t("chooseProject")}
      value={current.key}
      onChange={(event) => event.target.value ? onSelect(event.target.value) : onCreate?.()}
    >
      {projects.map((project) => (
        <option key={project._id} value={project.key}>{project.name} ({project.key})</option>
      ))}
      {onCreate && <option value="">{t("newProject")}…</option>}
    </select>
  );
}

export function NoProjects({ action }: { action?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-72 place-items-center rounded-lg border bg-card p-8 text-center">
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
        {link ? <div className="space-y-2 rounded-md border p-3" role="status">
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
          <ul className="divide-y rounded-md border">
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

/** Staff header controls: switch Project, add one, manage its customers. */
export function StaffProjectControls({
  projects,
  current,
  onSelect,
  onCreate,
}: {
  projects: ProjectSummary[];
  current: ProjectSummary | null;
  onSelect: (key: string) => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  const [membersOpen, setMembersOpen] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      {current ? <ProjectSwitcher projects={projects} current={current} onSelect={onSelect} /> : null}
      <Button type="button" variant="outline" size="icon" aria-label={t("newProject")} title={t("newProject")} onClick={onCreate}>
        <Plus />
      </Button>
      {current ? (
        <>
          <Button type="button" variant="outline" size="icon" aria-label={t("projectMembers")} title={t("projectMembers")} onClick={() => setMembersOpen(true)}>
            <Users />
          </Button>
          <ProjectMembersDialog project={current} owner open={membersOpen} onOpenChange={setMembersOpen} />
        </>
      ) : null}
    </div>
  );
}
