/**
 * AWS Bedrock Nova Sonic service - real-time speech-to-speech via InvokeModelWithBidirectionalStream.
 * Accepts 16kHz PCM, returns audio blobs (24kHz PCM by default).
 */

const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require("@aws-sdk/client-bedrock-runtime");
const { NodeHttp2Handler } = require("@smithy/node-http-handler");
const { randomUUID } = require("crypto");

const MODEL_ID = "amazon.nova-sonic-v1:0";

const DefaultAudioInputConfiguration = {
    audioType: "SPEECH",
    encoding: "base64",
    mediaType: "audio/lpcm",
    sampleRateHertz: 16000,
    sampleSizeBits: 16,
    channelCount: 1,
};

const DefaultAudioOutputConfiguration = {
    audioType: "SPEECH",
    encoding: "base64",
    mediaType: "audio/lpcm",
    sampleRateHertz: 24000,
    sampleSizeBits: 16,
    channelCount: 1,
    voiceId: "tiffany",
};

const DefaultInferenceConfiguration = {
    maxTokens: 1024,
    topP: 0.9,
    temperature: 0.7,
};

const DefaultSystemPrompt =
    "You are a friendly agricultural assistant. Help farmers with crop advice, weather, and farming questions. Keep responses concise and clear.";

let bedrockClient = null;

function getClient() {
    if (bedrockClient) return bedrockClient;
    const region = process.env.AWS_REGION || "us-east-1";
    const nodeHttp2Handler = new NodeHttp2Handler({
        requestTimeout: 300000,
        sessionTimeout: 300000,
        disableConcurrentStreams: false,
        maxConcurrentStreams: 10,
    });
    bedrockClient = new BedrockRuntimeClient({
        region,
        requestHandler: nodeHttp2Handler,
    });
    return bedrockClient;
}

/**
 * Create a queue-based async iterable for the bidirectional stream input.
 * Events are pushed via addEvent(); the iterator yields when events are available.
 */
function createEventQueue() {
    const queue = [];
    let resolveWait = null;

    return {
        add(event) {
            queue.push(event);
            if (resolveWait) {
                resolveWait();
                resolveWait = null;
            }
        },
        close() {
            queue.push(null); // sentinel
            if (resolveWait) {
                resolveWait();
                resolveWait = null;
            }
        },
        async *[Symbol.asyncIterator]() {
            const textEncoder = new TextEncoder();
            while (true) {
                let item = queue.shift();
                while (item === undefined) {
                    await new Promise((resolve) => {
                        resolveWait = resolve;
                        setTimeout(resolve, 50); // wake on add or timeout
                    });
                    item = queue.shift();
                }
                if (item === null) break;
                const json = typeof item === "string" ? item : JSON.stringify(item);
                yield { chunk: { bytes: textEncoder.encode(json) } };
            }
        },
    };
}

/**
 * Create and run a Nova Sonic bidirectional stream session.
 * @param {Object} options
 * @param {function(Buffer): void} [options.onAudioOutput] - Called with raw PCM bytes for each audio blob
 * @param {function(object): void} [options.onTextOutput] - Called with text transcript events
 * @param {function(string): void} [options.onError] - Called on stream errors
 * @returns {Promise<{ sessionId: string, stream: Object }>} - Session ID and stream control object
 */
async function createNovaSession(options = {}) {
    const { onAudioOutput, onTextOutput, onError } = options;
    const sessionId = randomUUID();
    const promptName = randomUUID();
    const audioContentId = randomUUID();
    const eventQueue = createEventQueue();

    const stream = {
        sessionId,
        isActive: true,
        audioContentId,

        /** Push audio chunk (16kHz PCM Buffer) - call after contentStart */
        streamAudio(pcm16kBuffer) {
            if (!this.isActive) return;
            const base64 = pcm16kBuffer.toString("base64");
            eventQueue.add({
                event: {
                    audioInput: {
                        promptName,
                        contentName: audioContentId,
                        content: base64,
                    },
                },
            });
        },

        /** End current audio content (e.g. on user speech end) */
        endAudioContent() {
            if (!this.isActive) return;
            eventQueue.add({
                event: {
                    contentEnd: {
                        promptName,
                        contentName: audioContentId,
                    },
                },
            });
        },

        /** Start new audio content block (for next utterance) */
        startAudioContent() {
            const newId = randomUUID();
            this.audioContentId = newId;
            eventQueue.add({
                event: {
                    contentStart: {
                        promptName,
                        contentName: newId,
                        type: "AUDIO",
                        interactive: true,
                        role: "USER",
                        audioInputConfiguration: DefaultAudioInputConfiguration,
                    },
                },
            });
        },

        /** End prompt and session (call when call ends) */
        async endSession() {
            this.isActive = false;
            eventQueue.add({
                event: { contentEnd: { promptName, contentName: this.audioContentId } },
            });
            await sleep(100);
            eventQueue.add({
                event: { promptEnd: { promptName } },
            });
            await sleep(100);
            eventQueue.add({
                event: { sessionEnd: {} },
            });
            await sleep(50);
            eventQueue.close();
        },
    };

    // Build initial event sequence
    eventQueue.add({
        event: {
            sessionStart: {
                inferenceConfiguration: DefaultInferenceConfiguration,
            },
        },
    });
    await sleep(30);

    eventQueue.add({
        event: {
            promptStart: {
                promptName,
                textOutputConfiguration: { mediaType: "text/plain" },
                audioOutputConfiguration: DefaultAudioOutputConfiguration,
            },
        },
    });
    await sleep(30);

    // System prompt
    const textContentId = randomUUID();
    eventQueue.add({
        event: {
            contentStart: {
                promptName,
                contentName: textContentId,
                type: "TEXT",
                interactive: false,
                role: "SYSTEM",
                textInputConfiguration: { mediaType: "text/plain" },
            },
        },
    });
    eventQueue.add({
        event: {
            textInput: {
                promptName,
                contentName: textContentId,
                content: DefaultSystemPrompt,
            },
        },
    });
    eventQueue.add({
        event: {
            contentEnd: {
                promptName,
                contentName: textContentId,
            },
        },
    });
    await sleep(30);

    // Audio content start
    eventQueue.add({
        event: {
            contentStart: {
                promptName,
                contentName: audioContentId,
                type: "AUDIO",
                interactive: true,
                role: "USER",
                audioInputConfiguration: DefaultAudioInputConfiguration,
            },
        },
    });

    // Run the bidirectional stream in background
    (async () => {
        try {
            const client = getClient();
            const response = await client.send(
                new InvokeModelWithBidirectionalStreamCommand({
                    modelId: MODEL_ID,
                    body: eventQueue,
                })
            );

            for await (const ev of response.body) {
                if (!stream.isActive) break;
                if (ev.chunk?.bytes) {
                    const text = new TextDecoder().decode(ev.chunk.bytes);
                    try {
                        const json = JSON.parse(text);
                        if (json.event?.audioOutput?.content) {
                            const audioBytes = Buffer.from(json.event.audioOutput.content, "base64");
                            if (onAudioOutput) onAudioOutput(audioBytes);
                        }
                        if (json.event?.textOutput?.content && onTextOutput) {
                            onTextOutput(json.event.textOutput);
                        }
                    } catch {
                        // ignore parse errors
                    }
                } else if (ev.modelStreamErrorException || ev.internalServerException) {
                    const err = ev.modelStreamErrorException || ev.internalServerException;
                    if (onError) onError(err);
                }
            }
        } catch (err) {
            stream.isActive = false;
            if (onError) onError(err);
            console.error("[Nova Sonic] Stream error:", err?.message || err);
        }
    })();

    return { sessionId, stream };
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
    createNovaSession,
    DefaultAudioInputConfiguration,
    DefaultAudioOutputConfiguration,
};
