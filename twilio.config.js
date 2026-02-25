/**
 * Twilio Configuration
 * Loads from .env file. Get credentials from: https://console.twilio.com/
 * - Account SID: Your Twilio account identifier
 * - Auth Token: Your Twilio API secret
 * - Phone Number: Your Twilio phone number (e.g. +1234567890)
 */

require("dotenv").config();

module.exports = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  phoneNumber: process.env.TWILIO_PHONE_NUMBER,
};
