import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, ImagePlus, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  cameraErrorKey,
  requestEnvironmentCamera,
  stopCameraStream,
  type CameraErrorKey,
} from "@/lib/camera";
import { useI18n } from "@/lib/i18n";
import { mediaUxCopy } from "@/lib/media-ux-copy";

type CameraCaptureDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCapture: (file: File) => void;
  onUseFilePicker: () => void;
  validateCapture?: (file: File) => string | null;
};

type CapturedPhoto = {
  file: File;
  previewUrl: string;
};

export function CameraCaptureDialog({
  open,
  onOpenChange,
  onCapture,
  onUseFilePicker,
  validateCapture,
}: CameraCaptureDialogProps) {
  const { t, language } = useI18n();
  const copy = mediaUxCopy(language);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturingRef = useRef(false);
  const previewUrlRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [errorKey, setErrorKey] = useState<CameraErrorKey | null>(null);
  const [captured, setCaptured] = useState<CapturedPhoto | null>(null);

  const releasePreviewUrl = useCallback(() => {
    const current = previewUrlRef.current;
    if (!current) return;
    previewUrlRef.current = null;
    URL.revokeObjectURL(current);
  }, []);

  useEffect(() => {
    if (!open) {
      capturingRef.current = false;
      setCapturing(false);
      releasePreviewUrl();
      setCaptured(null);
      return;
    }

    let cancelled = false;
    let preview: HTMLVideoElement | null = null;
    capturingRef.current = false;
    setCapturing(false);
    releasePreviewUrl();
    setCaptured(null);
    setReady(false);
    setErrorKey(null);

    async function startCamera() {
      try {
        const stream = await requestEnvironmentCamera(window.navigator.mediaDevices);
        if (cancelled) {
          stopCameraStream(stream);
          return;
        }
        streamRef.current = stream;
        preview = videoRef.current;
        if (preview) {
          preview.srcObject = stream;
          await preview.play();
        }
      } catch (error) {
        if (!cancelled) {
          stopCameraStream(streamRef.current);
          streamRef.current = null;
          if (preview) preview.srcObject = null;
          setErrorKey(cameraErrorKey(error));
        }
      }
    }

    void startCamera();
    return () => {
      cancelled = true;
      capturingRef.current = false;
      setCapturing(false);
      setReady(false);
      releasePreviewUrl();
      stopCameraStream(streamRef.current);
      streamRef.current = null;
      if (preview) preview.srcObject = null;
    };
  }, [open, attempt, releasePreviewUrl]);

  async function capturePhoto() {
    if (capturingRef.current || captured) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream || video.videoWidth === 0 || video.videoHeight === 0) return;

    capturingRef.current = true;
    setCapturing(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        setErrorKey("cameraStartFailed");
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.92),
      );
      if (streamRef.current !== stream || !stream) return;
      if (!blob) {
        setErrorKey("cameraStartFailed");
        return;
      }

      const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
      releasePreviewUrl();
      const previewUrl = URL.createObjectURL(blob);
      previewUrlRef.current = previewUrl;
      video.pause();
      setCaptured({ file, previewUrl });
    } finally {
      capturingRef.current = false;
      setCapturing(false);
    }
  }

  function retakePhoto() {
    releasePreviewUrl();
    setCaptured(null);
    const video = videoRef.current;
    if (video && streamRef.current) {
      void video.play().catch(() => {});
    }
  }

  const captureValidationError = captured ? (validateCapture?.(captured.file) ?? null) : null;

  function approvePhoto() {
    if (!captured || captureValidationError) return;
    const { file } = captured;
    releasePreviewUrl();
    setCaptured(null);
    onCapture(file);
    onOpenChange(false);
  }

  function retryCamera() {
    releasePreviewUrl();
    setErrorKey(null);
    setReady(false);
    setCaptured(null);
    setAttempt((current) => current + 1);
  }

  function useFilePicker() {
    releasePreviewUrl();
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCaptured(null);
    onOpenChange(false);
    onUseFilePicker();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("camera")} description={t("cameraDescription")} mobileWorkspace>
      <div className="flex min-h-0 flex-1 flex-col gap-2 sm:block sm:space-y-4">
        <div className="relative grid min-h-32 w-full flex-1 place-items-center overflow-hidden rounded-lg bg-black text-white sm:aspect-[4/3]">
          {!errorKey ? (
            <video
              ref={videoRef}
              className={captured ? "hidden" : "absolute inset-0 h-full w-full object-contain"}
              aria-label={t("cameraPreview")}
              autoPlay
              muted
              playsInline
              onCanPlay={() => setReady(true)}
            />
          ) : null}
          {captured ? (
            <img
              src={captured.previewUrl}
              alt={copy.capturedPreview}
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : null}
          {!ready && !errorKey && !captured ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black text-sm" role="status">
              <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
              <span>{t("cameraOpening")}</span>
            </div>
          ) : null}
          {capturing ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-sm" role="status">
              <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
              <span>{copy.capturingPhoto}</span>
            </div>
          ) : null}
          {errorKey ? (
            <div className="max-w-md px-6 text-center text-sm leading-6" role="alert">
              {t(errorKey)}
            </div>
          ) : null}
        </div>

        {captureValidationError ? (
          <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {captureValidationError}
          </p>
        ) : null}

        {errorKey ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 sm:gap-2 [&>button]:min-h-11 [&>button]:px-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="button" variant="outline" onClick={useFilePicker}>
              <ImagePlus aria-hidden="true" />
              {t("usePhotoPicker")}
            </Button>
            <Button type="button" onClick={retryCamera}>
              <RotateCcw aria-hidden="true" />
              {copy.retryCamera}
            </Button>
          </div>
        ) : captured ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 sm:gap-2 [&>button]:min-h-11 [&>button]:px-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="button" variant="outline" onClick={retakePhoto}>
              <RotateCcw aria-hidden="true" />
              {copy.retakePhoto}
            </Button>
            <Button type="button" disabled={Boolean(captureValidationError)} onClick={approvePhoto}>
              <Check aria-hidden="true" />
              {copy.usePhoto}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 sm:gap-2 [&>button]:min-h-11 [&>button]:px-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            {!ready ? (
              <Button type="button" variant="outline" onClick={useFilePicker}>
                <ImagePlus aria-hidden="true" />
                {t("usePhotoPicker")}
              </Button>
            ) : null}
            <Button type="button" disabled={!ready || capturing} onClick={() => void capturePhoto()}>
              {capturing ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Camera aria-hidden="true" />
              )}
              {capturing ? copy.capturingPhoto : t("takePhoto")}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
