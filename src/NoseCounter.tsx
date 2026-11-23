import { useEffect, useRef, useState } from "react";
import { Check, RotateCcw, Undo2, X, Zap } from "lucide-react";
import type { Activity } from "./domain";

type NoseCounterProps = {
  onClose(): void;
  onSave(activity: Activity): Promise<boolean> | boolean;
};
type CounterStage = "ready" | "counting" | "review";

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

/** Camera-free, explicitly self-reported push-up counter. */
export function NoseCounter({ onClose, onSave }: NoseCounterProps) {
  const [stage, setStage] = useState<CounterStage>("ready");
  const [count, setCount] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const lastTap = useRef(0);

  useEffect(() => {
    if (stage !== "counting" || startedAt === null) return;
    const update = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [stage, startedAt]);

  const start = () => {
    setStartedAt(Date.now());
    setElapsedSeconds(0);
    setCount(0);
    setError("");
    setStage("counting");
  };

  const tap = () => {
    const now = Date.now();
    if (now - lastTap.current < 220 || count >= 500) return;
    lastTap.current = now;
    setCount((current) => Math.min(500, current + 1));
    if ("vibrate" in navigator) navigator.vibrate?.(12);
  };

  const save = async () => {
    if (!startedAt || count < 1 || saving) return;
    setSaving(true);
    setError("");
    const id = crypto.randomUUID();
    const duration = Math.max(1, Math.ceil((Date.now() - startedAt) / 60_000));
    const activity: Activity = {
      id,
      type: "Push-ups",
      date: new Date(startedAt).toISOString(),
      duration: Math.min(180, duration),
      reps: count,
      notes: "Self-reported with Nose counter.",
      xp: 0,
      source: "nose_counter",
      sourceKey: id,
      validationStatus: "user_confirmed",
    };
    try {
      const saved = await onSave(activity);
      if (!saved) setError("Could not save this set. Check your connection and try again.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save this set.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim camera-scrim">
      <section className="activity-modal nose-counter-modal" role="dialog" aria-modal="true" aria-labelledby="nose-counter-title">
        <div className="modal-head">
          <div>
            <div className="eyebrow">PUSH-UPS · NO CAMERA</div>
            <h2 id="nose-counter-title">Nose counter</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <p className="nose-counter-copy">
          {stage === "ready"
            ? "Place your phone safely on the floor. After each complete push-up, tap the large button once with your nose."
            : stage === "counting"
              ? "One nose tap equals one self-reported push-up. Tap once after each full repetition."
              : "Review your self-reported set before saving it."}
        </p>
        <div className="nose-counter-status" role="status">
          {stage === "ready"
            ? "No camera or video is used. EXP is calculated by MYLVL when you save."
            : stage === "counting"
              ? `Set in progress · ${formatElapsed(elapsedSeconds)}`
              : "Ready to save · self-reported count"}
        </div>
        <div className="nose-counter-reading" aria-live="polite">
          <strong>{count}</strong>
          <span>{stage === "review" ? "push-ups to save" : "push-ups counted"}</span>
        </div>
        {stage === "ready" && (
          <button type="button" className="primary-button modal-submit" onClick={start}>Start set</button>
        )}
        {stage === "counting" && (
          <>
            <button type="button" className="nose-counter-push" onClick={tap} aria-label="Count one push-up">PUSH-UP +1</button>
            <div className="nose-counter-actions">
              <button type="button" className="secondary-button" onClick={() => setCount((current) => Math.max(0, current - 1))} disabled={count === 0}>
                <Undo2 size={16} /> Undo tap
              </button>
              <button type="button" className="secondary-button" onClick={() => setStage("review")} disabled={count === 0}>Finish set</button>
            </div>
            <button type="button" className="secondary-button modal-submit" onClick={() => { setCount(0); setStartedAt(Date.now()); setElapsedSeconds(0); lastTap.current = 0; }}>
              <RotateCcw size={15} /> Reset count
            </button>
          </>
        )}
        {stage === "review" && (
          <>
            <div className="nose-counter-status"><b>{count} push-ups</b> · {formatElapsed(elapsedSeconds)} · self-reported</div>
            <button type="button" className="primary-button modal-submit" onClick={() => void save()} disabled={saving}>
              <Check size={16} /> {saving ? "Saving…" : "Confirm and save set"}
            </button>
            <button type="button" className="secondary-button modal-submit" onClick={() => setStage("counting")} disabled={saving}>Continue counting</button>
          </>
        )}
        {error && <p className="nose-counter-error" role="alert">{error}</p>}
        <div className="modal-reward">
          <div className="reward-icon"><Zap size={17} fill="currentColor" /></div>
          <span><b>EXP rules</b><small>Existing push-up rate and daily limit apply. No bonus for the counting method.</small></span>
        </div>
      </section>
    </div>
  );
}
