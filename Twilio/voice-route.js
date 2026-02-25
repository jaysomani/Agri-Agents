require("dotenv").config();

const express = require("express");
const VoiceResponse = require("twilio").twiml.VoiceResponse;

const twilioRouter = express.Router();
const PORT = process.env.PORT || 3000;

function getBaseUrl(req) {
    if (req) {
        const forwardedProto = req.get("x-forwarded-proto");
        const proto = forwardedProto
            ? forwardedProto.split(",")[0].trim()
            : req.protocol || "http";
        const host = req.get("x-forwarded-host") || req.get("host");
        if (host) return `${proto}://${host}`;
    }

    return `http://localhost:${PORT}`;
}

function getWebSocketUrl(req, wsPath = "/voice/stream") {
    const baseUrl = getBaseUrl(req);
    const wsProtocol = baseUrl.startsWith("https://") ? "wss://" : "ws://";
    return baseUrl.replace(/^https?:\/\//, wsProtocol) + wsPath;
}

twilioRouter.post("/incoming", (req, res) => {
    const baseUrl = getBaseUrl(req);
    const wssUrl = getWebSocketUrl(req);

    console.log("\nIncoming call from:", req.body.Caller || "unknown");
    console.log("   Base URL:", baseUrl);
    console.log("   Media Stream URL:", wssUrl);

    const twiml = new VoiceResponse();
    const start = twiml.start();
    start.stream({
        url: wssUrl,
        track: "inbound_track",
    });

    twiml.say(
        { voice: "alice", language: "en-IN" },
        "Welcome to Agri Agents. Please tell me your question now.",
    );

    // TODO: Replace the paused logic with conversation logic
    twiml.pause({ length: 45 });
    twiml.say({ voice: "alice" }, "Thank you for calling. Goodbye.");
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
});

twilioRouter.get("/", (req, res) => {
    const baseUrl = getBaseUrl(req);
    res.send(
        `Agri-Agents Voice routes ready. Webhook: ${baseUrl}/voice/incoming`,
    );
});

module.exports = {
    twilioRouter,
};
