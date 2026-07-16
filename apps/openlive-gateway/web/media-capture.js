/**
 * Openlive 26.7.15 — truthful visual capture lifecycle.
 *
 * Camera and screen state is derived from MediaStreamTrack.readyState rather
 * than button state. Capture remains local until the caller explicitly asks
 * for a bounded snapshot; continuous video is never implied.
 */

const DEFAULT_SNAPSHOT = Object.freeze({
  maxWidth: 1280,
  maxHeight: 720,
  quality: 0.82,
  mimeType: "image/jpeg",
});

export class MediaCaptureSession {
  constructor({ onState = () => {}, onError = () => {} } = {}) {
    this.onState = onState;
    this.onError = onError;
    this.cameraStream = null;
    this.screenStream = null;
    this.cameraPreview = null;
    this.screenPreview = null;
  }

  state() {
    return {
      camera: describeStream(this.cameraStream),
      screen: describeStream(this.screenStream),
    };
  }

  attachPreviews({ camera, screen } = {}) {
    this.cameraPreview = camera ?? this.cameraPreview;
    this.screenPreview = screen ?? this.screenPreview;
    attachStream(this.cameraPreview, this.cameraStream);
    attachStream(this.screenPreview, this.screenStream);
  }

  async startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw this.fail("camera", new Error("Camera capture is unavailable in this browser."));
    }
    await this.stopCamera("replaced");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24, max: 30 },
        },
      });
      this.cameraStream = stream;
      this.bindTrackEnd("camera", stream);
      attachStream(this.cameraPreview, stream);
      this.emit("camera", "active", "Camera preview is live locally.");
      return this.state().camera;
    } catch (error) {
      this.cameraStream = null;
      this.emit("camera", "blocked", captureErrorMessage("camera", error));
      throw this.fail("camera", error);
    }
  }

  async stopCamera(reason = "user") {
    stopStream(this.cameraStream);
    this.cameraStream = null;
    attachStream(this.cameraPreview, null);
    this.emit("camera", "inactive", reason === "ended" ? "Camera permission ended." : "Camera is off.");
  }

  async toggleCamera() {
    return this.state().camera.active ? this.stopCamera() : this.startCamera();
  }

  async startScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw this.fail("screen", new Error("Screen sharing is unavailable in this browser."));
    }
    await this.stopScreen("replaced");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          frameRate: { ideal: 8, max: 12 },
          displaySurface: "browser",
        },
        preferCurrentTab: true,
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
      });
      this.screenStream = stream;
      this.bindTrackEnd("screen", stream);
      attachStream(this.screenPreview, stream);
      this.emit("screen", "active", screenScopeLabel(stream));
      return this.state().screen;
    } catch (error) {
      this.screenStream = null;
      const status = error?.name === "NotAllowedError" ? "denied" : "blocked";
      this.emit("screen", status, captureErrorMessage("screen", error));
      throw this.fail("screen", error);
    }
  }

  async stopScreen(reason = "user") {
    stopStream(this.screenStream);
    this.screenStream = null;
    attachStream(this.screenPreview, null);
    this.emit("screen", "inactive", reason === "ended" ? "Screen permission ended." : "Screen sharing is off.");
  }

  async toggleScreen() {
    return this.state().screen.active ? this.stopScreen() : this.startScreen();
  }

  async snapshot(source = "camera", options = {}) {
    const stream = source === "screen" ? this.screenStream : this.cameraStream;
    const status = describeStream(stream);
    if (!status.active) throw new Error(`${source === "screen" ? "Screen" : "Camera"} capture is not active.`);

    const video = source === "screen" ? this.screenPreview : this.cameraPreview;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      throw new Error("The visual preview is not ready yet.");
    }

    const config = { ...DEFAULT_SNAPSHOT, ...options };
    const size = fitWithin(video.videoWidth, video.videoHeight, config.maxWidth, config.maxHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Snapshot canvas could not be created.");
    context.drawImage(video, 0, 0, size.width, size.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("Snapshot encoding failed."))),
        config.mimeType,
        config.quality,
      );
    });
    return {
      blob,
      width: size.width,
      height: size.height,
      mimeType: blob.type,
      source,
      capturedAt: new Date().toISOString(),
    };
  }

  async stopAll() {
    await Promise.all([this.stopCamera(), this.stopScreen()]);
  }

  bindTrackEnd(kind, stream) {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    track.addEventListener("ended", () => {
      if (kind === "camera" && this.cameraStream === stream) void this.stopCamera("ended");
      if (kind === "screen" && this.screenStream === stream) void this.stopScreen("ended");
    }, { once: true });
  }

  emit(kind, status, detail) {
    this.onState({ kind, status, detail, state: this.state(), occurredAt: new Date().toISOString() });
  }

  fail(kind, error) {
    this.onError({ kind, error, message: captureErrorMessage(kind, error) });
    return error;
  }
}

function describeStream(stream) {
  const track = stream?.getVideoTracks?.()[0];
  const active = Boolean(stream?.active && track && track.readyState === "live" && track.enabled);
  return {
    active,
    trackState: track?.readyState ?? "none",
    label: track?.label ?? "",
    settings: track?.getSettings?.() ?? {},
  };
}

function attachStream(video, stream) {
  if (!video) return;
  if (video.srcObject !== stream) video.srcObject = stream ?? null;
  video.hidden = !stream;
  if (stream) video.play().catch(() => {});
}

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

function fitWithin(width, height, maxWidth, maxHeight) {
  if (!width || !height) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function screenScopeLabel(stream) {
  const surface = stream?.getVideoTracks?.()[0]?.getSettings?.().displaySurface;
  const labels = { browser: "Browser tab", window: "Application window", monitor: "Entire screen" };
  return `${labels[surface] ?? "Shared surface"} is visible locally.`;
}

function captureErrorMessage(kind, error) {
  const label = kind === "screen" ? "Screen sharing" : "Camera access";
  if (error?.name === "NotAllowedError") return `${label} was not granted.`;
  if (error?.name === "NotFoundError") return `No compatible ${kind === "screen" ? "display surface" : "camera"} was found.`;
  if (error?.name === "NotReadableError") return `${label} is already in use or blocked by the operating system.`;
  return error?.message ?? `${label} could not start.`;
}
