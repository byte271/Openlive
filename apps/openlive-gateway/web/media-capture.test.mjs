import assert from "node:assert/strict";
import test from "node:test";
import { MediaCaptureSession } from "./media-capture.js";

class FakeTrack extends EventTarget {
  constructor(kind) {
    super();
    this.kind = kind;
    this.readyState = "live";
    this.enabled = true;
    this.label = `fake-${kind}`;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }

  endFromBrowser() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }

  getSettings() {
    return {};
  }
}

class FakeStream {
  constructor(track) {
    this.track = track;
    this.active = true;
  }

  getTracks() {
    return [this.track];
  }

  getVideoTracks() {
    return [this.track];
  }
}

function installMediaDevices({ cameraTrack, screenTrack }) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia() {
          return new FakeStream(cameraTrack);
        },
        async getDisplayMedia() {
          return new FakeStream(screenTrack);
        },
      },
    },
  });
}

test("camera state is active only while a live track exists", async () => {
  const cameraTrack = new FakeTrack("video");
  const screenTrack = new FakeTrack("video");
  installMediaDevices({ cameraTrack, screenTrack });
  const events = [];
  const capture = new MediaCaptureSession({ onState: (event) => events.push(event) });

  await capture.startCamera();
  assert.equal(capture.state().camera.active, true);
  assert.equal(events.at(-1).status, "active");

  await capture.stopCamera("user_stopped");
  assert.equal(capture.state().camera.active, false);
  assert.equal(cameraTrack.stopped, true);
  assert.equal(events.at(-1).detail, "Camera is off.");
});

test("screen state turns off when the browser ends sharing", async () => {
  const cameraTrack = new FakeTrack("video");
  const screenTrack = new FakeTrack("video");
  installMediaDevices({ cameraTrack, screenTrack });
  const events = [];
  const capture = new MediaCaptureSession({ onState: (event) => events.push(event) });

  await capture.startScreen();
  assert.equal(capture.state().screen.active, true);
  screenTrack.endFromBrowser();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(capture.state().screen.active, false);
  assert.equal(events.at(-1).status, "inactive");
  assert.equal(events.at(-1).detail, "Screen permission ended.");
});

test("stopAll clears camera and screen without stale truth indicators", async () => {
  const cameraTrack = new FakeTrack("video");
  const screenTrack = new FakeTrack("video");
  installMediaDevices({ cameraTrack, screenTrack });
  const capture = new MediaCaptureSession();

  await capture.startCamera();
  await capture.startScreen();
  await capture.stopAll();

  assert.equal(capture.state().camera.active, false);
  assert.equal(capture.state().screen.active, false);
  assert.equal(capture.state().camera.trackState, "none");
  assert.equal(capture.state().screen.trackState, "none");
  assert.equal(cameraTrack.stopped, true);
  assert.equal(screenTrack.stopped, true);
});
