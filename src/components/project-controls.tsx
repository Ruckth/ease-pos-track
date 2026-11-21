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
import { pickProject } from "@/lib/projects";

import type { ProjectSummary } from "@/lib/types";

/**
 * The Projects this account can use and the one currently open. The open
 * Project lives in the URL, so a refresh or a shared link keeps it.
 */
export function useCurrentProject(
  token: string,
  requestedKey: string | undefined,
  navigateProject: (key: string, replace: boolean) => void,
) {
  const projects = useProjects(token);
  const current = projects ? pickProject(projects, requestedKey ?? null) : undefined;

  // Replace missing or inaccessible Projects with the Project actually shown.
  useEffect(() => {
    if (current && requestedKey !== current.key) navigateProject(current.key, true);
  }, [current, requestedKey, navigateProject]);

  const select = useCallback((key: string) => {
    if (key !== current?.key) navigateProject(key, false);
  }, [current, navigateProject]);

  return { projects, current, select };
}

const selectClassName = "h-9 min-w-0 max-w-56 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** A plain select of Projects. Hidden behind a label when there is only one. */
export function ProjectSwitcher({
  projects,
  current,
  onSelect,
}: {
  projects: ProjectSummary[];
  current: ProjectSummary;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  if (projects.length === 1) {
    return (
      <span className="inline-flex h-9 min-w-0 max-w-48 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm font-medium" title={current.name}>
        <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{current.name}</span>
      </span>
    );
  }
  return (
    <select
      className={selectClassName}
      aria-label={t("chooseProject")}
      value={current.key}
      onChange={(event) => onSelect(event.target.value)}
    >
      {projects.map((project) => (
        <option key={project._id} value={project.key}>{project.name} ({project.key})</option>
      ))}
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
  token,
  open,
  onOpenChange,
  onCreated,
}: {
  token: string;
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
      const project = await createProject({ token, name, key });
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

function ProjectMembersDialog({
  token,
  project,
  open,
  onOpenChange,
}: {
  token: string;
  project: ProjectSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { members, addMember, removeMember } = useProjectMembers(token, project._id, open);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const member = await addMember({ token, projectId: project._id, email });
      toast.success(t("memberAdded", { email: member.email }));
      setEmail("");
    } catch (error) {
      toast.error(localizeError(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(member: { customerId: Id<"customers">; email: string }) {
    try {
      await removeMember({ token, projectId: project._id, customerId: member.customerId });
      toast.success(t("memberRemoved", { email: member.email }));
    } catch (error) {
      toast.error(localizeError(error, t));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("projectMembersTitle", { name: project.name })}
      description={t("projectMembersDescription")}
    >
      <form className="flex gap-2" onSubmit={(event) => void onAdd(event)}>
        <Input
          type="email"
          placeholder={t("customerEmail")}
          aria-label={t("customerEmail")}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button type="submit" disabled={busy || !email.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          {t("addMember")}
        </Button>
      </form>
      <div className="mt-4">
        {members === undefined ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noMembers")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {members.map((member) => (
              <li key={member.customerId} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate text-sm">{member.email}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("removeMember", { email: member.email })}
                  onClick={() => void onRemove(member)}
                >
                  <Trash2 />
                </Button>
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
  token,
  projects,
  current,
  onSelect,
  onCreate,
}: {
  token: string;
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
          <ProjectMembersDialog token={token} project={current} open={membersOpen} onOpenChange={setMembersOpen} />
        </>
      ) : null}
    </div>
  );
}
