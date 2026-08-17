export type CameraProvider = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
};

export type CameraErrorKey = "cameraPermissionDenied" | "cameraUnavailable" | "cameraStartFailed";

export const environmentCameraConstraints: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: "environment" } },
};

export function supportsCamera(provider: CameraProvider | undefined): provider is CameraProvider {
  return typeof provider?.getUserMedia === "function";
}

export function requestEnvironmentCamera(provider: CameraProvider) {
  return provider.getUserMedia(environmentCameraConstraints);
}

export function stopCameraStream(stream: Pick<MediaStream, "getTracks"> | null) {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

export function cameraErrorKey(error: unknown): CameraErrorKey {
  const name = error instanceof DOMException
    ? error.name
    : typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "";

  if (name === "NotAllowedError" || name === "SecurityError") {
    return "cameraPermissionDenied";
  }
  if (name === "NotFoundError" || name === "NotReadableError" || name === "OverconstrainedError") {
    return "cameraUnavailable";
  }
  return "cameraStartFailed";
}
