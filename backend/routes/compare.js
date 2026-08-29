const express = require("express");
const router = express.Router();

const { compareProduct } = require("../services/compareService");

router.post("/", async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({
                error: "Product URL is required."
            });
        }

        const result = await compareProduct(url);

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(err.statusCode || 500).json({
            error: err.message
        });
    }
});

module.exports = router;