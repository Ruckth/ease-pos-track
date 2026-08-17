import assert from "node:assert/strict";
import test from "node:test";
import {
  cameraErrorKey,
  environmentCameraConstraints,
  requestEnvironmentCamera,
  stopCameraStream,
  supportsCamera,
  type CameraProvider,
} from "../src/lib/camera";
import { translate } from "../src/lib/i18n";

test("camera requests an environment-facing video stream without audio", async () => {
  let requested: MediaStreamConstraints | undefined;
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const provider: CameraProvider = {
    getUserMedia: async (constraints) => {
      requested = constraints;
      return stream;
    },
  };

  assert.equal(supportsCamera(provider), true);
  assert.equal(await requestEnvironmentCamera(provider), stream);
  assert.deepEqual(requested, environmentCameraConstraints);
});

test("camera support detection rejects missing APIs", () => {
  assert.equal(supportsCamera(undefined), false);
  assert.equal(supportsCamera({ getUserMedia: undefined } as unknown as CameraProvider), false);
});

test("closing the camera stops every media track", () => {
  const stopped: string[] = [];
  const stream = {
    getTracks: () => [
      { stop: () => stopped.push("video") },
      { stop: () => stopped.push("audio") },
    ],
  } as unknown as Pick<MediaStream, "getTracks">;

  stopCameraStream(stream);
  assert.deepEqual(stopped, ["video", "audio"]);
});

test("camera errors provide actionable localized messages", () => {
  assert.equal(cameraErrorKey({ name: "NotAllowedError" }), "cameraPermissionDenied");
  assert.equal(cameraErrorKey({ name: "NotFoundError" }), "cameraUnavailable");
  assert.equal(cameraErrorKey(new Error("unexpected")), "cameraStartFailed");
  for (const key of ["cameraPermissionDenied", "cameraUnavailable", "cameraStartFailed"] as const) {
    assert.notEqual(translate("th", key), translate("en", key));
  }
});
