const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { identifyProduct } = require("../services/vision");
const { searchProduct } = require("../services/search");
const router = express.Router();

// Resolve uploads relative to this file (backend/uploads), never relative to
// process.cwd() — "uploads/" alone silently pointed at whatever directory the
// process happened to be launched from (e.g. the project root if started as
// `node backend/server.js`), which doesn't have an uploads/ folder and made
// every upload fail with an ENOENT before Gemini was ever called.
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: function(req, file, cb){
        cb(null, UPLOAD_DIR);
    },
    filename: function(req, file, cb){
        cb(null, Date.now() + "-" + file.originalname);
    }
});

const upload = multer({ storage });

// A Gemini response that parsed as JSON but didn't actually identify
// anything (e.g. "{}", or every field blank/"unknown") must never be
// treated as a successful identification — that's what was producing
// "Done" with nothing real behind it.
function isUsableIdentification(result) {
    if (!result || typeof result !== "object") return false;
    const brand = (result.brand || "").trim();
    const productName = (result.productName || "").trim();
    const isPlaceholder = (v) => !v || /^(unknown|n\/a|none|null)$/i.test(v);
    return !isPlaceholder(brand) || !isPlaceholder(productName);
}

// POST /api/search-image
router.post("/", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No image was received. Please choose a photo and try again." });
        }

        console.log("Image Uploaded:");
        console.log(req.file);

        const result = await identifyProduct(req.file.path);

        console.log("Gemini Output:");
        console.log(result);

        // Do not report success on HTTP 200 alone — validate the AI actually
        // identified something before ever searching or returning "found".
        if (!isUsableIdentification(result)) {
            return res.status(422).json({
                error: "Could not identify a product in that photo. Try a clearer, well-lit shot of the item.",
            });
        }

        const searchQuery = `${result.brand || ""} ${result.productName || ""}`.trim();

        console.log("Search Query:");
        console.log(searchQuery);

        const searchResults = await searchProduct(searchQuery);

        console.log("Serper Results:");
        console.log(searchResults);

        res.json({
            success: true,
            product: result,
            searchResults: searchResults,
            filename: req.file.filename,
        });

    } catch (error) {
        console.log("FULL ERROR:");
        console.log(error.response?.data);
        console.log(error.message);

        res.status(error.statusCode || 500).json({
            error: (error.response?.data && error.response.data.error && error.response.data.error.message)
                || "Couldn't process that image right now. Please try again in a moment.",
        });
    }

});
module.exports = router;