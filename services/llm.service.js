/**
 * Bedrock ConverseStream service - streaming text responses from foundation models.
 */

const {
    BedrockRuntimeClient,
    ConverseStreamCommand,
    ConversationRole,
} = require("@aws-sdk/client-bedrock-runtime");

// Use Claude 3 Haiku (on-demand) or set BEDROCK_MODEL_ID for inference profile (e.g. us.anthropic.claude-sonnet-4-6)
const DEFAULT_MODEL = process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-haiku-20240307-v1:0";
const SYSTEM_PROMPT = `You are a friendly voice assistant for Indian farmers. Answer questions about crops, weather, soil, pests, and farming practices.
Rules:

Reply in the SAME language the user uses. Hindi → Hindi. Hinglish → Hinglish. English → English. Never use any other language.
Maximum 2 short sentences per response. Never use bullet points or lists.
Be direct, warm, and simple — like a trusted local agricultural advisor on a phone call.
If key details are missing, ask ONE short counter-question before answering. For example: if the farmer asks about weather, ask their location first. If they ask about a crop problem, ask which crop and which state/region.
Never ask more than one counter-question at a time.
If unsure, say so briefly and suggest calling the Kisan Call Center (1800-180-1551).

Examples of counter-questions:

Weather query → "Aap kis district mein hain?" / "Which district are you in?"
Pest/disease query → "Kaun si fasal mein problem hai?" / "Which crop is affected?"
Sowing query → "Aap kis state mein kheti karte hain?" / "Which state do you farm in?"`

let client = null;

function getClient() {
    if (client) return client;
    client = new BedrockRuntimeClient({
        region: process.env.AWS_REGION || "us-east-1",
    });
    return client;
}

/**
 * Convert conversation history to Bedrock message format.
 * @param {Array<{role: string, content: string}>} history - [{ role, content }]
 */
function toBedrockMessages(history) {
    return history.map(({ role, content }) => ({
        role: role === "user" ? ConversationRole.USER : ConversationRole.ASSISTANT,
        content: [{ text: content }],
    }));
}

/**
 * Stream a response from Bedrock given user transcript and conversation history.
 * @param {string} userMessage - The user's transcript (latest utterance)
 * @param {Array<{role: string, content: string}>} conversationHistory - Prior turns
 * @param {AbortSignal} [abortSignal] - Abort when call ends
 * @returns {AsyncGenerator<string>} Yields text chunks as they stream
 */
async function* generateResponseStream(userMessage, conversationHistory = [], abortSignal = null) {
    const messages = toBedrockMessages(conversationHistory);
    messages.push({
        role: ConversationRole.USER,
        content: [{ text: userMessage }],
    });

    if (process.env.DEBUG_LLM_PROMPT) {
        console.log("   [LLM] full prompt:", JSON.stringify({ messages, system: SYSTEM_PROMPT }, null, 2));
    }

    const command = new ConverseStreamCommand({
        modelId: DEFAULT_MODEL,
        messages,
        system: [{ text: SYSTEM_PROMPT }],
        inferenceConfig: {
            maxTokens: 180,
            temperature: 0.2,
            topP: 0.7,
        },
    });

    const sendOptions = abortSignal ? { abortSignal } : {};
    const response = await getClient().send(command, sendOptions);

    if (!response.stream) {
        throw new Error("No stream in ConverseStream response");
    }

    let chunkCount = 0;
    for await (const event of response.stream) {
        if (event.contentBlockDelta?.delta?.text) {
            chunkCount++;
            if (chunkCount <= 3) {
                console.log("   [LLM] streaming chunk", chunkCount, ":", event.contentBlockDelta.delta.text.substring(0, 30) + "...");
            }
            yield event.contentBlockDelta.delta.text;
        }
    }
    console.log("   [LLM] stream complete, total chunks:", chunkCount);
}

module.exports = {
    generateResponseStream,
};
