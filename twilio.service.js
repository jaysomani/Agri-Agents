/**
 * Twilio Service - Agri-Agents
 * Handles SMS, voice, and other Twilio integrations.
 */

const twilio = require("twilio");
const config = require("./twilio.config");

// Initialize Twilio client
const client = twilio(config.accountSid, config.authToken);

/**
 * Send an SMS message
 * @param {string} to - Recipient phone number (e.g. +1234567890)
 * @param {string} body - Message text
 * @returns {Promise<object>} Twilio message object
 */
async function sendSMS(to, body) {
  const message = await client.messages.create({
    body,
    from: config.phoneNumber,
    to,
  });
  return message;
}

/**
 * Make a voice call
 * @param {string} to - Recipient phone number
 * @param {string} url - TwiML URL or Twilio URL for call handling
 * @returns {Promise<object>} Twilio call object
 */
async function makeCall(to, url) {
  const call = await client.calls.create({
    url: url || `https://handler.twilio.com/twiml`,
    to,
    from: config.phoneNumber,
  });
  return call;
}

module.exports = {
  client,
  config,
  sendSMS,
  makeCall,
};
