require("dotenv").config();
const axios = require("axios");

async function listModels() {
    try {
        const response = await axios.get(
            `https://generativelanguage.googleapis.com/v1/models?key=${process.env.GEMINI_API_KEY}`
        );

        console.log(response.data);
    } catch (error) {
        console.log(error.response?.data || error.message);
    }
}

listModels();