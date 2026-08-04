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
        className="space-y-6"
      >
        <StepperNav className="gap-3">
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
                <StepperTrigger className="flex grow flex-col items-start justify-center gap-2.5">
                  <StepperIndicator className="size-8 border-2 border-background text-sm data-[state=inactive]:border-border data-[state=inactive]:bg-transparent data-[state=inactive]:text-muted-foreground">
                    {stepValue}
                  </StepperIndicator>
                  <div className="flex flex-col items-start gap-1">
                    <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                      {t("stepNumber", { number: stepValue })}
                    </span>
                    <StepperTitle className="text-start text-sm font-semibold group-data-[state=inactive]/step:text-muted-foreground">
                      {t(titleKey)}
                    </StepperTitle>
                    <Badge
                      variant="outline"
                      className={cn(
                        "border",
                        state === "completed" && "border-emerald-200 bg-emerald-50 text-emerald-800",
                        state === "active" && "border-sky-200 bg-sky-50 text-sky-800",
                      )}
                    >
                      {state === "completed" ? t("stepCompleted") : state === "active" ? t("stepActive") : t("stepPending")}
                    </Badge>
                  </div>
                </StepperTrigger>
                {index < CUSTOMER_STEPS.length - 1 ? (
                  <StepperSeparator className="absolute inset-x-0 start-9 top-4 m-0 group-data-[orientation=horizontal]/stepper-nav:w-[calc(100%-2rem)] group-data-[orientation=horizontal]/stepper-nav:flex-none group-data-[state=completed]/step:bg-primary" />
                ) : null}
              </StepperItem>
            );
          })}
        </StepperNav>

        <StepperPanel>
          <StepperContent value={1} className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">{t("stepDetailsHint")}</p>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="customer-ticket-title">{t("topic")}</label>
              <Input
                ref={titleInputRef}
                id="customer-ticket-title"
                value={title}
                maxLength={TITLE_MAX_LENGTH}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="customer-ticket-description">{t("description")}</label>
              <Textarea
                id="customer-ticket-description"
                rows={5}
                maxLength={DESCRIPTION_MAX_LENGTH}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </StepperContent>

          <StepperContent value={2} className="space-y-3">
            <p className="text-sm leading-6 text-muted-foreground">{t("stepMediaHint")}</p>
            <MediaUploadField
              items={items}
              onItemsChange={setItems}
              onPreviewItem={(item) => setSelectedMediaId(item.id)}
              onRequestRemove={requestPendingItemRemoval}
              annotationCounts={annotationCounts}
              disabled={!active || isUploading}
            />
            {items.length > 0 ? (
              <p className="text-sm leading-5 text-muted-foreground">
                {annotations.length > 0 ? t("pinSummary", { count: annotations.length }) : t("pinHint")}
              </p>
            ) : null}
          </StepperContent>

          <StepperContent value={3} className="space-y-3">
            <p className="text-sm leading-6 text-muted-foreground">{t("stepReviewHint")}</p>
            <dl className="divide-y rounded-md border bg-muted/20 text-sm">
              <div className="flex flex-col gap-1 p-3">
                <dt className="font-medium text-muted-foreground">{t("reviewTopic")}</dt>
                <dd className="font-semibold">{title.trim()}</dd>
              </div>
              <div className="flex flex-col gap-1 p-3">
                <dt className="font-medium text-muted-foreground">{t("reviewDescription")}</dt>
                <dd className="whitespace-pre-wrap leading-6">{description.trim() || t("noDescription")}</dd>
              </div>
              <div className="flex flex-wrap items-center gap-3 p-3">
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
              <div className="grid grid-cols-4 gap-2">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedMediaId(item.id)}
                    aria-label={t("openMedia", { name: item.file.name })}
                    className="relative aspect-square overflow-hidden rounded-md border bg-black"
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

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={step === 1 || isUploading}
            onClick={() => setStep((current) => clampStep(current - 1, draft))}
          >
            {t("back")}
          </Button>
          {step === 3 ? (
            <div className="flex gap-2">
              {isUploading ? (
                <Button type="button" variant="outline" onClick={() => abortControllerRef.current?.abort()}>
                  {t("cancelUpload")}
                </Button>
              ) : null}
              <Button type="button" disabled={isUploading} onClick={() => void submit()}>
                {isUploading ? <Loader2 className="animate-spin" /> : <Send />}
                {isUploading ? t("submitting") : t("submitTicket")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              disabled={!isStepComplete(step, draft) || isUploading}
              onClick={() => setStep((current) => clampStep(current + 1, draft))}
            >
              {t("next")}
            </Button>
          )}
        </div>
      </Stepper>

      <Dialog
        open={active && selectedMediaId !== null}
        onOpenChange={(open) => !open && setSelectedMediaId(null)}
        title={items[selectedMediaIndex]?.file.name ?? t("annotateMedia")}
        description={t("annotateDescription")}
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
