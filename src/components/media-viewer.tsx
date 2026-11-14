import { Button } from "@/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Textarea } from "@/components/ui/textarea";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatClock, isVideoMedia, type Annotation, type MediaItem, type AnnotationDraftInput, type AnnotationUpdateInput } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { EmblaCarouselType } from "embla-carousel";
import { Loader2, MapPin, PlayCircle, X } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ImageSlide, VideoSlide } from "./media-slides";

export type MediaViewerHandle = {
  focusAnnotation: (annotation: Annotation) => void;
};

export type DraftTarget = Omit<AnnotationDraftInput, "text">;

export type FocusRequest = { id: string; nonce: number } | null;

export const MediaViewer = forwardRef<
  MediaViewerHandle,
  {
    media: MediaItem[];
    annotations: Annotation[];
    initialIndex?: number;
    disabled?: boolean;
    onCreateAnnotation: (input: AnnotationDraftInput) => Promise<void>;
    onUpdateAnnotation: (input: AnnotationUpdateInput) => Promise<void>;
    onDeleteAnnotation: (annotationId: string) => Promise<void>;
  }
>(function MediaViewer({ media, annotations, initialIndex = 0, disabled = false, onCreateAnnotation, onUpdateAnnotation, onDeleteAnnotation }, ref) {
  const { t } = useI18n();
  const [mainApi, setMainApi] = useState<CarouselApi>();
  const [thumbApi, setThumbApi] = useState<CarouselApi>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [focus, setFocus] = useState<FocusRequest>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const annotateModeRef = useRef(annotateMode);
  const focusNonceRef = useRef(0);
  const focusTimerRef = useRef<number | null>(null);

  annotateModeRef.current = annotateMode;

  const onSelect = useCallback(() => {
    if (!mainApi) return;
    const index = mainApi.selectedScrollSnap();
    setSelectedIndex(index);
    thumbApi?.scrollTo(index);
  }, [mainApi, thumbApi]);

  useEffect(() => {
    if (!mainApi) return;
    onSelect();
    mainApi.on("select", onSelect);
    mainApi.on("reInit", onSelect);
    return () => {
      mainApi.off("select", onSelect);
      mainApi.off("reInit", onSelect);
    };
  }, [mainApi, onSelect]);

  useEffect(() => {
    if (!mainApi || media.length === 0) return;
    const targetIndex = Math.min(Math.max(0, initialIndex), media.length - 1);
    mainApi.scrollTo(targetIndex);
    thumbApi?.scrollTo(targetIndex);
    setSelectedIndex(targetIndex);
  }, [initialIndex, mainApi, media.length, thumbApi]);

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focusAnnotation: (annotation) => {
        mainApi?.scrollTo(annotation.mediaIndex);
        setOpenId(annotation.id);
        focusNonceRef.current += 1;
        setFocus({ id: annotation.id, nonce: focusNonceRef.current });
        if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = window.setTimeout(() => setFocus(null), 3000);
      },
    }),
    [mainApi],
  );

  const watchDrag = useCallback(
    (_api: EmblaCarouselType, event: MouseEvent | TouchEvent) => {
      if (media.length <= 1) return false;
      if (annotateModeRef.current) return false;
      const target = event.target as Element | null;
      if (target?.closest("video")) return false;
      return true;
    },
    [media.length],
  );

  const carouselOpts = useMemo(() => ({ watchDrag }), [watchDrag]);

  function beginDraft(target: DraftTarget) {
    if (disabled) return;
    setOpenId(null);
    setDraft(target);
    setDraftText("");
  }

  function startMoving(annotationId: string) {
    if (disabled) return;
    const annotation = annotations.find((item) => item.id === annotationId);
    if (annotation) mainApi?.scrollTo(annotation.mediaIndex);
    setMovingId(annotationId);
    setAnnotateMode(false);
    setDraft(null);
    setOpenId(null);
    setActionError("");
  }

  async function handleSurfaceClick(target: DraftTarget) {
    if (disabled) return;
    if (!movingId) {
      beginDraft(target);
      return;
    }

    const movingAnnotation = annotations.find((annotation) => annotation.id === movingId);
    if (!movingAnnotation) {
      setMovingId(null);
      setActionError(t("mediaUnavailable"));
      return;
    }
    if (target.mediaIndex !== movingAnnotation.mediaIndex) {
      mainApi?.scrollTo(movingAnnotation.mediaIndex);
      setActionError(t("unableMoveComment"));
      return;
    }

    setActionError("");
    try {
      await onUpdateAnnotation({
        annotationId: movingId,
        x: target.x,
        y: target.y,
        ...(target.time === undefined ? {} : { time: target.time }),
      });
      setMovingId(null);
    } catch (error) {
      setActionError(localizeError(error, t));
    }
  }

  async function saveDraft() {
    if (disabled || !draft || !draftText.trim() || saving) return;
    setSaving(true);
    setActionError("");
    try {
      await onCreateAnnotation({ ...draft, text: draftText.trim() });
      setDraft(null);
      setDraftText("");
      setAnnotateMode(false);
    } catch (error) {
      setActionError(localizeError(error, t));
    } finally {
      setSaving(false);
    }
  }

  if (media.length === 0) {
    return (
      <div className="grid aspect-video place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
        {t("noMedia")}
      </div>
    );
  }

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm leading-5 text-muted-foreground">
          {selectedIndex + 1} / {media.length}
        </p>
        {movingId ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setMovingId(null)}>
            <X />
            {t("cancelMove")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant={annotateMode ? "default" : "outline"}
            onClick={() => {
              setAnnotateMode((mode) => !mode);
              setDraft(null);
              setOpenId(null);
              setActionError("");
            }}
          >
            <MapPin />
            {annotateMode ? t("placePin") : t("addPin")}
          </Button>
        )}
      </div>

      {movingId ? <p className="text-sm text-primary">{t("moveComment")}</p> : null}
      {actionError ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p> : null}

      <Carousel setApi={setMainApi} opts={carouselOpts} className="overflow-hidden rounded-lg border bg-black">
        <CarouselContent className="-ml-0">
          {media.map((item, index) => (
            <CarouselItem key={item.key} className="pl-0">
              {isVideoMedia(item) ? (
                <VideoSlide
                  item={item}
                  index={index}
                  annotations={annotations.filter((a) => a.mediaIndex === index)}
                  annotateMode={!disabled && (annotateMode || Boolean(movingId))}
                  draft={draft?.mediaIndex === index ? draft : null}
                  focus={focus}
                  openId={openId}
                  onOpenChange={setOpenId}
                  onSurfaceClick={handleSurfaceClick}
                  onUpdate={onUpdateAnnotation}
                  onMove={startMoving}
                  onDelete={onDeleteAnnotation}
                />
              ) : (
                <ImageSlide
                  item={item}
                  index={index}
                  annotations={annotations.filter((a) => a.mediaIndex === index)}
                  annotateMode={!disabled && (annotateMode || Boolean(movingId))}
                  draft={draft?.mediaIndex === index ? draft : null}
                  focus={focus}
                  openId={openId}
                  onOpenChange={setOpenId}
                  onSurfaceClick={handleSurfaceClick}
                  onUpdate={onUpdateAnnotation}
                  onMove={startMoving}
                  onDelete={onDeleteAnnotation}
                />
              )}
            </CarouselItem>
          ))}
        </CarouselContent>
        {media.length > 1 ? (
          <>
            <CarouselPrevious className="left-2 border-none bg-black/50 text-white hover:bg-black/70" />
            <CarouselNext className="right-2 border-none bg-black/50 text-white hover:bg-black/70" />
          </>
        ) : null}
      </Carousel>

      {media.length > 1 ? (
        <Carousel setApi={setThumbApi} opts={{ containScroll: "keepSnaps", dragFree: true }}>
          <CarouselContent className="-ml-2">
            {media.map((item, index) => (
              <CarouselItem key={item.key} className="basis-1/5 pl-2 sm:basis-1/6">
                <button
                  type="button"
                  onClick={() => mainApi?.scrollTo(index)}
                  aria-label={t("mediaNumber", { number: index + 1 })}
                  className={cn(
                    "relative block aspect-square w-full overflow-hidden rounded-md border-2 bg-black transition-all",
                    index === selectedIndex
                      ? "border-primary opacity-100"
                      : "border-transparent opacity-50 hover:opacity-80",
                  )}
                >
                  {isVideoMedia(item) ? (
                    <>
                      <video className="h-full w-full object-cover" src={item.url} muted playsInline preload="metadata" />
                      <PlayCircle className="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-white" />
                    </>
                  ) : (
                    <img className="h-full w-full object-cover" src={item.url} alt="" loading="lazy" />
                  )}
                </button>
              </CarouselItem>
            ))}
          </CarouselContent>
        </Carousel>
      ) : null}

      {draft ? (
        <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
          <p className="text-sm font-medium leading-5 text-muted-foreground">
            {t("addPin")} {draft.mediaIndex + 1}
            {draft.time !== undefined ? ` at ${formatClock(draft.time)}` : ""}
          </p>
          <Textarea
            autoFocus
            rows={2}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            placeholder={t("describeIssue")}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t("cancel")}
            </Button>
            <Button type="button" size="sm" disabled={!draftText.trim() || saving} onClick={saveDraft}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {t("savePin")}
            </Button>
          </div>
        </div>
      ) : null}
    </fieldset>
  );
});
