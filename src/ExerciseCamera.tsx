import { useEffect, useRef, useState } from "react";
import { Camera, Check, RotateCcw, Shield, X } from "lucide-react";
import { calculateActivityXp, validateExerciseEstimate } from "./gameEngine";
import type { Activity, ActivityType } from "./domain";
import { ExerciseRepRecognizer, type CameraPerspective, type ExerciseKind, type PoseLandmark } from "./poseRecognition";
import { CAMERA_RECORDING_LIMIT_SECONDS, loadPoseRuntime, stopCameraTracks, type PoseRuntime } from "./poseRuntime";

const EXERCISES: { kind: ExerciseKind; label: string }[] = [
  { kind: "pushups", label: "Push-ups" },
  { kind: "squats", label: "Squats" },
];
const MIN_VISIBILITY = 0.55;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function cameraErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (!window.isSecureContext) return "Camera access requires a secure HTTPS connection.";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied. Allow camera access in your browser settings, then retry.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No compatible camera was found on this device.";
  if (name === "NotReadableError") return "The camera is busy in another app. Close that app and retry.";
  if (!navigator.mediaDevices?.getUserMedia) return "This browser does not support camera access. Update Chrome and open MYLVL over HTTPS.";
  return error instanceof Error ? error.message : "The camera could not be started. Please retry.";
}

function hasVisibleBody(landmarks: PoseLandmark[] | null, kind: ExerciseKind) {
  if (!landmarks || landmarks.length < 29) return false;
  const sides = kind === "pushups" ? [[11,13,15,23,25,27],[12,14,16,24,26,28]] : [[11,23,25,27],[12,24,26,28]];
  return sides.some((indices) => indices.every((i) => {
    const item=landmarks[i];
    return (item?.visibility ?? 0) >= MIN_VISIBILITY && item.x >= 0.01 && item.x <= 0.99 && item.y >= 0.01 && item.y <= 0.99;
  }));
}

type ExerciseCameraProps = { onClose(): void; onSave(activity: Activity): Promise<boolean> | boolean };
type Stage = "setup" | "countdown" | "recording" | "report" | "result" | "error";

/** Device-only live pose analysis. No MediaRecorder, video Blob, or video upload is used. */
export function ExerciseCamera({ onClose, onSave }: ExerciseCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runtimeRef = useRef<PoseRuntime | null>(null);
  const recognizerRef = useRef<ExerciseRepRecognizer | null>(null);
  const rafRef = useRef(0);
  const lastInferenceRef = useRef(0);
  const lastShownSecondRef = useRef(-1);
  const lastPositionRef = useRef(false);
  const liveRepsRef = useRef(0);
  const startRef = useRef(0);
  const runningRef = useRef(false);
  const stageRef = useRef<Stage>("setup");
  const [exercise, setExercise] = useState<ExerciseKind>("pushups");
  const [perspective, setPerspective] = useState<CameraPerspective>("side");
  const [facing, setFacing] = useState<"user" | "environment">("environment");
  const [stage, setStage] = useState<Stage>("setup");
  const [runtimeStatus, setRuntimeStatus] = useState("Not loaded");
  const [positionReady, setPositionReady] = useState(false);
  const [cameraLive, setCameraLive] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [liveReps, setLiveReps] = useState(0);
  const [reported, setReported] = useState("");
  const [analysis, setAnalysis] = useState<ReturnType<ExerciseRepRecognizer["finish"]> | null>(null);
  const [comparison, setComparison] = useState<ReturnType<typeof validateExerciseEstimate> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cameraEpoch, setCameraEpoch] = useState(0);
  stageRef.current = stage;

  function cleanup() {
    runningRef.current = false;
    cancelAnimationFrame(rafRef.current);
    runtimeRef.current?.close(); runtimeRef.current = null;
    stopCameraTracks(streamRef.current); streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }
  useEffect(() => () => cleanup(), []);
  useEffect(() => {
    const handlePageHidden = () => {
      if (!document.hidden) return;
      if (stageRef.current === "recording") {
        runningRef.current = false; cancelAnimationFrame(rafRef.current);
        setAnalysis(null); setError("The camera session was stopped because MYLVL went into the background. No activity was saved.");
        cleanup(); setCameraLive(false); setStage("error");
      } else if (stageRef.current === "countdown" || stageRef.current === "setup") {
        cleanup(); setCameraLive(false);
        if (stageRef.current === "countdown") setStage("setup");
      }
    };
    const handleOrientation = () => { lastPositionRef.current = false; setPositionReady(false); };
    document.addEventListener("visibilitychange", handlePageHidden);
    window.addEventListener("orientationchange", handleOrientation);
    return () => {
      document.removeEventListener("visibilitychange", handlePageHidden);
      window.removeEventListener("orientationchange", handleOrientation);
    };
  }, []);
  useEffect(() => {
    if (stage !== "countdown") return;
    if (countdown <= 0) {
      recognizerRef.current = new ExerciseRepRecognizer(exercise, perspective);
      liveRepsRef.current = 0; setLiveReps(0);
      startRef.current = performance.now(); lastInferenceRef.current = 0;
      runningRef.current = true; setStage("recording"); return;
    }
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [stage, countdown, exercise]);
  useEffect(() => {
    if (stage !== "recording" && stage !== "setup") return;
    if (!runtimeRef.current || !cameraLive) return;
    const update = () => {
      if (!runningRef.current) return;
      const now = performance.now();
      if (stage === "recording") {
        const second = Math.floor((now - startRef.current) / 1000);
        if (second !== lastShownSecondRef.current) { lastShownSecondRef.current = second; setElapsed(second); }
      }
      if (now - lastInferenceRef.current >= 180 && videoRef.current && runtimeRef.current) {
        lastInferenceRef.current = now;
        try {
          const landmarks = runtimeRef.current.detect(videoRef.current, now);
          const visible = hasVisibleBody(landmarks, exercise);
          if (visible !== lastPositionRef.current) { lastPositionRef.current = visible; setPositionReady(visible); }
          if (landmarks && stage === "recording") {
            const result = recognizerRef.current?.process({ landmarks, width: videoRef.current.videoWidth, height: videoRef.current.videoHeight, timestampMs: now });
            if (result && result.repetitions !== liveRepsRef.current) {
              liveRepsRef.current = result.repetitions;
              setLiveReps(result.repetitions);
            }
          }
        } catch (cause) { setError(cameraErrorMessage(cause)); stopSession(); setStage("error"); }
      }
      if (Math.floor((now - startRef.current) / 1000) >= CAMERA_RECORDING_LIMIT_SECONDS) stopSession();
      else rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafRef.current);
  }, [stage, cameraEpoch, cameraLive]);

  async function startCamera() {
    setError(""); setStage("setup"); setRuntimeStatus("Loading camera and pose model…");
    lastPositionRef.current = false; setPositionReady(false);
    cleanup();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support camera access.");
      if (!window.isSecureContext) throw new Error("Camera access requires HTTPS.");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 12, max: 15 } }, audio: false });
      streamRef.current = stream;
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
        if (stageRef.current === "recording" || stageRef.current === "countdown") {
          runningRef.current = false; setAnalysis(null); setError("The camera was interrupted. This session was discarded without EXP.");
          cleanup(); setCameraLive(false); setStage("error");
        }
      }, { once: true }));
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setCameraLive(true);
      const runtime = await loadPoseRuntime((state) => setRuntimeStatus(state === "ready" ? "Ready" : state === "error" ? "Could not load" : "Loading pose model…"));
      runtimeRef.current = runtime; setCameraEpoch((value) => value + 1);
    } catch (cause) {
      setError(cameraErrorMessage(cause)); setRuntimeStatus("Error"); setStage("error");
      cleanup(); setCameraLive(false);
    }
  }

  function stopSession() {
    if (!runningRef.current) return;
    runningRef.current = false; cancelAnimationFrame(rafRef.current);
    const seconds = Math.min(CAMERA_RECORDING_LIMIT_SECONDS, (performance.now() - startRef.current) / 1000);
    setElapsed(Math.floor(seconds));
    const result = recognizerRef.current?.finish(seconds) ?? null;
    setAnalysis(result); setComparison(null); setReported("");
    cleanup(); setCameraLive(false); setStage("report");
  }

  async function retry() {
    cleanup(); setCameraLive(false); setAnalysis(null); setComparison(null); setElapsed(0); setReported("");
    setStage("setup"); await startCamera();
  }

  function validate() {
    const userCount = Number(reported);
    if (!Number.isSafeInteger(userCount) || userCount <= 0 || !analysis) return;
    const result = validateExerciseEstimate({ detectedAmount: analysis.repetitions, userEstimate: userCount, confidence: analysis.confidence, minimumConfidence: 0.75 });
    setComparison(result); setStage("result");
  }

  async function confirmActivity() {
    if (!analysis || !comparison || comparison.status !== "accepted" || !UUID.test(sessionId)) return;
    setBusy(true);
    try {
      const type: ActivityType = exercise === "pushups" ? "Push-ups" : "Squats";
      const preview = calculateActivityXp({ type: exercise, source: "camera", recordedSession: true,
        metrics: { repetitions: analysis.repetitions },
        exerciseValidation: { detectedAmount: analysis.repetitions, userEstimate: Number(reported), confidence: analysis.confidence, minimumConfidence: 0.75 } });
      const saved = await onSave({
        id: sessionId, type, date: new Date().toISOString(), duration: Math.max(1, Math.ceil(analysis.durationSeconds / 60)),
        reps: analysis.repetitions, xp: preview.xp, source: "camera", sourceKey: sessionId, validationStatus: "pose_validated",
        exerciseSession: { sessionId, reportedReps: Number(reported), detectedReps: analysis.repetitions, confidence: analysis.confidence,
          validationMethod: "local_pose_landmarks", recordingDurationSeconds: analysis.durationSeconds,
          modelVersion: "pose_landmarker_lite_float16_v1", validationVersion: "mylvl-pose-v1", cameraPerspective: perspective, usableFrames: analysis.usableFrames,
          usableRatio: analysis.usableRatio, deviationPercent: comparison.deviationPercent },
      });
      if (saved) onClose();
    } finally { setBusy(false); }
  }
  const sessionId = useRef(crypto.randomUUID()).current;
  const counts = analysis && Number(reported) > 0 ? validateExerciseEstimate({ detectedAmount: analysis.repetitions, userEstimate: Number(reported), confidence: analysis.confidence, minimumConfidence: 0.75 }) : null;
  const expPreview = analysis && counts?.status === "accepted" ? calculateActivityXp({ type: exercise, source: "camera", recordedSession: true,
    metrics: { repetitions: analysis.repetitions }, exerciseValidation: { detectedAmount: analysis.repetitions, userEstimate: Number(reported), confidence: analysis.confidence, minimumConfidence: 0.75 } }).xp : 0;

  return <div className="modal-scrim camera-scrim" role="presentation"><section className="activity-modal exercise-camera" role="dialog" aria-modal="true" aria-labelledby="camera-title">
    <header className="modal-head"><div><div className="eyebrow">ON-DEVICE EXERCISE RECOGNITION</div><h2 id="camera-title">Camera workout</h2></div><button className="icon-button" onClick={() => { cleanup(); onClose(); }} aria-label="Close"><X size={18}/></button></header>
    <p>Choose a standard bodyweight movement. The app analyzes the live camera feed on this device; it does not record or upload a video.</p>
    <div className="camera-exercise-tabs">{EXERCISES.map((item) => <button key={item.kind} className={exercise === item.kind ? "active" : ""} disabled={stage === "recording" || stage === "countdown"} onClick={() => { setExercise(item.kind); setStage("setup"); setAnalysis(null); setComparison(null); }}>{item.label}</button>)}</div>
    <div className="camera-perspectives" role="group" aria-label="Camera angle">
      <button className={perspective === "side" ? "active" : ""} disabled={stage === "recording" || stage === "countdown"} onClick={() => setPerspective("side")}>Side view · recommended</button>
      <button className={perspective === "diagonal-front" ? "active" : ""} disabled={stage === "recording" || stage === "countdown"} onClick={() => setPerspective("diagonal-front")}>Diagonal front · beta</button>
    </div>
    <div className="camera-preview-wrap">
      <video ref={videoRef} className={facing === "user" ? "camera-preview mirrored" : "camera-preview"} playsInline muted aria-label="Live camera preview" />
      {!cameraLive && <div className="camera-placeholder"><Camera size={26}/><span>Camera preview will appear here.</span></div>}
      {stage === "setup" && <div className={`camera-guide-overlay ${perspective}`} aria-hidden="true">
        <div className="camera-guide-frame"><svg viewBox="0 0 240 120" focusable="false"><rect x="12" y="8" width="216" height="100" rx="12" stroke-dasharray="6 5"/><circle cx="65" cy="54" r="8"/><path d="M74 55h44l34 5h35M118 60l-13 23H87M152 60l16 23h28"/><rect x="102" y="87" width="26" height="18" rx="3"/><path d="M108 87l4-5h7l4 5m-13 9a4 4 0 1 0 8 0 4 4 0 0 0-8 0"/></svg></div>
        <span>{perspective === "side" ? "SIDE · phone beside you, 2–3 m away, 30–60 cm high" : "DIAGONAL FRONT · 30–45°, 2–3 m away, 30–60 cm high"}</span>
      </div>}
      {(stage === "countdown" || stage === "recording") && <div className="camera-status-pill">{stage === "countdown" ? `Ready in ${countdown}` : `Recording · ${String(Math.floor(elapsed / 60)).padStart(2,"0")}:${String(elapsed % 60).padStart(2,"0")} · ${liveReps} reps`}</div>}
    </div>
    <div className={`camera-position ${positionReady ? "ready" : ""}`} role="status" aria-live="polite"><span className="camera-state-dot"/>{positionReady ? "Body visible — hold the selected camera angle." : cameraLive ? "MYLVL cannot see enough of your body yet. Move the phone farther back and include your full body. You can still start, but reps may not be detected." : <>{perspective === "side" ? "Stand side-on to the camera; keep your whole body, hands and feet in frame." : "Place the camera 30–45° diagonally in front; keep your whole body, hands and feet in frame. This angle is experimental."} Use good light and leave space around you.</>}</div>
    <div className="camera-note"><Shield size={16}/><span>Local recognition is a helpful estimate, not tamper-proof proof or professional form assessment. Maximum analysis time: 90 seconds. Performance metrics may be provided by the model host; video frames stay on your device.</span></div>
    {stage === "recording" && <div className="camera-recording-guidance" role="status" aria-live="polite"><strong>Live count: {liveReps} reps</strong><span>Movement is analyzed as you go. When your set is done, tap “Finish set &amp; analyze” below. Next, enter your count, compare it, and confirm to save. Nothing is saved yet.</span></div>}
    <div className={`camera-controls ${stage === "recording" ? "is-recording" : ""}`}>
      {stage === "setup" && <><label>Camera<select value={facing} onChange={(e) => setFacing(e.target.value as "user"|"environment")}><option value="environment">Rear camera</option><option value="user">Front camera</option></select></label><button className="primary-button" onClick={() => void startCamera()}>{cameraLive ? "Reload camera" : "Enable camera"}</button>{cameraLive && runtimeRef.current && <button className="primary-button" onClick={() => { setError(""); setCountdown(3); setStage("countdown"); }}>Start · 3-second countdown</button>}</>}
      {stage === "countdown" && <button className="secondary-button" onClick={() => setStage("setup")}>Cancel countdown</button>}
      {stage === "recording" && <><span>Pose engine: {runtimeStatus} · no video file is created</span><button className="primary-button" onClick={stopSession}>Finish set &amp; analyze</button><button className="secondary-button" onClick={() => { runningRef.current = false; cleanup(); setCameraLive(false); setAnalysis(null); setStage("setup"); }}>Cancel session</button></>}
      {stage === "report" && <><label className="field-label">How many did you complete? Enter your count before seeing the detected result.<input type="number" min="1" step="1" inputMode="numeric" value={reported} onChange={(e) => setReported(e.target.value)} /></label><button className="primary-button" disabled={!Number.isSafeInteger(Number(reported)) || Number(reported) <= 0} onClick={validate}>Compare and validate</button><button className="secondary-button" onClick={() => void retry()}><RotateCcw size={15}/> Retry recording</button></>}
      {stage === "result" && <><div className="camera-result"><b>Detected {analysis?.repetitions} · You reported {reported}</b><span>Pose confidence {Math.round((analysis?.confidence ?? 0) * 100)}% · usable frames {analysis?.usableFrames}/{analysis?.totalFrames}</span><span className={comparison?.status === "accepted" ? "camera-success" : "camera-warning"}>{comparison?.status === "accepted" ? `Validated · ${comparison.deviationPercent?.toFixed(1)}% difference` : `Not validated · ${comparison?.status}${comparison?.deviationPercent == null ? "" : ` · ${comparison.deviationPercent.toFixed(1)}% difference`}`}</span>{analysis?.warnings.map((warning) => <small key={warning}>{warning}</small>)}</div>{comparison?.status === "accepted" ? <><div className="camera-result"><b>Estimated reward: {expPreview} EXP</b><span>Server recalculates this using the existing activity rates and daily limits.</span></div><button className="primary-button" disabled={busy} onClick={() => void confirmActivity()}><Check size={16}/> {busy ? "Saving…" : "Confirm activity"}</button></> : <p className="camera-warning">No EXP is awarded. Retry with a clear side view and a complete movement cycle.</p>}<button className="secondary-button" onClick={() => void retry()}><RotateCcw size={15}/> Retry</button></>}
      {stage === "error" && <><div className="camera-warning" role="alert">{error}</div><button className="primary-button" onClick={() => void startCamera()}>Retry camera</button></>}
    </div>
    <small className="camera-runtime">Pose runtime: {runtimeStatus}{cameraEpoch ? " · MediaPipe Pose Landmarker Lite" : ""}{error && stage !== "error" ? ` · ${error}` : ""}</small>
    <p className="camera-limits">Supported in this version: standard push-ups and bodyweight squats. Exercise variations and form quality are not assessed. Leaving the screen stops the camera and releases resources.</p>
  </section></div>;
}

