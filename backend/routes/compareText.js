const express = require("express");
const router = express.Router();

const { compareByQuery, compareByProduct } = require("../services/compareService");

// Additive endpoint: compare by product name/description (or a structured
// product object) instead of a URL. Powers AI Find's text search,
// suggestion chips, and the "Compare Prices" handoff after an image is
// identified. Does not touch /api/compare or /api/search-image.
router.post("/", async (req, res) => {
    try {
        const { query, product } = req.body;

        let result;
        if (product) {
            // Structured handoff from AI Find (brand/model/storage/color/...) —
            // gives the comparison engine enough detail to match variants accurately.
            result = await compareByProduct(product);
        } else if (query) {
            result = await compareByQuery(query);
        } else {
            return res.status(400).json({
                error: "A search query or product is required."
            });
        }

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(err.statusCode || 500).json({
            error: err.message
        });
    }
});

module.exports = router;
