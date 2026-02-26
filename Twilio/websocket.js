const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { mulawToWav, mulawToPcmBuffer, pcmToWavBuffer, pcm8kTo16k } = require("../Utils/Utility");
const { randomUUID } = require("crypto");
const SarvamAIClient = require("sarvamai").SarvamAIClient;
const sarvamConfig = require("../Sarvam/sarvam.config");
const { createNovaSession } = require("../services/nova-sonic.service");

const RAW_AUDIO_DIR = path.join(process.cwd(), "raw-recordings");
const USE_NOVA_SONIC = process.env.USE_NOVA_SONIC === "true";
if (USE_NOVA_SONIC && !sarvamConfig.sarvamApiKey) {
    console.warn(
        "[Nova Sonic] USE_NOVA_SONIC=true but SARVAM_API_KEY is not set. Sarvam is used for VAD (speech_start/speech_end). Nova will only receive contentEnd when the call stops."
    );
}
fs.mkdirSync(RAW_AUDIO_DIR, { recursive: true });

// ~200ms of 8kHz PCM = 3200 bytes. Twilio sends ~160 bytes/chunk (20ms) = 10 chunks
const SARVAM_BUFFER_MS = 200;
const PCM_BYTES_PER_MS = 16; // 8kHz * 2 bytes/sample

const sarvamClient = sarvamConfig.sarvamApiKey
    ? new SarvamAIClient({ apiSubscriptionKey: sarvamConfig.sarvamApiKey })
    : null;

// ~200ms of 16kHz PCM = 6400 bytes (for Nova Sonic)
const NOVA_BUFFER_MS = 200;
const PCM_16K_BYTES_PER_MS = 32; // 16kHz * 2 bytes/sample

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
        // Sarvam real-time streaming
        sarvamSocket: null,
        pcmBuffer: [],
        pcmBufferBytes: 0,
        sarvamHadError: false, // set true on error to prevent reconnect storm
        // Nova Sonic (when USE_NOVA_SONIC)
        novaSession: null,
        novaStream: null,
        novaPcmBuffer: [],
        novaPcmBufferBytes: 0,
        novaContentEndSent: false,
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

async function connectSarvamStreaming(state) {
    if (!sarvamClient) return;
    state.sarvamHadError = false;
    try {
        const socket = await sarvamClient.speechToTextStreaming.connect({
            "language-code": "en-IN",
            model: "saaras:v3",
            mode: "transcribe",
            sample_rate: 8000,
            high_vad_sensitivity: true,
            flush_signal: true,
            debug: false,
        });

        socket.on("open", () => {
            console.log("   [Sarvam WebSocket] open event fired");
        });

        socket.on("close", (event) => {
            const code = event?.code ?? "?";
            const reason = event?.reason ?? "(none)";
            console.log(
                "   [Sarvam WebSocket CLOSED] code:",
                code,
                "reason:",
                String(reason),
            );
            state.sarvamSocket = null;
            // Only reconnect on normal close (1000) after successful transcript
            // Do NOT reconnect on error (1003 rate limit, etc.) to avoid reconnect storm
            if (!state.stopped && sarvamClient && code === 1000 && !state.sarvamHadError) {
                console.log("   [Sarvam] reconnecting for next utterance...");
                connectSarvamStreaming(state);
            }
        });

        socket.on("message", (data) => {
            const msg = typeof data === "string" ? JSON.parse(data) : data;
            const type = msg?.type;
            if (type === "error") {
                state.sarvamHadError = true;
                console.error("   [Sarvam error]:", msg?.data?.message ?? msg);
                return;
            }
            const transcript =
                msg?.data?.transcript ?? msg?.transcript ?? msg?.text;
            if (transcript) {
                console.log("   [Sarvam transcript]:", transcript);
            } else if (type === "speech_start") {
                console.log("   [Sarvam] speech started");
                // Nova: start new audio content for next utterance (after first)
                if (USE_NOVA_SONIC && state.novaStream?.isActive && state.novaContentEndSent) {
                    state.novaStream.startAudioContent();
                    state.novaContentEndSent = false;
                }
            } else if (type === "speech_end") {
                console.log("   [Sarvam] speech ended");
                if (USE_NOVA_SONIC && state.novaStream?.isActive) {
                    flushPcmBufferToNova(state);
                    state.novaStream.endAudioContent();
                    state.novaContentEndSent = true;
                }
            }
        });

        socket.on("error", (err) => {
            console.error("   [Sarvam WebSocket error]:", err?.message || err);
        });

        await socket.waitForOpen();
        if (state.stopped) {
            socket.close();
            return;
        }
        state.sarvamSocket = socket;
        console.log("   Sarvam streaming connected");
        // Flush any audio buffered while we were connecting
        flushPcmBufferToSarvam(state);
    } catch (err) {
        console.error("   Failed to connect Sarvam streaming:", err?.message || err);
    }
}

async function connectNovaSonic(state) {
    if (!USE_NOVA_SONIC) return;
    try {
        const { stream } = await createNovaSession({
            onAudioOutput(audioBytes) {
                if (state.stopped) return;
                console.log(
                    "   [Nova Sonic] received audio blob:",
                    audioBytes.length,
                    "bytes (24kHz PCM)"
                );
                // Phase 1: log; Phase 3 will send to Twilio
                const outPath = path.join(
                    RAW_AUDIO_DIR,
                    `nova_${state.baseName || state.connectionId}_${Date.now()}.raw`
                );
                fs.writeFile(outPath, audioBytes, (err) => {
                    if (err) console.error("   [Nova] failed to save:", err?.message);
                });
            },
            onTextOutput(data) {
                if (data?.content) console.log("   [Nova Sonic text]:", data.content);
            },
            onError(err) {
                console.error("   [Nova Sonic error]:", err?.message || err);
            },
        });
        state.novaStream = stream;
        state.novaSession = { sessionId: stream.sessionId };
        console.log("   Nova Sonic session started:", stream.sessionId);
    } catch (err) {
        console.error("   Failed to start Nova Sonic:", err?.message || err);
    }
}

function flushPcmBufferToNova(state) {
    if (!state.novaStream || !state.novaStream.isActive || state.novaPcmBufferBytes === 0)
        return;
    const combined = Buffer.concat(state.novaPcmBuffer);
    const pcm16k = pcm8kTo16k(combined);
    state.novaStream.streamAudio(pcm16k);
    state.novaPcmBuffer = [];
    state.novaPcmBufferBytes = 0;
}

function flushPcmBufferToSarvam(state) {
    if (!state.sarvamSocket || state.pcmBufferBytes === 0) return;
    const rs = state.sarvamSocket.readyState;
    const states = { 0: "CONNECTING", 1: "OPEN", 2: "CLOSING", 3: "CLOSED" };
    if (rs !== 1) {
        console.log(
            "   [Sarvam forward] skipping - socket not OPEN, readyState:",
            rs,
            "(",
            states[rs] || "?",
            ")",
        );
        return;
    }
    try {
        const combined = Buffer.concat(state.pcmBuffer);
        const wavBuffer = pcmToWavBuffer(combined);
        const base64Wav = wavBuffer.toString("base64");
        state.sarvamSocket.transcribe({
            audio: base64Wav,
            encoding: "audio/wav",
            sample_rate: 8000,
        });
        state.pcmBuffer = [];
        state.pcmBufferBytes = 0;
    } catch (err) {
        const nowState = state.sarvamSocket?.readyState ?? "null";
        console.error(
            "   [Sarvam forward error]:",
            err?.message || err,
            "| readyState at error:",
            nowState,
        );
    }
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
                        ensureRawStream(state);
                        connectSarvamStreaming(state);
                        if (USE_NOVA_SONIC) connectNovaSonic(state);
                        break;
                    case "media":
                        if (msg.media?.payload) {
                            ensureRawStream(state);
                            const mulawChunk = Buffer.from(
                                msg.media.payload,
                                "base64",
                            );
                            state.rawStream.write(mulawChunk);
                            state.mediaCount++;
                            state.totalBytes += mulawChunk.length;

                            // Forward to Sarvam streaming: buffer PCM, flush when ready
                            const pcmChunk = mulawToPcmBuffer(mulawChunk);
                            if (sarvamClient) {
                                state.pcmBuffer.push(pcmChunk);
                                state.pcmBufferBytes += pcmChunk.length;
                                const bufferMs =
                                    (state.pcmBufferBytes / PCM_BYTES_PER_MS) | 0;
                                if (
                                    state.sarvamSocket &&
                                    bufferMs >= SARVAM_BUFFER_MS
                                ) {
                                    flushPcmBufferToSarvam(state);
                                }
                            }
                            // Forward to Nova Sonic: buffer 8k PCM, resample to 16k, flush when ready
                            if (USE_NOVA_SONIC && state.novaStream?.isActive) {
                                state.novaPcmBuffer.push(Buffer.from(pcmChunk));
                                state.novaPcmBufferBytes += pcmChunk.length;
                                const novaBufferMs =
                                    (state.novaPcmBufferBytes / PCM_BYTES_PER_MS) | 0;
                                if (novaBufferMs >= NOVA_BUFFER_MS) {
                                    flushPcmBufferToNova(state);
                                }
                            }
                        }
                        break;
                    case "stop":
                        if (state.stopped) break;
                        state.stopped = true;

                        // Flush and close Sarvam streaming
                        if (state.sarvamSocket) {
                            flushPcmBufferToSarvam(state);
                            try {
                                state.sarvamSocket.flush();
                                state.sarvamSocket.close();
                            } catch (e) {
                                /* ignore close errors */
                            }
                            state.sarvamSocket = null;
                        }

                        // End Nova Sonic session
                        if (state.novaStream?.isActive) {
                            flushPcmBufferToNova(state);
                            state.novaStream.endSession().catch((e) =>
                                console.error("   [Nova] endSession error:", e?.message)
                            );
                            state.novaStream = null;
                        }

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
            state.stopped = true;
            if (state.rawStream) {
                state.rawStream.end();
                if (state.rawPath) {
                    fs.promises.unlink(state.rawPath).catch(() => {});
                }
            }
            if (state.sarvamSocket) {
                try {
                    state.sarvamSocket.close();
                } catch (e) {
                    /* ignore */
                }
                state.sarvamSocket = null;
            }
            if (state.novaStream?.isActive) {
                state.novaStream.endSession().catch(() => {});
                state.novaStream = null;
            }
            console.log("WebSocket closed");
        });
    });

    return wss;
}

module.exports = {
    setupVoiceWebSocket,
};
