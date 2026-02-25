/**
 * Inbound Voice Agent - Agri-Agents
 * Uses Twilio Media Streams for raw audio (blob) capture.
 *
 * Run: node voice-server.js
 * For local dev: run ngrok and set BASE_URL in .env
 * Configure Twilio Voice webhook to: {BASE_URL}/voice/incoming
 *
 * Raw audio: mulaw, 8kHz, 1 channel (base64 in Media messages)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const VoiceResponse = require("twilio").twiml.VoiceResponse;
const alawmulaw = require("alawmulaw");

const RAW_AUDIO_DIR = path.join(__dirname, "raw-recordings");
fs.mkdirSync(RAW_AUDIO_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", 1);

/** Convert mulaw buffer (8kHz mono) to WAV buffer (playable) */
function mulawToWav(mulawBuffer) {
  const mulawArray = new Uint8Array(mulawBuffer);
  const pcmSamples = alawmulaw.mulaw.decode(mulawArray);
  const numSamples = pcmSamples.length;
  const dataSize = numSamples * 2;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;
  const buffer = Buffer.alloc(fileSize);
  let offset = 0;

  buffer.write("RIFF", offset); offset += 4;
  buffer.writeUInt32LE(fileSize - 8, offset); offset += 4;
  buffer.write("WAVE", offset); offset += 4;
  buffer.write("fmt ", offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4;
  buffer.writeUInt16LE(1, offset); offset += 2;
  buffer.writeUInt16LE(1, offset); offset += 2;
  buffer.writeUInt32LE(8000, offset); offset += 4;
  buffer.writeUInt32LE(16000, offset); offset += 4;
  buffer.writeUInt16LE(2, offset); offset += 2;
  buffer.writeUInt16LE(16, offset); offset += 2;
  buffer.write("data", offset); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;

  for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(pcmSamples[i], offset);
    offset += 2;
  }
  return buffer;
}

const getBaseUrl = (req) => {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (req) {
    const proto = req.protocol || "https";
    const host = req.get("host") || req.get("x-forwarded-host");
    if (host) return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
};

/**
 * POST /voice/incoming
 * Returns TwiML: Start Media Stream + Say + Pause (user speaks) + Say + Hangup
 * Raw audio streams to WebSocket at /voice/stream
 */
app.post("/voice/incoming", (req, res) => {
  const baseUrl = getBaseUrl(req);
  // Fix: https -> wss (not wsss). Replace full protocol.
  const wssUrl = baseUrl.replace(/^https?/, "wss") + "/voice/stream";

  console.log("\n📞 Incoming call from:", req.body.Caller || "unknown");
  console.log("   Base URL:", baseUrl);
  console.log("   Media Stream URL:", wssUrl);
  console.log("   (Twilio will connect to this WebSocket for raw audio)\n");

  const twiml = new VoiceResponse();

  // Start unidirectional stream - we receive inbound audio (caller's voice)
  const start = twiml.start();
  start.stream({
    url: wssUrl,
    track: "inbound_track",
  });

  twiml.say(
    { voice: "alice", language: "en-IN" },
    "Welcome to Agri Agents. Please tell me your question now."
  );
  twiml.pause({ length: 30 });
  twiml.say({ voice: "alice" }, "Thank you for calling. Goodbye.");
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// Create HTTP server (required for WebSocket)
const server = http.createServer(app);

// WebSocket server for Media Streams
const wss = new WebSocketServer({ server, path: "/voice/stream" });

wss.on("connection", (ws, req) => {
  console.log("   📡 WebSocket client connected from:", req.headers.origin || req.socket.remoteAddress);
  const chunks = [];
  let callSid = "";
  let mediaCount = 0;

  ws.on("error", (err) => {
    console.error("   ❌ WebSocket error:", err.message);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          console.log("   🔗 Media Stream: WebSocket connected");
          break;

        case "start":
          callSid = msg.start?.callSid || "unknown";
          console.log("   ▶️  Media Stream started, Call SID:", callSid);
          console.log("   📦 Receiving raw audio chunks (mulaw 8kHz)...");
          break;

        case "media":
          if (msg.media?.payload) {
            const rawBuffer = Buffer.from(msg.media.payload, "base64");
            chunks.push(rawBuffer);
            mediaCount++;
            if (mediaCount % 50 === 0) console.log("   📦 Received", mediaCount, "audio chunks...");
          }
          break;

        case "stop":
          const totalSize = chunks.reduce((s, c) => s + c.length, 0);
          const mulawBuffer = Buffer.concat(chunks);
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const baseName = `${timestamp}_${callSid || "unknown"}`;
          const wavPath = path.join(RAW_AUDIO_DIR, `${baseName}.wav`);
          try {
            const wavBuffer = mulawToWav(mulawBuffer);
            fs.writeFileSync(wavPath, wavBuffer);
            console.log("\n   ⏹️  Media Stream stopped");
            console.log("   📦 Total chunks:", mediaCount, "| Raw:", totalSize, "bytes (mulaw)");
            console.log("   💾 Saved WAV:", wavPath);
          } catch (writeErr) {
            console.error("   ❌ Failed to save file:", writeErr.message);
          }
          break;
        default:
          console.log("   📨 WebSocket event:", msg.event);
          break;
      }
    } catch (err) {
      console.error("   ⚠️ WebSocket message error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("   🔌 WebSocket closed");
  });
});

// Health check
app.get("/", (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.send(
    `Agri-Agents Voice Server (Media Streams). Webhook: ${baseUrl}/voice/incoming`
  );
});

server.listen(PORT, () => {
  console.log(`Voice server running on port ${PORT}`);
  console.log(`Local URL: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/voice/stream`);
  console.log(`\nUse ngrok (wss) + set Twilio Voice webhook to: {ngrok-url}/voice/incoming`);
});
