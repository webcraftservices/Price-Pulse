const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

async function searchProduct(productDetails) {
  const prompt = `
You are a shopping assistant.

Find online listings for this product:

${productDetails}

Return ONLY valid JSON in this format:

[
  {
    "store": "",
    "title": "",
    "price": "",
    "url": ""
  }
]

Do not include explanations or markdown.
`;

  const response = await ai.models.generateContent({
    model: "gemini-3.6-flash",
    contents: prompt,
  });

  return response.text;
}

module.exports = { searchProduct };