// dotenv's default config() loads ".env" relative to process.cwd() — but every
// documented start command (`npm start` from the project root, or
// `node backend/server.js` run from the project root) has a cwd of the
// project root, not backend/. Since backend/.env.example makes clear the
// real .env belongs in backend/, that mismatch meant SERPER_API_KEY and
// GEMINI_API_KEY were silently never loaded no matter how correctly the
// user filled in backend/.env — reproducing exactly the "all adapters
// failed" Compare error and Gemini failures. Pointing dotenv explicitly at
// this file makes it load regardless of the working directory the process
// was started from.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const compareRoute = require("./routes/compare");
const compareTextRoute = require("./routes/compareText");
const imageSearchRoute = require("./routes/imageSearch");
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("🚀 PricePulse Backend is Running!");
});

// Simple liveness/config check — used by TESTING.md Test 1 and by anyone
// verifying the Node backend (not the deprecated server.ps1) is what's
// actually serving API requests. Never exposes secret values, only whether
// each required key is present.
app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        service: "PricePulse",
        timestamp: new Date().toISOString(),
        config: {
            serperConfigured: Boolean(process.env.SERPER_API_KEY),
            geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
        },
    });
});

const PORT = process.env.PORT || 5000;
app.use("/api/compare", compareRoute);
app.use("/api/compare-text", compareTextRoute);
app.use("/api/search-image", imageSearchRoute);

if (!process.env.SERPER_API_KEY) {
    console.warn("[STARTUP WARNING] SERPER_API_KEY is not set — /api/compare and /api/compare-text will fail for every request (Google Shopping is the only active data source).");
}
if (!process.env.GEMINI_API_KEY) {
    console.warn("[STARTUP WARNING] GEMINI_API_KEY is not set — /api/search-image (AI Find) will fail for every request.");
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});