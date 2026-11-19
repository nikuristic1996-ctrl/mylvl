# MYLVL Phase 6: Camera exercise recognition

## Runtime and privacy

- The camera screen lazy-loads MediaPipe Tasks Vision **1.2.3** and the Pose Landmarker Lite float16 model only after the signed-in user opens the camera flow.
- Camera video is consumed as a live `HTMLVideoElement` by the browser runtime. MYLVL does not create a recording file, upload frames, or store video in Supabase.
- Capture requests 640×480 video at up to 15 fps; pose inference runs at about 5.5 fps. Recording is limited to 90 seconds. Camera tracks and the model runtime are closed at stop, cancel, screen exit, camera interruption, or when the PWA enters the background.
- The model and its WASM runtime load from jsDelivr/Google-hosted model assets. An initial network connection is required; the model is not guaranteed to be available offline after the PWA has been installed.
- Video stays on the device. The model provider's privacy notice describes performance/usage metrics; MYLVL does not pass it account credentials or activity payloads.

## Counting rules

- Only standard side-view bodyweight push-ups and squats are included. Push-ups use shoulder/elbow/wrist angle plus shoulder-hip-ankle alignment. Squats use hip-knee-ankle angle.
- A three-frame median filter, visibility checks, ready/bottom thresholds, hysteresis, a 50-degree movement range, and a 500 ms minimum cycle time reduce jitter and partial-cycle counts. A cycle times out after 12 seconds.
- Initial thresholds are code constants in `src/poseRecognition.ts` and the model version is recorded with each award. These are movement-counting heuristics, not medical or professional form assessment.
- Low usable-frame ratio, fewer than 12 usable frames, confidence below 0.75, no complete repetitions, or user/detected count difference over 10% prevents EXP.
- Count difference uses the user-reported count as the denominator. The user enters their count before the detected total is revealed. The detected count, not the user's count, is the value used by the shared Phase 1 EXP engine.

## Server and trust

- The authenticated Edge Function checks camera metadata and session UUID, recomputes count agreement, and reserves the activity using a service-role-only RPC. The existing finalizer and EXP engine remain responsible for XP, daily caps, idempotency, permanent progression, and seasonal progression.
- No camera frames or arbitrary XP values reach the server. A repeated request/session ID cannot create another activity award.
- Local browser inference is not tamper-proof. A modified client can fabricate counts, confidence, or version metadata. The database/Edge Function can validate consistency and access, but cannot independently prove that the movement happened without uploading or reprocessing video.

## Compatibility and verification

Camera use requires HTTPS, browser camera permission, WebAssembly support, and access to the model host. The UI uses standard `getUserMedia` and is designed for current Android Chrome/PWA and desktop browsers. Actual Android camera/model execution still requires a real device smoke test; synthetic tests do not prove camera accuracy.


