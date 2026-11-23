import { preparePageAsset } from "@/lib/optimize-image";
import { PAGE_LIMITS, pageContentType } from "../../../shared/ticket-pages";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { localizeError, useI18n } from "@/lib/i18n";
import type { Ticket } from "@/lib/types";
import { Copy, ExternalLink, FileCode2, FolderOpen, Link2Off, Loader2, Upload, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { defaultPageEntry, isHiddenPagePath, isPageHtml, validatePageBundle } from "../../../shared/ticket-pages";
import { publishTicketPage, useTicketPages, type TicketPage } from "./adapters/pages";

type Selection = { files: Array<{ path: string; blob: File }>; entry: string; requestId: string };

function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A folder pick yields `folder/sub/file`; paths stay relative to the chosen folder. */
function selectionFrom(list: FileList, folder: boolean): Selection {
  const files = Array.from(list, blob => ({ blob, path: folder ? blob.webkitRelativePath.split("/").slice(1).join("/") : blob.name }))
    .filter(file => file.path && !isHiddenPagePath(file.path));
  return { files, entry: defaultPageEntry(files.map(file => file.path)) ?? "", requestId: crypto.randomUUID() };
}

/**
 * Hosted pages on one Ticket: publish an HTML file or folder, then open, copy or
 * revoke each link. Anyone with an active link can open the page.
 */
export function TicketPages({ ticket, token }: { ticket: Ticket; token: string }) {
  const { t, formatDate } = useI18n();
  const { pages, target, revoke } = useTicketPages(token, ticket._id);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState<TicketPage | null>(null);
  const entryId = useId();
  const active = ticket.lifecycle === "active";
  const htmlPaths = selection?.files.map(file => file.path).filter(isPageHtml) ?? [];

  function choose(list: FileList | null, folder: boolean) {
    setError("");
    setSelection(list?.length ? selectionFrom(list, folder) : null);
  }

  async function publish() {
    if (!selection || !target) return;
    setError("");
    setPublishing(true);
    try {
      validatePageBundle(selection.entry, selection.files.map(file => ({ path: file.path, size: 0 })));
      const files = [];
      let totalBytes = 0;
      for (const file of selection.files) {
        const blob = await preparePageAsset(file.blob, pageContentType(file.path));
        totalBytes += blob.size;
        if (totalBytes > PAGE_LIMITS.maxTotalBytes) throw new Error("PAGE_TOO_LARGE");
        files.push({ path: file.path, size: blob.size, blob });
      }
      const bundle = validatePageBundle(selection.entry, files);
      // The request id stays with this selection, so a retry never publishes twice.
      const { url } = await publishTicketPage(target.siteUrl, token, {
        ticket: formatTicketNumber(ticket.ticketNumber, ticket.projectKey), requestId: selection.requestId,
        entry: bundle.entry, files: bundle.files,
      });
      setSelection(null);
      toast.success(t("pagePublished"), { action: { label: t("copyLink"), onClick: () => void copy(url) } });
    } catch (failed) {
      setError(localizeError(failed, t));
    } finally {
      setPublishing(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("linkCopied"));
    } catch {
      toast.error(t("linkCopyFailed"));
    }
  }

  async function confirmRevoke(page: TicketPage) {
    try {
      await revoke({ token, pageId: page._id });
      toast.success(t("linkRevoked"));
    } catch (failed) {
      setError(localizeError(failed, t));
    }
  }

  if (!active && !pages?.length) return null;
  return (
    <section aria-labelledby={`${entryId}-title`} className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div>
        <h3 id={`${entryId}-title`} className="text-sm font-semibold">{t("pagesTitle")}</h3>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{t("pagesHint")}</p>
      </div>

      {pages?.length ? (
        <ul className="space-y-2">
          {pages.map(page => (
            <li key={page._id} className="space-y-2 rounded-md border bg-background px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-medium" title={page.entryPath}>{page.entryPath}</p>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t("pageMeta", { count: page.fileCount, size: formatSize(page.totalBytes), date: formatDate(page.publishedAt) })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={page.url} target="_blank" rel="noopener noreferrer" aria-label={t("openPageNamed", { name: page.entryPath })}
                  className={buttonVariants({ variant: "outline", size: "sm" })}>
                  <ExternalLink /> {t("openPage")}
                </a>
                <Button type="button" variant="outline" size="sm" aria-label={t("copyLinkNamed", { name: page.entryPath })} onClick={() => void copy(page.url)}>
                  <Copy /> {t("copyLink")}
                </Button>
                <Button type="button" variant="outline" size="sm" className="text-destructive hover:text-destructive"
                  aria-label={t("revokeLinkNamed", { name: page.entryPath })} onClick={() => setRevoking(page)}>
                  <Link2Off /> {t("revokeLink")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : pages ? <p className="text-sm text-muted-foreground">{t("pagesEmpty")}</p> : null}

      {active ? (
        <div className="space-y-3">
          {selection ? (
            <div className="space-y-3 rounded-md border bg-background p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm">{t("pageSelection", { count: selection.files.length, size: formatSize(selection.files.reduce((sum, file) => sum + file.blob.size, 0)) })}</p>
                <Button type="button" variant="ghost" size="sm" disabled={publishing} aria-label={t("clearPageSelection")} onClick={() => { setSelection(null); setError(""); }}>
                  <X />
                </Button>
              </div>
              {htmlPaths.length > 1 || !selection.entry ? (
                <div className="space-y-1.5">
                  <label htmlFor={entryId} className="text-sm font-medium">{t("pageEntry")}</label>
                  <select id={entryId} value={selection.entry} disabled={publishing}
                    onChange={event => setSelection({ ...selection, entry: event.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <option value="" disabled>{t("pageEntryChoose")}</option>
                    {htmlPaths.map(path => <option key={path} value={path}>{path}</option>)}
                  </select>
                </div>
              ) : selection.entry ? <p className="truncate font-mono text-sm text-muted-foreground">{selection.entry}</p> : null}
              <Button type="button" disabled={publishing || !selection.entry || !target} onClick={() => void publish()}>
                {publishing ? <Loader2 className="animate-spin" /> : <Upload />} {publishing ? t("pagePublishing") : t("publishPage")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <label className={buttonVariants({ variant: "outline", size: "sm" }) + " cursor-pointer"}>
                <FileCode2 /> {t("chooseHtmlFile")}
                <input type="file" accept=".html,.htm,text/html" className="sr-only" aria-label={t("chooseHtmlFile")}
                  onChange={event => { choose(event.target.files, false); event.target.value = ""; }} />
              </label>
              <label className={buttonVariants({ variant: "outline", size: "sm" }) + " cursor-pointer"}>
                <FolderOpen /> {t("choosePageFolder")}
                <input type="file" className="sr-only" aria-label={t("choosePageFolder")} {...{ webkitdirectory: "" }}
                  onChange={event => { choose(event.target.files, true); event.target.value = ""; }} />
              </label>
            </div>
          )}
        </div>
      ) : null}

      {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <AlertDialog
        open={revoking !== null}
        onOpenChange={open => { if (!open) setRevoking(null); }}
        title={t("revokeLink")}
        description={t("revokeLinkConfirm", { name: revoking?.entryPath ?? "" })}
        confirmLabel={t("revokeLink")}
        onConfirm={() => { if (revoking) void confirmRevoke(revoking); }}
      />
    </section>
  );
}
