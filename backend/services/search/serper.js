const axios = require("axios");

async function searchProduct(query) {
    try {
        const response = await axios.post(
            "https://google.serper.dev/search",
            {
                q: query,
                num: 10
            },
            {
                headers: {
                    "X-API-KEY": process.env.SERPER_API_KEY,
                    "Content-Type": "application/json"
                }
            }
        );

        return response.data.organic || [];
    } catch (error) {
        console.error("Serper Error:", error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    searchProduct
};