const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { mulawToWav } = require("../Utils/Utility");
const { randomUUID } = require("crypto");

const RAW_AUDIO_DIR = path.join(process.cwd(), "raw-recordings");
fs.mkdirSync(RAW_AUDIO_DIR, { recursive: true });

function createConnectionState() {
    return {
        connectionId: randomUUID(),
        callSid: "unknown",
        mediaCount: 0,
        totalBytes: 0,
        stopped: false,
        baseName: "",
        rawPath: "",
        wavPath: "",
        rawStream: null,
    };
}

function ensureRawStream(state) {
    if (state.rawStream) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    state.baseName = `${timestamp}_${state.callSid || state.connectionId}`;
    state.rawPath = path.join(RAW_AUDIO_DIR, `${state.baseName}.mulaw`);
    state.wavPath = path.join(RAW_AUDIO_DIR, `${state.baseName}.wav`);
    state.rawStream = fs.createWriteStream(state.rawPath);
}

function endStream(stream) {
    return new Promise((resolve, reject) => {
        stream.end((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function finalizeAndConvert(state) {
    if (state.rawStream) {
        await endStream(state.rawStream);
        state.rawStream = null;
    }

    if (!state.rawPath || !state.wavPath) return;

    const mulawBuffer = await fs.promises.readFile(state.rawPath);
    const wavBuffer = mulawToWav(mulawBuffer);
    await fs.promises.writeFile(state.wavPath, wavBuffer);
    await fs.promises.unlink(state.rawPath).catch(() => {});
}

function setupVoiceWebSocket(server, { wsPath = "/voice/stream" } = {}) {
    const wss = new WebSocketServer({ server, path: wsPath });

    wss.on("connection", (ws, req) => {
        console.log(
            "WebSocket client connected from:",
            req.headers.origin || req.socket.remoteAddress,
        );
        const state = createConnectionState();

        ws.on("error", (err) => {
            console.error("WebSocket error:", err.message);
        });

        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());

                switch (msg.event) {
                    case "connected":
                        console.log("Media Stream: WebSocket connected");
                        break;
                    case "start":
                        state.callSid = msg.start?.callSid || "unknown";
                        console.log(
                            "   Media Stream started, Call SID:",
                            state.callSid,
                        );
                        break;
                    case "media":
                        if (msg.media?.payload) {
                            ensureRawStream(state);
                            const chunk = Buffer.from(
                                msg.media.payload,
                                "base64",
                            );
                            state.rawStream.write(chunk);
                            state.mediaCount++;
                            state.totalBytes += chunk.length;
                            // if (state.mediaCount % 50 === 0) {
                            //     console.log(
                            //         "Received",
                            //         state.mediaCount,
                            //         "audio chunks...",
                            //     );
                            // }
                        }
                        break;
                    case "stop":
                        if (state.stopped) break;
                        state.stopped = true;
                        finalizeAndConvert(state)
                            .then(() => {
                                console.log("Media Stream stopped");
                                console.log(
                                    "   Total chunks:",
                                    state.mediaCount,
                                    "| Raw:",
                                    state.totalBytes,
                                    "bytes (mulaw)",
                                );
                                if (state.wavPath) {
                                    console.log("   Saved WAV:", state.wavPath);
                                }
                            })
                            .catch((writeErr) => {
                                console.error(
                                    "Failed to save file:",
                                    writeErr.message,
                                );
                            });
                        break;
                    default:
                        console.log("WebSocket event:", msg.event);
                        break;
                }
            } catch (err) {
                console.error("WebSocket message error:", err.message);
            }
        });

        ws.on("close", () => {
            if (!state.stopped && state.rawStream) {
                state.rawStream.end();
                if (state.rawPath) {
                    fs.promises.unlink(state.rawPath).catch(() => {});
                }
            }
            console.log("WebSocket closed");
        });
    });

    return wss;
}

module.exports = {
    setupVoiceWebSocket,
};
