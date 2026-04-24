const WebSocket = require("ws");
const path = require("path");
const { DeepgramClient } = require("@deepgram/sdk");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const PORT = 5000;
const wss = new WebSocket.Server({ port: PORT });
const MAX_CHUNK_BYTES = 1024 * 1024; // 1 MB per chunk
let sessionCounter = 0;

wss.on("connection", (ws) => {
  const sessionId = ++sessionCounter;
  let chunkCount = 0;
  let totalBytes = 0;
  console.log(`[session:${sessionId}] Client connected`);
  let deepgramSocket = null;
  let deepgramReady = false;
  let deepgramConnecting = false;
  let latestPartial = "";
  let deepgramConnectFailed = false;
  let deepgramResultsCount = 0;
  let deepgramEmptyResultsCount = 0;

  const sendClientMessage = (payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const openDeepgramStream = async (sampleRate = 48000) => {
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    console.log(`[session:${sessionId}] Opening Deepgram stream @ ${sampleRate}Hz`);
    if (!deepgramApiKey) {
      console.error(`[session:${sessionId}] Missing DEEPGRAM_API_KEY`);
      sendClientMessage({
        type: "error",
        message: "Missing DEEPGRAM_API_KEY in backend environment"
      });
      return;
    }
    if (deepgramSocket || deepgramConnecting) {
      return;
    }

    try {
      deepgramConnecting = true;
      const deepgram = new DeepgramClient({ apiKey: deepgramApiKey });
      deepgramSocket = await deepgram.listen.v1.connect({
        model: "nova-2",
        encoding: "linear16",
        sample_rate: sampleRate,
        channels: 1,
        interim_results: true,
        punctuate: true,
        smart_format: true,
        endpointing: 500,
        utterance_end_ms: "1000",
        vad_events: true
      });
      console.log(`[session:${sessionId}] Deepgram SDK connection created`);
    } catch (err) {
      deepgramConnecting = false;
      deepgramConnectFailed = true;
      console.error(`[session:${sessionId}] Deepgram connect failed:`, err.message);
      sendClientMessage({ type: "error", message: "Deepgram connection failed" });
      return;
    }

    deepgramSocket.on("open", () => {
      deepgramReady = true;
      deepgramConnecting = false;
      deepgramConnectFailed = false;
      console.log(`[session:${sessionId}] Deepgram socket opened`);
      sendClientMessage({ type: "status", message: "Connected to Deepgram" });
    });

    deepgramSocket.on("message", (msg) => {
      try {
        if (msg.type && msg.type !== "Results") {
          console.log(`[session:${sessionId}] Deepgram non-result message: ${msg.type}`);
          return;
        }
        deepgramResultsCount += 1;
        const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim() || "";
        if (!transcript) {
          deepgramEmptyResultsCount += 1;
          if (deepgramEmptyResultsCount <= 5 || deepgramEmptyResultsCount % 20 === 0) {
            const alt = msg.channel?.alternatives?.[0] || {};
            console.log(
              `[session:${sessionId}] Deepgram empty result #${deepgramEmptyResultsCount} ` +
                `speech_final=${msg.speech_final} is_final=${msg.is_final} ` +
                `confidence=${alt.confidence ?? "n/a"} words=${alt.words?.length ?? 0}`
            );
            if (deepgramEmptyResultsCount <= 3) {
              console.log(
                `[session:${sessionId}] Empty result payload sample:`,
                JSON.stringify(
                  {
                    type: msg.type,
                    is_final: msg.is_final,
                    speech_final: msg.speech_final,
                    start: msg.start,
                    duration: msg.duration,
                    channel_index: msg.channel_index,
                    alternatives_count: msg.channel?.alternatives?.length ?? 0
                  },
                  null,
                  2
                )
              );
            }
          }
          return;
        }
        if (msg.is_final) {
          latestPartial = "";
          console.log(`[session:${sessionId}] Deepgram FINAL: "${transcript}"`);
          sendClientMessage({ type: "transcript", text: transcript, isFinal: true });
          return;
        }
        latestPartial = transcript;
        if (deepgramResultsCount <= 5 || deepgramResultsCount % 15 === 0) {
          console.log(`[session:${sessionId}] Deepgram PARTIAL: "${latestPartial}"`);
        }
        sendClientMessage({ type: "transcript", text: latestPartial, isFinal: false });
      } catch (err) {
        console.error(`[session:${sessionId}] Failed to parse Deepgram message:`, err.message);
      }
    });

    deepgramSocket.on("SpeechStarted", () => {
      console.log(`[session:${sessionId}] Deepgram event: SpeechStarted`);
    });

    deepgramSocket.on("UtteranceEnd", () => {
      console.log(`[session:${sessionId}] Deepgram event: UtteranceEnd`);
    });

    deepgramSocket.on("error", (err) => {
      console.error(`[session:${sessionId}] Deepgram socket error:`, err.message);
      const isUnauthorized = err.message?.includes("401");
      deepgramConnecting = false;
      deepgramConnectFailed = true;
      sendClientMessage({
        type: "error",
        message: isUnauthorized
          ? "Deepgram unauthorized (401): check DEEPGRAM_API_KEY"
          : "Deepgram connection error"
      });
    });

    deepgramSocket.on("close", (code, reason) => {
      deepgramReady = false;
      deepgramConnecting = false;
      deepgramSocket = null;
      console.log(
        `[session:${sessionId}] Deepgram socket closed code=${code} reason=${reason?.toString() || ""}`
      );
    });

    deepgramSocket.on("Warning", (warning) => {
      console.warn(`[session:${sessionId}] Deepgram warning:`, warning);
    });

    deepgramSocket.on("Metadata", (metadata) => {
      console.log(
        `[session:${sessionId}] Deepgram metadata request_id=${metadata?.request_id || "n/a"}`
      );
    });

    if (typeof deepgramSocket.connect === "function") {
      deepgramSocket.connect();
    }
    if (typeof deepgramSocket.waitForOpen === "function") {
      await deepgramSocket.waitForOpen();
    }
  };

  const closeDeepgramStream = () => {
    if (!deepgramSocket) {
      return;
    }
    if (deepgramReady) {
      if (typeof deepgramSocket.sendFinalize === "function") {
        deepgramSocket.sendFinalize();
      }
      if (typeof deepgramSocket.sendCloseStream === "function") {
        deepgramSocket.sendCloseStream();
      }
    }
    if (typeof deepgramSocket.close === "function") {
      deepgramSocket.close();
    }
    deepgramSocket = null;
    deepgramReady = false;
  };

  ws.on("message", (payload, isBinary) => {
    if (!isBinary) {
      try {
        const control = JSON.parse(payload.toString());
        console.log(`[session:${sessionId}] Control message:`, control);
        if (control.type === "start") {
          deepgramConnectFailed = false;
          openDeepgramStream(control.sampleRate);
        } else if (control.type === "stop") {
          closeDeepgramStream();
        }
      } catch (err) {
        console.warn("Invalid client control message:", err.message);
      }
      return;
    }

    const audioChunk = payload;
    const byteLength = Buffer.isBuffer(audioChunk)
      ? audioChunk.length
      : Buffer.byteLength(String(audioChunk));

    if (byteLength > MAX_CHUNK_BYTES) {
      console.warn(`Rejected large chunk (${byteLength} bytes)`);
      ws.close(1009, "Payload too large");
      return;
    }

    chunkCount += 1;
    totalBytes += byteLength;
    if (chunkCount <= 3 || chunkCount % 20 === 0) {
      console.log(
        `[session:${sessionId}] Received chunk #${chunkCount} size=${byteLength} total=${totalBytes}`
      );
    }
    if (!deepgramSocket && !deepgramConnectFailed) {
      openDeepgramStream();
    }
    if (deepgramReady) {
      deepgramSocket.sendMedia(audioChunk);
    } else if (chunkCount <= 3 || chunkCount % 20 === 0) {
      console.log(
        `[session:${sessionId}] Chunk buffered/discarded: deepgramReady=${deepgramReady}`
      );
    }
  });

  ws.on("error", (err) => {
    console.error("Client socket error:", err.message);
  });

  ws.on("close", () => {
    closeDeepgramStream();
    console.log(
      `[session:${sessionId}] Client disconnected chunks=${chunkCount} bytes=${totalBytes}`
    );
  });
});

wss.on("error", (err) => {
  console.error("WebSocket server error:", err.message);
});

const shutdown = () => {
  console.log("Shutting down server...");
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1001, "Server shutting down");
    }
  });
  wss.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`WebSocket backend running on ws://localhost:${PORT}`);