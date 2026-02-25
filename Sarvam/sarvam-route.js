const SarvamAIClient = require("sarvamai").SarvamAIClient;
const fs = require("fs");

const express = require("express");

const sarvamRouter = express.Router();

const config = require("./sarvam.config");

const client = new SarvamAIClient({
    apiSubscriptionKey: config.sarvamApiKey,
});

async function TranscribeAudio() {
    const audioFile = fs.createReadStream("./Sarvam/sample.wav");

    try {
        const response = await client.speechToText.transcribe({
            file: audioFile,
            model: "saaras:v3",
            // If it's a raw telephony file, uncomment these:
            // input_audio_codec: "mulaw",
            // sample_rate: 8000
        });

        console.log("Transcription successful:", response);
        return response;
    } catch (error) {
        console.error("Transcription Error:", error);
        throw error;
    }
}

sarvamRouter.get("/", (req, res) => {
    res.send(`Agri-Agents Sarvam routes ready.`);
});

sarvamRouter.get("/sample", async (req, res) => {
    var sampleRes = await TranscribeAudio();
    res.send(sampleRes);
});

module.exports = {
    sarvamRouter,
};
