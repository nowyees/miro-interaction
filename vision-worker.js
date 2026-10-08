let face, hands, engine, recognition, lastTimestamp = -1, frameCount = 0, lastFace = { present: false, attentive: false };

async function create(Task, files, options) {
  // GPU is much faster; fall back to CPU where WebGL isn't available in workers.
  for (const delegate of ['GPU', 'CPU']) {
    try { return await Task.createFromOptions(files, { ...options, baseOptions: { ...options.baseOptions, delegate } }); }
    catch (error) { if (delegate === 'CPU') throw error; }
  }
}

onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const [{ FilesetResolver, FaceLandmarker, GestureRecognizer }, rec] = await Promise.all([
        import('./vendor/vision_bundle.mjs'), import('./recognition.js?v=11')
      ]);
      recognition = rec;
      const base = new URL('.', self.location.href);
      const files = await FilesetResolver.forVisionTasks(new URL('vendor/wasm', base).href);
      face = await create(FaceLandmarker, files, {
        baseOptions: { modelAssetPath: new URL('models/face_landmarker.task', base).href },
        runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4
      });
      hands = await create(GestureRecognizer, files, {
        baseOptions: { modelAssetPath: new URL('models/gesture_recognizer.task', base).href },
        runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.35
      });
      engine = new rec.GestureEngine();
      postMessage({ type: 'ready' });
    } catch (error) { postMessage({ type: 'error', message: String(error.message || error) }); }
  } else if (data.type === 'reset') engine?.reset();
  else if (data.type === 'frame') {
    const { frame, at } = data;
    try {
      if (!face || !hands || at <= lastTimestamp) return;
      lastTimestamp = at;
      const aspect = frame.width / frame.height;
      // The face changes slowly; checking it every other frame keeps hands fast.
      if (frameCount++ % 2 === 0) {
        const f = face.detectForVideo(frame, at).faceLandmarks[0];
        lastFace = { present: !!f, attentive: recognition.isAttentive(f && recognition.toScreen(f, aspect)) };
      }
      const h = hands.recognizeForVideo(frame, at);
      const list = h.landmarks.map((p, i) => ({ points: recognition.toScreen(p, aspect), categories: h.gestures[i] || [] }));
      const { gesture, poses } = engine.update(list, at);
      postMessage({
        type: 'result', at, gesture, poses, ...lastFace,
        // Hands raised in front of the face still mean someone is there.
        present: lastFace.present || list.length > 0,
        // Raw normalized points for the optional debug overlay.
        hands: h.landmarks.map(p => p.map(v => [v.x, v.y])),
        labels: h.gestures.map(g => g[0] ? `${g[0].categoryName} ${g[0].score.toFixed(2)}` : '')
      });
    } catch (error) { postMessage({ type: 'frame-error', message: String(error.message || error) }); }
    finally { frame.close(); postMessage({ type: 'frame-done' }); }
  }
};
