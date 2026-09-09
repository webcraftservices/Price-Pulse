const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
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

function readIntEnv(name, fallback) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// Phase 18 Fix 3A — conservative upload size cap. AI Find's only realistic
// input is a single smartphone photo, which typically runs 2-8MB as JPEG;
// 8MB leaves comfortable headroom for one high-resolution photo while
// bounding how much disk space, memory, and Gemini request payload a
// single upload can consume. Overridable via env for operators, same
// pattern as MAX_TRUSTED_RETAILER_QUERIES elsewhere in this codebase.
const MAX_UPLOAD_BYTES = readIntEnv("MAX_IMAGE_UPLOAD_BYTES", 8 * 1024 * 1024);

// Phase 18 Fix 3B — accepted image types, matching what services/vision.js
// actually sends to Gemini as image data. This is the cheap, first-pass
// filter based on the client-DECLARED Content-Type for the part (fully
// client-controlled, not proof of actual content — see
// hasValidImageSignature below for the real content check).
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// Phase 18 Fix 2 — the on-disk extension is chosen from this hardcoded map
// keyed by the declared MIME type, never taken from the client's filename
// string (see the storage.filename comment below for why).
const EXTENSION_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
};

/**
 * Phase 18 Fix 2 — path traversal via unsanitized upload filename.
 * ------------------------------------------------------------------
 * CONFIRMED DEFECT (Phase 18 investigation): the previous filename
 * callback was `Date.now() + "-" + file.originalname`. multer's own
 * DiskStorage._handleFile does `path.join(destination, filename)` before
 * writing — reproduced directly: a crafted multipart filename containing
 * "../" segments made the resulting path resolve OUTSIDE backend/uploads/
 * entirely (a real, verified `path.join` result, not a theoretical one).
 *
 * FIX: the on-disk filename is now a server-generated random hex string
 * (crypto.randomBytes, never derived from anything client-supplied) plus a
 * fixed extension chosen from EXTENSION_BY_MIME above. file.originalname
 * is never read anywhere in this file. A random hex string plus a
 * hardcoded extension can never contain a path separator, "..", a drive
 * letter, or a null byte, so path.join(destination, filename) can no
 * longer escape UPLOAD_DIR for any input this callback can produce —
 * we are not relying on path.join alone to sanitize attacker input, we
 * removed attacker input from the filename entirely.
 */
// Extracted as a standalone, pure function (rather than inlined in the
// storage callback) specifically so it can be unit-tested directly: it
// takes ONLY a mimetype string and can never see file.originalname at
// all, which is the structural guarantee behind the Fix 2 comment above.
function generateStorageFilename(mimetype) {
    const ext = EXTENSION_BY_MIME[mimetype] || "";
    return crypto.randomBytes(16).toString("hex") + ext;
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        cb(null, generateStorageFilename(file.mimetype));
    },
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: function (req, file, cb) {
        // cb(null, false) rejects without throwing — multer leaves
        // req.file undefined rather than raising an error, so an
        // unsupported declared type is handled by the same "no file"
        // branch below as a genuinely missing upload.
        cb(null, ALLOWED_MIME_TYPES.has(file.mimetype));
    },
});

/**
 * Phase 18 Fix 3B (content check) — magic-byte signature validation.
 * ------------------------------------------------------------------
 * fileFilter above only ever sees the client-declared Content-Type for
 * the multipart part, which a client can set to anything regardless of
 * the file's actual bytes. This reads the first 12 bytes actually written
 * to disk and checks them against the known signatures for the four
 * formats ALLOWED_MIME_TYPES declares acceptable.
 *
 * LIMITATION (explicitly not hidden): this is a hand-rolled check for
 * exactly the small set of formats this app claims to support — it is
 * not a general-purpose file-type-detection library. Adding a dedicated
 * dependency (e.g. `file-type`) would give broader/more maintained
 * signature coverage, but is out of scope for this minimum-necessary fix
 * (no new dependency was added). What this DOES guarantee: a non-image
 * file (or an image format outside this list) can never reach
 * identifyProduct()/Gemini, regardless of what Content-Type the client
 * declared.
 */
async function hasValidImageSignature(filePath) {
    const handle = await fsp.open(filePath, "r");
    try {
        const buf = Buffer.alloc(12);
        const { bytesRead } = await handle.read(buf, 0, 12, 0);
        if (bytesRead < 4) return false;
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
        if (bytesRead >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // PNG
        if (buf.subarray(0, 4).toString("ascii") === "GIF8") return true; // GIF87a / GIF89a
        if (bytesRead >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return true; // WEBP
        return false;
    } finally {
        await handle.close();
    }
}

/**
 * Phase 18 Fix 3C — guaranteed upload cleanup.
 * ------------------------------------------------------------------
 * The uploaded file must not remain on disk after the request finishes,
 * on ANY exit path (success, a validation rejection, a thrown exception
 * from Gemini/search, or anything else) — called from the route's
 * `finally` block below, after every consumer (hasValidImageSignature,
 * then identifyProduct's own read of the file) has already finished
 * reading it. ENOENT (already gone) is not an error worth logging;
 * anything else is logged but never thrown — cleanup failure must not
 * turn a successful/handled request into a 500.
 */
async function cleanupUpload(filePath) {
    if (!filePath) return;
    try {
        await fsp.unlink(filePath);
    } catch (err) {
        if (err.code !== "ENOENT") {
            console.log(`[UPLOAD CLEANUP] Failed to remove ${filePath}: ${err.message}`);
        }
    }
}

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
router.post(
    "/",
    // Phase 18 Fix 3D — run multer explicitly (rather than as route
    // middleware) so its own errors (oversized file, etc.) produce a
    // clean JSON API error instead of falling through to Express's
    // default HTML error page.
    (req, res, next) => {
        upload.single("image")(req, res, (err) => {
            if (err) {
                if (err.code === "LIMIT_FILE_SIZE") {
                    return res.status(413).json({
                        error: `Image is too large. Please upload a photo under ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`,
                    });
                }
                return res.status(400).json({ error: "Couldn't process that upload. Please try a different photo." });
            }
            next();
        });
    },
    async (req, res) => {
        let uploadedPath = null;
        try {
            if (!req.file) {
                // Either no file was sent at all, or fileFilter rejected an
                // unsupported declared type (cb(null, false) leaves req.file
                // undefined with no thrown error) — both land here.
                return res.status(400).json({ error: "Please choose a JPEG, PNG, WEBP, or GIF photo and try again." });
            }

            uploadedPath = req.file.path;

            console.log("Image uploaded:", { filename: req.file.filename, size: req.file.size, mimetype: req.file.mimetype });

            if (!(await hasValidImageSignature(uploadedPath))) {
                return res.status(400).json({ error: "That file doesn't look like a valid image. Please try a different photo." });
            }

            const result = await identifyProduct(uploadedPath);

            console.log("Gemini Output:");
            console.log(result);

            // Do not report success on HTTP 200 alone — validate the AI
            // actually identified something before ever searching or
            // returning "found".
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
            });

        } catch (error) {
            console.log("FULL ERROR:");
            console.log(error.response?.data);
            console.log(error.message);

            res.status(error.statusCode || 500).json({
                error: (error.response?.data && error.response.data.error && error.response.data.error.message)
                    || "Couldn't process that image right now. Please try again in a moment.",
            });
        } finally {
            await cleanupUpload(uploadedPath);
        }
    }
);

module.exports = router;
// Additive, test-only exports — attached to the router function object.
// These do not change request-handling behavior at all; they exist so the
// Phase 18 security/upload fixes can be unit-tested directly and
// deterministically (no real HTTP server, no network) rather than only
// indirectly through a full request.
module.exports.UPLOAD_DIR = UPLOAD_DIR;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
module.exports.ALLOWED_MIME_TYPES = ALLOWED_MIME_TYPES;
module.exports.generateStorageFilename = generateStorageFilename;
module.exports.hasValidImageSignature = hasValidImageSignature;
module.exports.cleanupUpload = cleanupUpload;
