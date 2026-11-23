import { useEffect, useRef, useState } from "react";
import { CameraStartup, keepCameraResource } from "./cameraStartup";
import { Camera, Check, RotateCcw, Shield, X } from "lucide-react";
import { calculateActivityXp, validateExerciseEstimate } from "./gameEngine";
import type { Activity, ActivityType } from "./domain";
import { ExerciseRepRecognizer, type CameraPerspective, type ExerciseKind, type PoseLandmark } from "./poseRecognition";
import { MAX_PLANK_SAMPLE_GAP_MS, PlankHoldRecognizer, type PlankAnalysis } from "./plankRecognition";
import { CAMERA_RECORDING_LIMIT_SECONDS, loadPoseRuntime, stopCameraTracks, type PoseRuntime } from "./poseRuntime";

const EXERCISES: { kind: ExerciseKind; label: string }[] = [
  { kind: "pushups", label: "Push-ups" },
  { kind: "squats", label: "Squats" },
  { kind: "situps", label: "Sit-ups" },
  { kind: "plank", label: "Plank" },
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

function hasVisibleBody(landmarks: PoseLandmark[] | null, kind: ExerciseKind, perspective: CameraPerspective) {
  if (!landmarks || landmarks.length < 29) return false;
  if (kind === "pushups" && perspective !== "side") {
    const head = landmarks[0];
    const headVisible = (head?.visibility ?? 0) >= MIN_VISIBILITY && head.x >= 0.01 && head.x <= 0.99 && head.y >= 0.01 && head.y <= 0.99;
    const arms = [[11,13,15],[12,14,16]];
    return headVisible && arms.some((indices) => indices.every((i) => {
      const item = landmarks[i];
      return (item?.visibility ?? 0) >= MIN_VISIBILITY && item.x >= 0.01 && item.x <= 0.99 && item.y >= 0.01 && item.y <= 0.99;
    }));
  }
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
  const [cameraStartup] = useState(() => new CameraStartup());
  const [startingCamera, setStartingCamera] = useState(false);
  const lastPlankVideoTimeRef = useRef(-1);
  const lastPlankSampleAtRef = useRef(0);
  const recognizerRef = useRef<ExerciseRepRecognizer | null>(null);
  const plankRecognizerRef = useRef<PlankHoldRecognizer | null>(null);
  const rafRef = useRef(0);
  const lastInferenceRef = useRef(0);
  const lastShownSecondRef = useRef(-1);
  const lastPositionRef = useRef(false);
  const startRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const stageRef = useRef<Stage>("setup");
  const [exercise, setExercise] = useState<ExerciseKind>("pushups");
  const [perspective, setPerspective] = useState<CameraPerspective>("front");
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [stage, setStage] = useState<Stage>("setup");
  const [runtimeStatus, setRuntimeStatus] = useState("Not loaded");
  const [positionReady, setPositionReady] = useState(false);
  const [cameraLive, setCameraLive] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [livePlankValid, setLivePlankValid] = useState(false);
  const [repStatus, setRepStatus] = useState("Waiting for a clear arm cycle.");
  const [reported, setReported] = useState("");
  const [analysis, setAnalysis] = useState<ReturnType<ExerciseRepRecognizer["finish"]> | null>(null);
  const [plankAnalysis, setPlankAnalysis] = useState<PlankAnalysis | null>(null);
  const [comparison, setComparison] = useState<ReturnType<typeof validateExerciseEstimate> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cameraEpoch, setCameraEpoch] = useState(0);
  stageRef.current = stage;

  function releaseCamera() {
    runningRef.current = false;
    cancelAnimationFrame(rafRef.current);
    runtimeRef.current?.close(); runtimeRef.current = null;
    stopCameraTracks(streamRef.current); streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }
  function cleanup() {
    cameraStartup.cancel();
    releaseCamera();
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
      recognizerRef.current = exercise === "plank" ? null : new ExerciseRepRecognizer(exercise, perspective);
      plankRecognizerRef.current = exercise === "plank" ? new PlankHoldRecognizer() : null;
      lastPlankVideoTimeRef.current = -1;
      lastPlankSampleAtRef.current = 0;
      lastShownSecondRef.current = -1;
      setLivePlankValid(false);
      setRepStatus(exercise === "plank" ? "Hold the plank position steadily." : "Start in the ready position, then complete the movement.");
      sessionIdRef.current = crypto.randomUUID();
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
      // Aim for up to 15 inference samples per second so brisk reps are less likely to fall between frames.
      if (now - lastInferenceRef.current >= 66 && videoRef.current && runtimeRef.current) {
        lastInferenceRef.current = now;
        try {
          const video = videoRef.current;
          const plank = stage === "recording" ? plankRecognizerRef.current : null;
          const repeatedPlankFrame = plank && video.currentTime === lastPlankVideoTimeRef.current;
          if (repeatedPlankFrame) {
            if (now - lastPlankSampleAtRef.current > MAX_PLANK_SAMPLE_GAP_MS) {
              setLivePlankValid(plank.missingFrame().valid);
            }
          } else {
            const landmarks = runtimeRef.current.detect(video, now);
            const visible = hasVisibleBody(landmarks, exercise, perspective);
            if (visible !== lastPositionRef.current) { lastPositionRef.current = visible; setPositionReady(visible); }
            if (stage === "recording") {
              const frame = landmarks ? { landmarks, width: video.videoWidth, height: video.videoHeight, timestampMs: now } : null;
              if (plank) {
                lastPlankVideoTimeRef.current = video.currentTime;
                lastPlankSampleAtRef.current = now;
                setLivePlankValid((frame ? plank.process(frame) : plank.missingFrame()).valid);
              } else if (frame) {
                const result = recognizerRef.current?.process(frame);
                if (result) {
                  const status = result.warning ? `Adjust: ${result.warning}` : `Tracking movement: ${result.phase}.`;
                  setRepStatus((previous) => previous === status ? previous : status);
                }
              }
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
    const started = await cameraStartup.run(async (signal) => {
      setStartingCamera(true);
      setError("");
      setStage("setup");
      setRuntimeStatus("Loading camera and pose model…");
      lastPositionRef.current = false;
      setPositionReady(false);
      releaseCamera();
      setCameraLive(false);
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support camera access.");
        if (!window.isSecureContext) throw new Error("Camera access requires HTTPS.");
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }, audio: false });
        if (!keepCameraResource(stream, signal, stopCameraTracks)) return;
        streamRef.current = stream;
        stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
          if (streamRef.current !== stream) return;
          setAnalysis(null);
          setPlankAnalysis(null);
          setError("The camera was interrupted. This session was discarded without EXP.");
          cleanup();
          setCameraLive(false);
          setStage("error");
        }, { once: true }));
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
        if (signal.aborted) return;
        setCameraLive(true);
        const runtime = await loadPoseRuntime((state) => {
          if (!signal.aborted) setRuntimeStatus(state === "ready" ? "Ready" : state === "error" ? "Could not load" : "Loading pose model…");
        });
        if (!keepCameraResource(runtime, signal, (resource) => resource.close())) return;
        runtimeRef.current = runtime;
        setCameraEpoch((value) => value + 1);
      } catch (cause) {
        if (signal.aborted) return;
        setError(cameraErrorMessage(cause));
        setRuntimeStatus("Error");
        setStage("error");
        releaseCamera();
        setCameraLive(false);
      } finally {
        setStartingCamera(false);
      }
    });
    if (!started && !startingCamera) {
      setError("A previous camera request is still finishing. Wait for it to close, then retry.");
      setStage("error");
    }
  }

  function stopSession() {
    if (!runningRef.current) return;
    runningRef.current = false; cancelAnimationFrame(rafRef.current);
    const seconds = Math.min(CAMERA_RECORDING_LIMIT_SECONDS, (performance.now() - startRef.current) / 1000);
    setElapsed(Math.floor(seconds));
    if (exercise === "plank") {
      setPlankAnalysis(plankRecognizerRef.current?.finish(seconds) ?? null);
      setAnalysis(null);
    } else {
      setAnalysis(recognizerRef.current?.finish(seconds) ?? null);
      setPlankAnalysis(null);
    }
    setComparison(null); setReported("");
    cleanup(); setCameraLive(false); setStage("report");
  }

  async function retry() {
    cleanup(); setCameraLive(false); setAnalysis(null); setPlankAnalysis(null); setComparison(null); setElapsed(0); setReported("");
    setStage("setup"); await startCamera();
  }

  function validate() {
    const userCount = Number(reported);
    const detectedAmount = exercise === "plank" ? plankAnalysis?.validSeconds : analysis?.repetitions;
    const confidence = exercise === "plank" ? plankAnalysis?.confidence : analysis?.confidence;
    const ready = exercise === "plank" ? plankAnalysis?.validationReady && (detectedAmount ?? 0) > 0 : Boolean(analysis?.validationReady);
    if (!Number.isFinite(userCount) || userCount <= 0 || detectedAmount === undefined || confidence === undefined || !ready) {
      const warnings = exercise === "plank" ? plankAnalysis?.warnings : analysis?.warnings;
      setError(warnings?.length ? warnings.join(" ") : "The camera did not collect enough clear movement data. Please retry.");
      return;
    }
    if (exercise !== "plank" && !Number.isSafeInteger(userCount)) return;
    const result = validateExerciseEstimate({ detectedAmount, userEstimate: userCount, confidence, minimumConfidence: 0.60, maximumDeviationPercent: 10 });
    setComparison(result); setStage("result");
  }

  async function confirmActivity() {
    const sessionId = sessionIdRef.current;
    const detectedAmount = exercise === "plank" ? plankAnalysis?.validSeconds : analysis?.repetitions;
    const confidence = exercise === "plank" ? plankAnalysis?.confidence : analysis?.confidence;
    const frames = exercise === "plank" ? plankAnalysis?.usableFrames : analysis?.usableFrames;
    const ratio = exercise === "plank" ? plankAnalysis?.usableRatio : analysis?.usableRatio;
    const durationSeconds = exercise === "plank" ? plankAnalysis?.recordingSeconds : analysis?.durationSeconds;
    if (detectedAmount === undefined || confidence === undefined || frames === undefined || ratio === undefined || durationSeconds === undefined || !comparison || comparison.status !== "accepted" || !sessionId || !UUID.test(sessionId)) return;
    setBusy(true);
    try {
      const type: ActivityType = exercise === "pushups" ? "Push-ups" : exercise === "squats" ? "Squats" : exercise === "situps" ? "Sit-ups" : "Plank";
      const metricType = exercise === "plank" ? "hold_seconds" as const : "repetitions" as const;
      const preview = calculateActivityXp({ type: exercise, source: "camera", recordedSession: true,
        metrics: exercise === "plank" ? { holdSeconds: detectedAmount } : { repetitions: detectedAmount },
        exerciseValidation: { detectedAmount, userEstimate: Number(reported), confidence, minimumConfidence: 0.60, maximumDeviationPercent: 10 } });
      const exerciseSession = { sessionId, exerciseType: exercise, metricType,
        ...(exercise === "plank" ? { reportedHoldSeconds: Number(reported), detectedHoldSeconds: detectedAmount } : { reportedReps: Number(reported), detectedReps: detectedAmount }),
        confidence, validationMethod: "local_pose_landmarks", recordingDurationSeconds: durationSeconds,
        modelVersion: "pose_landmarker_lite_float16_v1", validationVersion: "mylvl-pose-v1", cameraPerspective: perspective, usableFrames: frames,
        usableRatio: ratio, deviationPercent: comparison.deviationPercent };
      const saved = await onSave({
        id: sessionId, type, date: new Date().toISOString(), duration: Math.max(1, Math.ceil(durationSeconds / 60)),
        ...(exercise === "plank" ? { holdSeconds: detectedAmount } : { reps: detectedAmount }),
        xp: preview.xp, source: "camera", sourceKey: sessionId, validationStatus: "pose_validated", exerciseSession,
      });
      if (saved) onClose();
    } finally { setBusy(false); }
  }
  const detectedAmount = exercise === "plank" ? plankAnalysis?.validSeconds : analysis?.repetitions;
  const currentConfidence = exercise === "plank" ? plankAnalysis?.confidence : analysis?.confidence;
  const counts = detectedAmount !== undefined && currentConfidence !== undefined && Number(reported) > 0
    ? validateExerciseEstimate({ detectedAmount, userEstimate: Number(reported), confidence: currentConfidence, minimumConfidence: 0.60, maximumDeviationPercent: 10 }) : null;
  const xpReady = exercise === "plank" ? Boolean(plankAnalysis?.validationReady && (detectedAmount ?? 0) > 0) : Boolean(analysis?.validationReady);
  const expPreview = xpReady && detectedAmount !== undefined && currentConfidence !== undefined && counts?.status === "accepted" ? calculateActivityXp({ type: exercise, source: "camera", recordedSession: true,
    metrics: exercise === "plank" ? { holdSeconds: detectedAmount } : { repetitions: detectedAmount },
    exerciseValidation: { detectedAmount, userEstimate: Number(reported), confidence: currentConfidence, minimumConfidence: 0.60, maximumDeviationPercent: 10 } }).xp : 0;

  return <div className="modal-scrim camera-scrim" role="presentation"><section className="activity-modal exercise-camera" role="dialog" aria-modal="true" aria-labelledby="camera-title">
    <header className="modal-head"><div><div className="eyebrow">ON-DEVICE EXERCISE RECOGNITION</div><h2 id="camera-title">Camera workout</h2></div><button className="icon-button" onClick={() => { cleanup(); onClose(); }} aria-label="Close"><X size={18}/></button></header>
    <p>Choose a standard bodyweight movement. The app analyzes the live camera feed on this device; it does not record or upload a video.</p>
    <div className="camera-exercise-tabs">{EXERCISES.map((item) => <button key={item.kind} className={exercise === item.kind ? "active" : ""} disabled={stage === "recording" || stage === "countdown"} onClick={() => { setExercise(item.kind); if (item.kind === "plank" || item.kind === "situps") setPerspective("side"); setStage("setup"); setAnalysis(null); setPlankAnalysis(null); setComparison(null); }}>{item.label}</button>)}</div>
    <div className="camera-perspectives" role="group" aria-label="Camera angle">
      <button className={perspective === "front" ? "active" : ""} disabled={exercise === "plank" || exercise === "situps" || stage === "recording" || stage === "countdown"} onClick={() => setPerspective("front")}>Front view · recommended</button>
      <button className={perspective === "side" ? "active" : ""} disabled={stage === "recording" || stage === "countdown"} onClick={() => setPerspective("side")}>Side view · alternative</button>
    </div>
    <div className="camera-preview-wrap">
      <video ref={videoRef} className={facing === "user" ? "camera-preview mirrored" : "camera-preview"} playsInline muted aria-label="Live camera preview" />
      {!cameraLive && <div className="camera-placeholder"><Camera size={26}/><span>Camera preview will appear here.</span></div>}
      {stage === "setup" && <div className={`camera-guide-overlay ${perspective}`} aria-hidden="true">
        <div className="camera-guide-frame"><svg viewBox="0 0 240 120" focusable="false"><path className="guide-silhouette" d="M120 8c-10 0-17 8-17 18 0 8 4 14 11 17v5c-13 1-25 4-32 10-5 4-10 11-15 20L49 96c-3 5 0 10 5 10 3 0 5-2 7-5l19-22 15-16-6 24-7 23h76l-7-23-6-24 15 16 19 22c2 3 4 5 7 5 5 0 8-5 5-10l-18-18c-5-9-10-16-15-20-7-6-19-9-32-10v-5c7-3 11-9 11-17 0-10-7-18-17-18z"/><path className="guide-center" d="M120 49v58M87 58l33 9 33-9"/></svg></div>
        {perspective === "front" && <div className="camera-guide-lines">
          <div className="camera-guide-line head"><b>HEAD</b></div>
          <div className="camera-guide-line shoulders"><b>SHOULDERS</b></div>
          <div className="camera-guide-line hands"><b>HANDS</b></div>
        </div>}
        <span>{perspective === "front" ? "Line up your head, shoulders and hands · 1–2 m away · 30–60 cm high" : "SIDE · phone beside you · 2–3 m away · 30–60 cm high"}</span>
      </div>}
      {(stage === "countdown" || stage === "recording") && <div className="camera-status-pill">{stage === "countdown" ? `Ready in ${countdown}` : `Recording · ${String(Math.floor(elapsed / 60)).padStart(2,"0")}:${String(elapsed % 60).padStart(2,"0")}`}</div>}
    </div>
    <div className={`camera-position ${positionReady ? "ready" : ""}`} role="status" aria-live="polite"><span className="camera-state-dot"/>{positionReady ? "Required body landmarks are visible — hold the selected camera angle." : cameraLive ? (exercise === "plank" || exercise === "situps" ? "MYLVL needs your shoulder, hip, knee and ankle visible from the side. Adjust the phone to the guide." : "MYLVL cannot see enough of your body yet. Adjust the phone to the guide; you can still start, but detection may be limited.") : <>{exercise === "pushups" && perspective !== "side" ? "Face the camera at the head end; keep your head, shoulders, both arms and hands visible. Aim to include the full body." : "Stand side-on to the camera; keep the required body landmarks visible. For planks, keep your forearm, shoulder, hip, knee and ankle in frame."} Use good light and leave space around you.</>}</div>
    <div className="camera-note"><Shield size={16}/><span>Local recognition is a helpful estimate, not tamper-proof proof or professional form assessment. Maximum analysis time: 90 seconds. Performance metrics may be provided by the model host; video frames stay on your device.</span></div>
    {stage === "recording" && <div className="camera-recording-guidance" role="status" aria-live="polite"><strong>Live analysis active</strong><span>{exercise === "plank" ? (livePlankValid ? "Plank posture is being tracked." : "Adjust to the side-view guide and hold a steady plank.") : repStatus} Detected totals stay hidden until you enter your estimate. Finish the set to compare and confirm; nothing is saved yet.</span></div>}
    <div className={`camera-controls ${stage === "recording" ? "is-recording" : ""}`}>
      {stage === "setup" && <><label>Camera<select value={facing} onChange={(e) => setFacing(e.target.value as "user"|"environment")}><option value="environment">Rear camera</option><option value="user">Front camera</option></select></label><button className="primary-button" disabled={startingCamera} onClick={() => void startCamera()}>{startingCamera ? "Starting camera…" : cameraLive ? "Reload camera" : "Enable camera"}</button>{!startingCamera && cameraLive && runtimeRef.current && <button className="primary-button" onClick={() => { setError(""); setCountdown(3); setStage("countdown"); }}>Start · 3-second countdown</button>}</>}
      {stage === "countdown" && <button className="secondary-button" onClick={() => setStage("setup")}>Cancel countdown</button>}
      {stage === "recording" && <><span>Pose engine: {runtimeStatus} · no video file is created</span><button className="primary-button" onClick={stopSession}>Finish set &amp; analyze</button><button className="secondary-button" onClick={() => { runningRef.current = false; cleanup(); setCameraLive(false); setAnalysis(null); setStage("setup"); }}>Cancel session</button></>}
      {stage === "report" && <><label className="field-label">{exercise === "plank" ? "How many seconds did you hold the plank? Enter your estimate before seeing the detected duration." : "How many repetitions did you complete? Enter your estimate before seeing the detected result."}<input type="number" min={exercise === "plank" ? "0.1" : "1"} max={exercise === "plank" ? "90" : "500"} step={exercise === "plank" ? "0.1" : "1"} inputMode="decimal" value={reported} onChange={(e) => { setReported(e.target.value); setError(""); }} /></label>{error && <div className="camera-warning" role="alert">{error}</div>}<button className="primary-button" disabled={!Number.isFinite(Number(reported)) || Number(reported) <= 0 || Number(reported) > (exercise === "plank" ? 90 : 500) || (exercise !== "plank" && !Number.isSafeInteger(Number(reported)))} onClick={validate}>Compare and validate</button><button className="secondary-button" onClick={() => void retry()}><RotateCcw size={15}/> Retry recording</button></>}
      {stage === "result" && <><div className="camera-result"><b>{exercise === "plank" ? `Detected valid hold ${(plankAnalysis?.validSeconds ?? 0).toFixed(1)} s` : `Detected ${analysis?.repetitions ?? 0} repetitions`} · You reported {reported}{exercise === "plank" ? " s" : ""}</b><span>Pose confidence {Math.round(((exercise === "plank" ? plankAnalysis?.confidence : analysis?.confidence) ?? 0) * 100)}% · usable frames {exercise === "plank" ? plankAnalysis?.usableFrames : analysis?.usableFrames}/{exercise === "plank" ? plankAnalysis?.totalFrames : analysis?.totalFrames}</span><span className={comparison?.status === "accepted" ? "camera-success" : "camera-warning"}>{comparison?.status === "accepted" ? `Validated · ${comparison.deviationPercent?.toFixed(1)}% difference` : `Not validated · ${comparison?.status}${comparison?.deviationPercent == null ? "" : ` · ${comparison.deviationPercent.toFixed(1)}% difference`}`}</span>{(exercise === "plank" ? plankAnalysis?.warnings : analysis?.warnings)?.map((warning) => <small key={warning}>{warning}</small>)}{exercise === "plank" && plankAnalysis && <small>Unvalidated time: {plankAnalysis.invalidSeconds.toFixed(1)} s. Only validated hold time contributes to EXP.</small>}</div>{comparison?.status === "accepted" ? <><div className="camera-result"><b>Estimated reward: {expPreview} EXP</b><span>Server recalculates this using the existing activity rates and daily limits.</span></div><button className="primary-button" disabled={busy || expPreview <= 0} onClick={() => void confirmActivity()}><Check size={16}/> {busy ? "Saving…" : "Confirm activity"}</button></> : <p className="camera-warning">No EXP is awarded. Retry with a clear camera view and a complete movement cycle.</p>}<button className="secondary-button" onClick={() => void retry()}><RotateCcw size={15}/> Retry</button></>}
      {stage === "error" && <><div className="camera-warning" role="alert">{error}</div><button className="primary-button" disabled={startingCamera} onClick={() => void startCamera()}>Retry camera</button></>}
    </div>
    <small className="camera-runtime">Pose runtime: {runtimeStatus}{cameraEpoch ? " · MediaPipe Pose Landmarker Lite" : ""}{error && stage !== "error" ? ` · ${error}` : ""}</small>
    <p className="camera-limits">Supported camera workouts: push-ups, bodyweight squats, sit-ups and forearm planks. Pull-ups remain available through the general activity flow. Exercise variations and form quality are not assessed. Leaving the screen stops the camera and releases resources.</p>
  </section></div>;
}

