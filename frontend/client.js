const toggleBtn = document.getElementById("toggleBtn");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const transcriptEl = document.getElementById("transcript");

let isStreaming = false;
let socket = null;
let stream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let finalTranscript = "";
let partialTranscript = "";
let lastPartialSentAt = 0;
let sentChunkCount = 0;
let sentTotalBytes = 0;

const DEEPGRAM_BACKEND_WS_URL = "ws://localhost:5000";

function connectWebSocket(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = window.setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout connecting to ${url}`));
    }, timeoutMs);

    ws.onopen = () => {
      window.clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error(`Failed to connect to ${url}`));
    };
  });
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setError(text) {
  errorEl.textContent = text || "";
}

function renderTranscript() {
  const text = `${finalTranscript}${partialTranscript ? ` ${partialTranscript}` : ""}`.trim();
  transcriptEl.textContent = text || "Transcript will appear here...";
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function handleServerMessage(rawMessage) {
  try {
    const msg = JSON.parse(rawMessage.data);
    if (msg.type === "transcript" || msg.type === "partial" || msg.type === "final") {
      const isFinal = msg.isFinal === true || msg.type === "final";
      if (isFinal) {
        finalTranscript = `${finalTranscript} ${msg.text}`.trim();
        partialTranscript = "";
        setStatus("Receiving final transcript");
        console.log("[frontend] FINAL transcript:", msg.text);
      } else {
        partialTranscript = msg.text;
        setStatus(`Listening... ${partialTranscript}`);
        console.log("[frontend] PARTIAL transcript:", msg.text);
      }
      renderTranscript();
      return;
    }
    if (msg.type === "error") {
      console.error("[frontend] Engine error:", msg.message);
      setError(msg.message || "Server transcription error");
      return;
    }
    if (msg.type === "status") {
      console.log("[frontend] Engine status:", msg.message);
      setStatus(msg.message || "Connected");
    }
  } catch (err) {
    console.log("[frontend] Non-JSON WS message:", rawMessage.data);
  }
}

function floatTo16BitPCM(float32Array) {
  const pcm = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

async function cleanupAudio() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
}

function cleanupSocket() {
  if (socket) {
    socket.close();
    socket = null;
  }
}

async function stopStreaming() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "stop" }));
  }
  console.log(
    `[frontend] Stream stopped. sentChunks=${sentChunkCount}, sentBytes=${sentTotalBytes}`
  );
  await cleanupAudio();
  cleanupSocket();
  isStreaming = false;
  toggleBtn.textContent = "Start Live Stream";
  toggleBtn.classList.remove("stop");
  toggleBtn.classList.add("start");
  setStatus("Idle");
}

async function startStreaming() {
  setError("");
  sentChunkCount = 0;
  sentTotalBytes = 0;
  finalTranscript = "";
  partialTranscript = "";
  renderTranscript();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setStatus(`Connecting to deepgram (${DEEPGRAM_BACKEND_WS_URL})...`);
    socket = await connectWebSocket(DEEPGRAM_BACKEND_WS_URL);
    console.log("[frontend] Connected to engine=deepgram");

    socket.onmessage = handleServerMessage;
    socket.onerror = () => {
      console.error("[frontend] WebSocket error (engine=deepgram)");
      setError("WebSocket connection error (deepgram)");
    };
    socket.onclose = () => {
      console.log("[frontend] WebSocket closed (engine=deepgram)");
      if (isStreaming) {
        stopStreaming();
      } else {
        setStatus("Disconnected from deepgram");
      }
    };

    const startAudioPipeline = () => {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive"
      });
      const sampleRate = audioContext.sampleRate;
      socket.send(JSON.stringify({ type: "start", sampleRate }));

      sourceNode = audioContext.createMediaStreamSource(stream);
      // Slightly larger frame improves transcript stability for Deepgram.
      processorNode = audioContext.createScriptProcessor(2048, 1, 1);

      processorNode.onaudioprocess = (event) => {
        const now = Date.now();
        if (now - lastPartialSentAt < 20) {
          return;
        }
        lastPartialSentAt = now;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = floatTo16BitPCM(input);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(pcm.buffer);
          sentChunkCount += 1;
          sentTotalBytes += pcm.byteLength;
          if (sentChunkCount <= 3 || sentChunkCount % 20 === 0) {
            console.log(
              `[frontend] Sent chunk #${sentChunkCount} bytes=${pcm.byteLength} total=${sentTotalBytes}`
            );
          }
        }
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      isStreaming = true;
      toggleBtn.textContent = "Stop Live Stream";
      toggleBtn.classList.remove("start");
      toggleBtn.classList.add("stop");
      setStatus("Streaming live (deepgram)...");
    };

    if (socket.readyState === WebSocket.OPEN) {
      startAudioPipeline();
    } else {
      socket.onopen = startAudioPipeline;
    }
  } catch (err) {
    setError(err.message || "Could not access microphone");
    await stopStreaming();
  }
}

toggleBtn.addEventListener("click", async () => {
  if (isStreaming) {
    await stopStreaming();
  } else {
    await startStreaming();
  }
});

window.addEventListener("beforeunload", () => {
  stopStreaming();
});
