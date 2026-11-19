import type { PoseLandmark } from "./poseRecognition";

/** Pinned, lazy-loaded MediaPipe web runtime. Video frames are only analyzed locally. */
const TASKS_VERSION = "1.2.3";
const TASKS_MODULE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/vision_bundle.mjs`;
const TASKS_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export type PoseRuntimeState = "loading" | "ready" | "error";
export type PoseRuntime = {
  detect(video: HTMLVideoElement, timestampMs: number): PoseLandmark[] | null;
  close(): void;
};
type VisionApi = {
  FilesetResolver: { forVisionTasks(path: string): Promise<unknown> };
  PoseLandmarker: { createFromOptions(files: unknown, options: Record<string, unknown>): Promise<{
    detectForVideo(video: HTMLVideoElement, timestampMs: number): { landmarks?: PoseLandmark[][] };
    close(): void;
  }> };
};

export async function loadPoseRuntime(onState?: (state: PoseRuntimeState) => void): Promise<PoseRuntime> {
  onState?.("loading");
  try {
    // @vite-ignore keeps the remote runtime out of the initial PWA bundle.
    const vision = await import(/* @vite-ignore */ TASKS_MODULE) as VisionApi;
    const files = await vision.FilesetResolver.forVisionTasks(TASKS_WASM);
    const landmarker = await vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: "CPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.55,
      minPosePresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });
    onState?.("ready");
    let closed = false;
    return {
      detect(video, timestampMs) {
        if (closed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
        const result = landmarker.detectForVideo(video, timestampMs);
        return result.landmarks?.[0] ?? null;
      },
      close() {
        if (closed) return;
        closed = true;
        landmarker.close();
      },
    };
  } catch (error) {
    onState?.("error");
    throw error;
  }
}

export function stopCameraTracks(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}

export const CAMERA_RECORDING_LIMIT_SECONDS = 90;

