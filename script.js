/* Prototype Attention - Classe (30s)
   - 8 trials in 30 seconds
   - Two-choice auditory cue: PLUS vs MOINS
   - Visual distractor at 9s (student turns): overlay image
   - Auditory distractor at 21s (horn.mp3 if provided, else beep fallback)
   - Logs per trial + export CSV
*/

const CONFIG = {
  durationMs: 30000,
  trials: [
    // times relative to start (ms). We'll cue at t, response window until next cue or end.
    { t: 3000,  label: "PLUS",  correct: "+" },
    { t: 6000,  label: "MOINS", correct: "-" },
    { t: 10000, label: "PLUS",  correct: "+" },   // after distractor 1
    { t: 13000, label: "MOINS", correct: "-" },
    { t: 16000, label: "PLUS",  correct: "+" },
    { t: 22000, label: "MOINS", correct: "-" },   // after distractor 2
    { t: 25000, label: "PLUS",  correct: "+" },
    { t: 28000, label: "MOINS", correct: "-" },
  ],
  distractors: [
    { t: 9000,  type: "visual_student_turn", durationMs: 1500 },
    { t: 21000, type: "audio_horn",          durationMs: 1000 },
  ],
  useSpeechSynthesis: true,     // says "plus" / "moins" (French). Can disable if device behaves oddly.
  speechLang: "fr-FR",
  showCueTextMs: 800,           // show cue in bubble
  minInterTapMs: 120,           // basic debounce for accidental double taps
};

const els = {
  status: document.getElementById("status"),
  timer: document.getElementById("timer"),
  cueLabel: document.getElementById("cueLabel"),
  cueSub: document.getElementById("cueSub"),
  btnPlus: document.getElementById("btnPlus"),
  btnMinus: document.getElementById("btnMinus"),
  startBtn: document.getElementById("startBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  resetBtn: document.getElementById("resetBtn"),
  distractorImg: document.getElementById("distractorImg"),
  bgVideo: document.getElementById("bgVideo"),
  debug: document.getElementById("debug"),
};

let state = {
  running: false,
  startPerf: 0,
  rafId: null,
  timeouts: [],
  currentTrialIndex: -1,
  currentTrialOpenPerf: null,  // perf time when cue presented
  lastTapPerf: 0,
  logs: [],                    // per response
  trialMeta: [],               // per trial (cue times, etc)
  hornAudio: null,
};

function nowPerf() {
  return performance.now();
}

function fmtSeconds(ms) {
  const s = ms / 1000;
  return s.toFixed(1).padStart(4, "0") + "s";
}

function setStatus(txt) {
  els.status.textContent = txt;
}

function setCue(main, sub="") {
  els.cueLabel.textContent = main;
  els.cueSub.textContent = sub;
}

function clearScheduled() {
  for (const id of state.timeouts) clearTimeout(id);
  state.timeouts = [];
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
}

function schedule(fn, delayMs) {
  const id = setTimeout(fn, delayMs);
  state.timeouts.push(id);
}

function safePlayVideo() {
  // On mobile, autoplay may be blocked; user interaction on Start helps.
  if (!els.bgVideo) return;
  els.bgVideo.muted = true;
  const p = els.bgVideo.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
}

function initAudio() {
  // Optional horn.mp3
  state.hornAudio = new Audio("media/horn.mp3");
  state.hornAudio.preload = "auto";
  // Don't crash if missing; we'll fallback to beep.
  state.hornAudio.addEventListener("error", () => {
    state.hornAudio = null;
  });
}

function speak(text) {
  if (!CONFIG.useSpeechSynthesis) return;
  if (!("speechSynthesis" in window)) return;

  // Cancel queued speech to keep timing tidy
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = CONFIG.speechLang;
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

function beepFallback(durationMs = 120, freq = 880) {
  // Very small fallback for distractor if horn file missing.
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, durationMs);
  } catch {
    // ignore
  }
}

function showDistractorStudent(durationMs) {
  // If image missing, it will just not show; still logs event timing.
  els.distractorImg.style.opacity = "1";
  els.distractorImg.style.transform = "scale(1.02)";
  schedule(() => {
    els.distractorImg.style.opacity = "0";
    els.distractorImg.style.transform = "scale(0.98)";
  }, durationMs);
}

function playHorn(durationMs) {
  if (state.hornAudio) {
    try {
      state.hornAudio.currentTime = 0;
      state.hornAudio.play().catch(() => beepFallback(durationMs, 660));
    } catch {
      beepFallback(durationMs, 660);
    }
  } else {
    beepFallback(durationMs, 660);
  }
}

function markTrialPresented(trialIndex, tRelMs, perfWhen) {
  state.trialMeta[trialIndex] = {
    trialIndex,
    cueLabel: CONFIG.trials[trialIndex].label,
    correct: CONFIG.trials[trialIndex].correct,
    cueTimeRelMs: tRelMs,
    cueTimePerf: perfWhen,
    response: null,
  };
}

function openTrial(trialIndex) {
  state.currentTrialIndex = trialIndex;
  state.currentTrialOpenPerf = nowPerf();
  const trial = CONFIG.trials[trialIndex];

  // Visual cue (subtitle in bubble)
  setCue(`Consigne : ${trial.label}`, "Répondez avec les boutons + / −");

  // Audio cue via speech synthesis (PLUS/MOINS)
  speak(trial.label.toLowerCase());

  // Auto-clear cue text after a short time
  schedule(() => {
    // Keep bubble present but less intrusive
    setCue("Continuez…", "");
  }, CONFIG.showCueTextMs);

  markTrialPresented(trialIndex, trial.t, state.currentTrialOpenPerf);
}

function handleResponse(choice) {
  if (!state.running) return;
  const tPerf = nowPerf();

  // Debounce
  if (tPerf - state.lastTapPerf < CONFIG.minInterTapMs) return;
  state.lastTapPerf = tPerf;

  const idx = state.currentTrialIndex;
  if (idx < 0) return; // no trial yet

  const trial = CONFIG.trials[idx];
  const meta = state.trialMeta[idx];
  if (!meta) return;

  // Only first response per trial counts
  if (meta.response) return;

  const rtMs = tPerf - meta.cueTimePerf;
  const correct = (choice === trial.correct) ? 1 : 0;

  meta.response = {
    choice,
    rtMs: Math.round(rtMs),
    correct,
    responseTimePerf: tPerf,
  };

  state.logs.push({
    trialIndex: idx,
    cueLabel: trial.label,
    correctAnswer: trial.correct,
    choice,
    correct,
    rtMs: Math.round(rtMs),
    cueTimeRelMs: trial.t,
    distractorWindow: classifyDistractorWindow(trial.t),
  });

  // Small feedback (optional): quick flash on chosen button
  flashButton(choice === "+" ? els.btnPlus : els.btnMinus, correct);

  // If you want: you could also speak "oui/non" — I’d avoid for now.
}

function flashButton(btn, isCorrect) {
  const old = btn.style.boxShadow;
  btn.style.boxShadow = isCorrect
    ? "0 0 0 6px rgba(0,255,0,0.35), 0 12px 28px rgba(0,0,0,0.35)"
    : "0 0 0 6px rgba(255,0,0,0.35), 0 12px 28px rgba(0,0,0,0.35)";
  schedule(() => {
    btn.style.boxShadow = old || "";
  }, 160);
}

function classifyDistractorWindow(trialCueRelMs) {
  // Simple labeling: was the cue just after a distractor?
  // You can refine later (e.g., within 1200ms after distractor onset).
  for (const d of CONFIG.distractors) {
    const delta = trialCueRelMs - d.t;
    if (delta >= 0 && delta <= 1500) {
      return `post_${d.type}`;
    }
  }
  return "baseline";
}

function exportCSV() {
  // Merge trials to include omissions explicitly
  const rows = [];
  rows.push([
    "trialIndex",
    "cueLabel",
    "correctAnswer",
    "choice",
    "correct",
    "rtMs",
    "cueTimeRelMs",
    "distractorWindow",
    "omission"
  ].join(","));

  for (let i = 0; i < CONFIG.trials.length; i++) {
    const meta = state.trialMeta[i];
    const hasResp = meta && meta.response;
    const log = state.logs.find(r => r.trialIndex === i);

    if (log) {
      rows.push([
        log.trialIndex,
        log.cueLabel,
        log.correctAnswer,
        log.choice,
        log.correct,
        log.rtMs,
        log.cueTimeRelMs,
        log.distractorWindow,
        0
      ].join(","));
    } else {
      // omission
      rows.push([
        i,
        CONFIG.trials[i].label,
        CONFIG.trials[i].correct,
        "",
        "",
        "",
        CONFIG.trials[i].t,
        classifyDistractorWindow(CONFIG.trials[i].t),
        1
      ].join(","));
    }
  }

  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `attention_prototype_${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function updateTimer() {
  if (!state.running) return;
  const elapsed = nowPerf() - state.startPerf;
  els.timer.textContent = fmtSeconds(elapsed);
  if (elapsed < CONFIG.durationMs) {
    state.rafId = requestAnimationFrame(updateTimer);
  }
}

function startRun() {
  if (state.running) return;

  // Reset run state
  clearScheduled();
  state.logs = [];
  state.trialMeta = [];
  state.currentTrialIndex = -1;
  state.currentTrialOpenPerf = null;

  state.running = true;
  setStatus("En cours");
  setCue("Regardez la maîtresse…", "Répondez vite et juste (+ / −).");
  els.downloadBtn.disabled = true;
  els.resetBtn.disabled = false;

  safePlayVideo();

  // start time (after user interaction)
  state.startPerf = nowPerf();

  // Schedule distractors
  for (const d of CONFIG.distractors) {
    schedule(() => {
      if (!state.running) return;
      if (d.type === "visual_student_turn") showDistractorStudent(d.durationMs);
      if (d.type === "audio_horn") playHorn(d.durationMs);
    }, d.t);
  }

  // Schedule trials
  CONFIG.trials.forEach((trial, idx) => {
    schedule(() => {
      if (!state.running) return;
      openTrial(idx);
    }, trial.t);
  });

  // End
  schedule(() => stopRun(), CONFIG.durationMs);

  // Timer UI
  els.timer.textContent = "00.0s";
  updateTimer();
}

function stopRun() {
  if (!state.running) return;
  state.running = false;
  clearScheduled();

  setStatus("Terminé");
  setCue("Terminé.", "Téléchargez le CSV.");
  els.downloadBtn.disabled = false;
  els.resetBtn.disabled = false;

  // Cancel any speech still queued
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function resetAll() {
  clearScheduled();
  state.running = false;
  state.logs = [];
  state.trialMeta = [];
  state.currentTrialIndex = -1;
  state.currentTrialOpenPerf = null;

  setStatus("Prêt");
  els.timer.textContent = "00.0s";
  setCue("Appuie sur + quand j'ai dit PLUS, et sur − quand j'ai dit MOINS.", "Touchez l'écran pour démarrer.");
  els.downloadBtn.disabled = true;
  els.resetBtn.disabled = true;
}

function bindUI() {
  els.btnPlus.addEventListener("click", () => handleResponse("+"));
  els.btnMinus.addEventListener("click", () => handleResponse("-"));

  els.startBtn.addEventListener("click", startRun);
  els.downloadBtn.addEventListener("click", exportCSV);
  els.resetBtn.addEventListener("click", resetAll);

  // Tap anywhere to start (useful on tablet)
  document.body.addEventListener("click", (e) => {
    // avoid double-trigger if clicking buttons
    if (e.target === els.startBtn || e.target === els.downloadBtn || e.target === els.resetBtn) return;
  });

  // If video missing, avoid ugly error—video tag will just show black background.
}

(function main() {
  initAudio();
  bindUI();
  resetAll();
})();
