import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Check, ImagePlus, Loader2, MapPin, Send } from "lucide-react";
import { api } from "@convex/_generated/api";
import {
  Stepper,
  StepperContent,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperPanel,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MediaUploadField, releasePendingMedia, type PendingMedia } from "@/components/media-upload";
import { MediaViewer, type AnnotationDraftInput, type AnnotationUpdateInput } from "@/components/media-viewer";
import { cn } from "@/lib/utils";
import {
  canEnterStep,
  clampStep,
  CUSTOMER_STEPS,
  DESCRIPTION_MAX_LENGTH,
  isStepComplete,
  stepIssues,
  stepState,
  TITLE_MAX_LENGTH,
  type CustomerStep,
  type CustomerTicketDraft,
} from "@/lib/customer-ticket-steps";
import { submitFeedbackDraft } from "@/lib/feedback-submit";
import {
  pendingAnnotationsForViewer,
  pendingMediaForViewer,
  withoutPendingAnnotationsForMedia,
  type PendingAnnotation,
} from "@/lib/pending-annotations";
import { localizeError, useI18n } from "@/lib/i18n";

/**
 * Customer ticket creation as three gated steps: details, media and pins, then
 * review and submit. A step only opens once the earlier steps are complete, and
 * submitting runs the same upload-intent pipeline as the staff composer, so a
 * failure cancels the intent and cleans up uploaded files.
 */
export function CustomerTicketWizard({
  token,
  active,
  onSubmitted,
  onUploadBusyChange,
}: {
  token: string;
  active: boolean;
  onSubmitted: () => void;
  onUploadBusyChange: (isBusy: boolean) => void;
}) {
  const { t } = useI18n();
  const createFeedback = useMutation(api.feedback.createFeedback);
  const createUploadIntent = useMutation(api.uploads.createUploadIntent);
  const abortControllerRef = useRef<AbortController | null>(null);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<CustomerStep>(1);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<PendingMedia[]>([]);
  const [annotations, setAnnotations] = useState<PendingAnnotation[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingMedia | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const isUploading = progress !== null;

  const draft: CustomerTicketDraft = {
    title,
    description,
    mediaCount: items.length,
    annotationCount: annotations.length,
  };
  const issues = stepIssues(step, draft);
  const viewerMedia = useMemo(() => pendingMediaForViewer(items), [items]);
  const viewerAnnotations = useMemo(() => pendingAnnotationsForViewer(items, annotations), [annotations, items]);
  const selectedMediaIndex = Math.max(0, items.findIndex((item) => item.id === selectedMediaId));
  const annotationCounts = useMemo(
    () =>
      annotations.reduce<Record<string, number>>((counts, annotation) => {
        counts[annotation.mediaId] = (counts[annotation.mediaId] ?? 0) + 1;
        return counts;
      }, {}),
    [annotations],
  );

  useEffect(() => {
    onUploadBusyChange(isUploading);
  }, [isUploading, onUploadBusyChange]);

  useEffect(() => {
    if (active && step === 1) titleInputRef.current?.focus();
  }, [active, step]);

  useEffect(() => {
    if (active) return;
    setSelectedMediaId(null);
    setPendingRemoval(null);
  }, [active]);

  // Editing an earlier step back into an invalid state pulls the flow back. Every
  // field the step gates read is a dependency, so the clamp cannot go stale.
  useEffect(() => {
    setStep((current) => clampStep(current, draft));
  }, [title, description, items.length]);

  function resetDraft() {
    releasePendingMedia(items);
    setItems([]);
    setAnnotations([]);
    setSelectedMediaId(null);
    setPendingRemoval(null);
    setTitle("");
    setDescription("");
    setError("");
    setStep(1);
    idempotencyKeyRef.current = crypto.randomUUID();
  }

  function removePendingItem(item: PendingMedia) {
    URL.revokeObjectURL(item.previewUrl);
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    setAnnotations((current) => withoutPendingAnnotationsForMedia(current, item.id));
    setSelectedMediaId((current) => (current === item.id ? null : current));
    setPendingRemoval(null);
  }

  function requestPendingItemRemoval(item: PendingMedia) {
    if ((annotationCounts[item.id] ?? 0) === 0) {
      removePendingItem(item);
      return;
    }
    setPendingRemoval(item);
  }

  async function createPendingAnnotation(input: AnnotationDraftInput) {
    const mediaItem = items[input.mediaIndex];
    if (!mediaItem) throw new Error("MEDIA_UNAVAILABLE");
    setAnnotations((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        mediaId: mediaItem.id,
        kind: input.kind,
        x: input.x,
        y: input.y,
        time: input.time,
        text: input.text.trim(),
        createdAt: Date.now(),
      },
    ]);
    toast.success(t("pinAdded"));
  }

  async function updatePendingAnnotation(input: AnnotationUpdateInput) {
    setAnnotations((current) =>
      current.map((annotation) => {
        if (annotation.id !== input.annotationId) return annotation;
        return {
          ...annotation,
          ...(input.text === undefined ? {} : { text: input.text.trim() }),
          ...(input.x === undefined ? {} : { x: input.x }),
          ...(input.y === undefined ? {} : { y: input.y }),
          ...(input.time === undefined ? {} : { time: input.time }),
        };
      }),
    );
  }

  async function deletePendingAnnotation(annotationId: string) {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
  }

  async function submit() {
    setError("");
    const blocking = [1, 2].flatMap((candidate) => stepIssues(candidate as CustomerStep, draft));
    if (blocking.length > 0) {
      setError(localizeError(new Error(blocking[0]), t));
      return;
    }

    setProgress(0);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    try {
      await submitFeedbackDraft(
        {
          token,
          createUploadIntent,
          createFeedback,
          onProgress: setProgress,
          signal: abortController.signal,
          onCleanupError: (cleanupError) => toast.error(localizeError(cleanupError, t)),
        },
        { title, description, items, annotations, idempotencyKey: idempotencyKeyRef.current },
      );
      resetDraft();
      toast.success(t("feedbackSubmitted"));
      onSubmitted();
    } catch (err) {
      setError(localizeError(err, t));
    } finally {
      abortControllerRef.current = null;
      setProgress(null);
    }
  }

  return (
    <>
      <Stepper
        value={step}
        onValueChange={(next) => setStep(clampStep(next, draft))}
        indicators={{ completed: <Check className="size-3.5" />, loading: <Loader2 className="size-3.5 animate-spin" /> }}
        className="space-y-5 sm:space-y-6"
      >
        <StepperNav className="gap-1 sm:gap-3">
          {CUSTOMER_STEPS.map(({ step: stepValue, titleKey }, index) => {
            const state = stepState(stepValue, step, draft);
            const reachable = canEnterStep(stepValue, draft);
            return (
              <StepperItem
                key={stepValue}
                step={stepValue}
                completed={state === "completed"}
                disabled={!reachable || isUploading}
                className="relative flex-1 items-start"
              >
                <StepperTrigger className="flex grow flex-col items-center justify-center gap-1.5 px-0.5 sm:items-start sm:gap-2.5 sm:px-0">
                  <StepperIndicator className="size-8 border-2 border-background text-sm data-[state=inactive]:border-border data-[state=inactive]:bg-transparent data-[state=inactive]:text-muted-foreground">
                    {stepValue}
                  </StepperIndicator>
                  <div className="flex min-w-0 flex-col items-center gap-1 sm:items-start">
                    <span className="hidden text-[10px] font-semibold uppercase text-muted-foreground sm:block">
                      {t("stepNumber", { number: stepValue })}
                    </span>
                    <StepperTitle className="line-clamp-2 text-center text-xs font-semibold leading-4 group-data-[state=inactive]/step:text-muted-foreground sm:text-start sm:text-sm sm:leading-5">
                      {t(titleKey)}
                    </StepperTitle>
                    <Badge
                      variant="outline"
                      className={cn(
                        "hidden border sm:inline-flex",
                        state === "completed" && "border-emerald-200 bg-emerald-50 text-emerald-800",
                        state === "active" && "border-sky-200 bg-sky-50 text-sky-800",
                      )}
                    >
                      {state === "completed" ? t("stepCompleted") : state === "active" ? t("stepActive") : t("stepPending")}
                    </Badge>
                  </div>
                </StepperTrigger>
                {index < CUSTOMER_STEPS.length - 1 ? (
                  <StepperSeparator className="absolute inset-x-0 start-[calc(50%+1rem)] top-4 m-0 w-[calc(100%-2rem)] group-data-[orientation=horizontal]/stepper-nav:flex-none group-data-[state=completed]/step:bg-primary sm:start-9" />
                ) : null}
              </StepperItem>
            );
          })}
        </StepperNav>

        <StepperPanel>
          <StepperContent value={1} className="space-y-5">
            <div className="rounded-xl bg-secondary/55 px-4 py-3 text-sm leading-6 text-secondary-foreground">
              {t("stepDetailsHint")}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium" htmlFor="customer-ticket-title">
                  {t("topic")} <span className="text-destructive" aria-hidden="true">*</span>
                </label>
                <span className="text-xs tabular-nums text-muted-foreground">{title.length}/{TITLE_MAX_LENGTH}</span>
              </div>
              <Input
                ref={titleInputRef}
                id="customer-ticket-title"
                value={title}
                maxLength={TITLE_MAX_LENGTH}
                placeholder={t("topicPlaceholder")}
                aria-required="true"
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium" htmlFor="customer-ticket-description">{t("description")}</label>
                <span className="text-xs tabular-nums text-muted-foreground">{description.length}/{DESCRIPTION_MAX_LENGTH}</span>
              </div>
              <Textarea
                id="customer-ticket-description"
                rows={5}
                maxLength={DESCRIPTION_MAX_LENGTH}
                value={description}
                placeholder={t("descriptionPlaceholder")}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </StepperContent>

          <StepperContent value={2} className="space-y-4">
            <div className="rounded-xl bg-secondary/55 px-4 py-3 text-sm leading-6 text-secondary-foreground">
              {t("stepMediaHint")}
            </div>
            <MediaUploadField
              items={items}
              onItemsChange={setItems}
              onPreviewItem={(item) => setSelectedMediaId(item.id)}
              onRequestRemove={requestPendingItemRemoval}
              annotationCounts={annotationCounts}
              disabled={!active || isUploading}
            />
            {items.length > 0 ? (
              <p className="rounded-xl border border-sky-100 bg-sky-50 px-3 py-2.5 text-sm leading-5 text-sky-800">
                {annotations.length > 0 ? t("pinSummary", { count: annotations.length }) : t("pinHint")}
              </p>
            ) : null}
          </StepperContent>

          <StepperContent value={3} className="space-y-4">
            <div className="rounded-xl bg-secondary/55 px-4 py-3 text-sm leading-6 text-secondary-foreground">
              {t("stepReviewHint")}
            </div>
            <dl className="divide-y overflow-hidden rounded-xl border bg-card text-sm shadow-sm">
              <div className="flex flex-col gap-1 p-4">
                <dt className="font-medium text-muted-foreground">{t("reviewTopic")}</dt>
                <dd className="font-semibold">{title.trim()}</dd>
              </div>
              <div className="flex flex-col gap-1 p-4">
                <dt className="font-medium text-muted-foreground">{t("reviewDescription")}</dt>
                <dd className="whitespace-pre-wrap leading-6">{description.trim() || t("noDescription")}</dd>
              </div>
              <div className="flex flex-wrap items-center gap-3 p-4">
                <span className="inline-flex items-center gap-1.5 text-sm">
                  <ImagePlus className="size-4 text-muted-foreground" />
                  {t("reviewMedia", { count: items.length })}
                </span>
                <span className="inline-flex items-center gap-1.5 text-sm">
                  <MapPin className="size-4 text-muted-foreground" />
                  {annotations.length > 0 ? t("reviewPins", { count: annotations.length }) : t("reviewNoPins")}
                </span>
              </div>
            </dl>
            {items.length > 0 ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedMediaId(item.id)}
                    aria-label={t("openMedia", { name: item.file.name })}
                    className="relative aspect-square overflow-hidden rounded-xl border bg-black transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {item.isVideo ? (
                      <video className="h-full w-full object-cover opacity-80" src={item.previewUrl} muted playsInline preload="metadata" />
                    ) : (
                      <img className="h-full w-full object-cover" src={item.previewUrl} alt={item.file.name} />
                    )}
                  </button>
                ))}
              </div>
            ) : null}
          </StepperContent>
        </StepperPanel>

        {progress !== null ? (
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        {issues.length > 0 && step !== 1 ? (
          <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            {localizeError(new Error(issues[0]), t)}
          </p>
        ) : null}
        {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

        <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 flex items-center justify-between gap-2 border-t bg-background/95 px-5 py-3 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            disabled={step === 1 || isUploading}
            onClick={() => setStep((current) => clampStep(current - 1, draft))}
          >
            {t("back")}
          </Button>
          {step === 3 ? (
            <div className="ml-auto flex min-w-0 gap-2">
              {isUploading ? (
                <Button type="button" variant="outline" onClick={() => abortControllerRef.current?.abort()}>
                  {t("cancelUpload")}
                </Button>
              ) : null}
              <Button type="button" className="min-w-0 flex-1 sm:flex-none" disabled={isUploading} onClick={() => void submit()}>
                {isUploading ? <Loader2 className="animate-spin" /> : <Send />}
                {isUploading ? t("submitting") : t("submitTicket")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              className="min-w-28"
              disabled={!isStepComplete(step, draft) || isUploading}
              onClick={() => setStep((current) => clampStep(current + 1, draft))}
            >
              {step === 2 && items.length === 0 ? t("skipForNow") : t("next")}
            </Button>
          )}
        </div>
      </Stepper>

      <Dialog
        open={active && selectedMediaId !== null}
        onOpenChange={(open) => !open && setSelectedMediaId(null)}
        title={items[selectedMediaIndex]?.file.name ?? t("annotateMedia")}
        description={t("annotateDescription")}
        mobileFullScreen
      >
        <MediaViewer
          key={selectedMediaId ?? "pending-media"}
          media={viewerMedia}
          annotations={viewerAnnotations}
          initialIndex={selectedMediaIndex}
          onCreateAnnotation={createPendingAnnotation}
          onUpdateAnnotation={updatePendingAnnotation}
          onDeleteAnnotation={deletePendingAnnotation}
        />
      </Dialog>

      <AlertDialog
        open={active && pendingRemoval !== null}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        title={t("removeMediaPins")}
        description={t("removeMediaDescription", {
          name: pendingRemoval?.file.name ?? t("media"),
          count: pendingRemoval ? annotationCounts[pendingRemoval.id] ?? 0 : 0,
        })}
        confirmLabel={t("removeMedia")}
        onConfirm={() => {
          if (pendingRemoval) removePendingItem(pendingRemoval);
        }}
      />
    </>
  );
}
