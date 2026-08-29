const fs = require("fs");
const axios = require("axios");

async function identifyProduct(imagePath) {
    const imageBase64 = fs.readFileSync(imagePath, {
        encoding: "base64",
    });

    console.log("Gemini API key configured:", Boolean(process.env.GEMINI_API_KEY));
    console.log("Image size:", imageBase64.length);

    try {
        console.log("Sending request to Gemini...");
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                contents: [
                    {
                        parts: [
                            {
                                inlineData: {
                                    mimeType: "image/jpeg",
                                    data: imageBase64,
                                },
                            },
                            {
                                text: `
Identify this product.

Return ONLY valid JSON.

Example:

{
  "brand": "",
  "productName": "",
  "model": "",
  "storage": "",
  "color": "",
  "category": ""
}
`,
                            },
                        ],
                    },
                ],
            },
            {
    headers: {
        "Content-Type": "application/json",
    },
    timeout: 120000,
}
        );
        console.log("Gemini replied.");

        console.log("Gemini Response:");
        console.log(JSON.stringify(response.data, null, 2));

        let text = response.data.candidates[0].content.parts[0].text;

text = text.replace(/```json/g, "");
text = text.replace(/```/g, "");
text = text.trim();

return JSON.parse(text);

    } catch (error) {
        console.log("Gemini Error:");
        console.log(error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    identifyProduct,
};