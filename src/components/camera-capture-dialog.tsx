import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  cameraErrorKey,
  requestEnvironmentCamera,
  stopCameraStream,
  type CameraErrorKey,
} from "@/lib/camera";
import { useI18n } from "@/lib/i18n";

type CameraCaptureDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCapture: (file: File) => void;
  onUseFilePicker: () => void;
};

export function CameraCaptureDialog({ open, onOpenChange, onCapture, onUseFilePicker }: CameraCaptureDialogProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [errorKey, setErrorKey] = useState<CameraErrorKey | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
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
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (error) {
        if (!cancelled) {
          stopCameraStream(streamRef.current);
          streamRef.current = null;
          if (videoRef.current) videoRef.current.srcObject = null;
          setErrorKey(cameraErrorKey(error));
        }
      }
    }

    void startCamera();
    return () => {
      cancelled = true;
      setReady(false);
      stopCameraStream(streamRef.current);
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [open]);

  async function capturePhoto() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setErrorKey("cameraStartFailed");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      setErrorKey("cameraStartFailed");
      return;
    }

    onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
    onOpenChange(false);
  }

  function useFilePicker() {
    onUseFilePicker();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("camera")} description={t("cameraDescription")}>
      <div className="space-y-4">
        <div className="relative grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-lg bg-black text-white">
          {!errorKey ? (
            <video
              ref={videoRef}
              className="h-full w-full object-contain"
              aria-label={t("cameraPreview")}
              autoPlay
              muted
              playsInline
              onCanPlay={() => setReady(true)}
            />
          ) : null}
          {!ready && !errorKey ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black text-sm" role="status">
              <LoaderCircle className="size-6 animate-spin" />
              <span>{t("cameraOpening")}</span>
            </div>
          ) : null}
          {errorKey ? (
            <div className="max-w-md px-6 text-center text-sm leading-6" role="alert">
              {t(errorKey)}
            </div>
          ) : null}
        </div>

        {errorKey ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
            <Button type="button" onClick={useFilePicker}>
              <ImagePlus />
              {t("usePhotoPicker")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
            <Button type="button" disabled={!ready} onClick={() => void capturePhoto()}>
              <Camera />
              {t("takePhoto")}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
