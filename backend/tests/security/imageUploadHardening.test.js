/**
 * Phase 18, Fixes 2 & 3 — upload path traversal, size/type limits, cleanup
 * ------------------------------------------------------------------
 * CONFIRMED DEFECTS (Phase 18 investigation), both in
 * backend/routes/imageSearch.js:
 *
 *  Fix 2: the multer diskStorage filename callback was
 *  `Date.now() + "-" + file.originalname` — file.originalname is fully
 *  client-controlled (from the multipart Content-Disposition header) and
 *  multer's own DiskStorage._handleFile does `path.join(destination,
 *  filename)` before writing, so a crafted filename containing "../"
 *  segments made the write target resolve outside backend/uploads/
 *  entirely (reproduced directly during the investigation).
 *
 *  Fix 3: no file-size limit, no type restriction beyond trusting the
 *  client-declared Content-Type, and no cleanup — every upload
 *  accumulated on disk forever, of any size or type.
 *
 * This file tests both the extracted pure helpers directly (no network,
 * no HTTP) and the full route end-to-end over a real (loopback,
 * ephemeral-port) HTTP server, with services/vision and services/search
 * stubbed via the same require-patch technique already used elsewhere in
 * this suite (see tests/urls/urlRecognition.test.js) — no real Gemini or
 * Serper call is ever made.
 *
 * USAGE: node tests/security/imageUploadHardening.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const http = require("http");
const Module = require("module");

// ------------------------------------------------------------------
// Stub services/vision and services/search BEFORE routes/imageSearch.js
// is ever required, exactly like the existing axios/cheerio interceptor
// pattern in tests/urls/urlRecognition.test.js.
// ------------------------------------------------------------------
let visionStub = async () => ({ brand: "Sony", productName: "WH-1000XM5" });
let searchStub = async () => [{ store: "Amazon", price: "36999" }];

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "../services/vision") return { identifyProduct: (...args) => visionStub(...args) };
    if (id === "../services/search") return { searchProduct: (...args) => searchStub(...args) };
    return originalRequire.apply(this, arguments);
};

const imageSearchPath = path.join(__dirname, "..", "..", "routes", "imageSearch.js");
delete require.cache[require.resolve(imageSearchPath)];
const imageSearchRouter = require(imageSearchPath);
const express = require("express");

const results = [];
async function test(name, fn) {
    try {
        await fn();
        results.push({ name, pass: true });
        console.log(`PASS  ${name}`);
    } catch (err) {
        results.push({ name, pass: false, error: err.message });
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
}

// ------------------------------------------------------------------
// Minimal, dependency-free multipart/form-data body builder + HTTP client
// (no supertest/form-data dependency added — this project intentionally
// carries no test-framework dependencies).
// ------------------------------------------------------------------
function buildMultipart(boundary, fileField) {
    const CRLF = "\r\n";
    const { name, filename, contentType, data } = fileField;
    return Buffer.concat([
        Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}Content-Type: ${contentType}${CRLF}${CRLF}`),
        data,
        Buffer.from(CRLF + `--${boundary}--${CRLF}`),
    ]);
}

function postMultipart(port, fileField) {
    return new Promise((resolve, reject) => {
        const boundary = "----phase18test" + Date.now() + Math.random().toString(16).slice(2);
        const body = buildMultipart(boundary, fileField);
        const req = http.request(
            {
                host: "localhost",
                port,
                path: "/api/search-image",
                method: "POST",
                headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    let json = null;
                    try {
                        json = JSON.parse(Buffer.concat(chunks).toString());
                    } catch {
                        /* non-JSON response body — json stays null */
                    }
                    resolve({ status: res.statusCode, json });
                });
            }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 0)]);

async function withServer(fn) {
    const app = express();
    app.use("/api/search-image", imageSearchRouter);
    const server = app.listen(0);
    const port = server.address().port;
    try {
        await fn(port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function uploadsDirEntries() {
    return fs.existsSync(imageSearchRouter.UPLOAD_DIR) ? fs.readdirSync(imageSearchRouter.UPLOAD_DIR) : [];
}

// ==================================================================
// Unit tests — pure helper functions, no HTTP
// ==================================================================

(async () => {
    await test("Fix 2 (unit): generateStorageFilename never incorporates any client-supplied string — it takes only a mimetype", () => {
        const name = imageSearchRouter.generateStorageFilename("image/jpeg");
        assert.match(name, /^[0-9a-f]{32}\.jpg$/);
    });

    await test("Fix 2 (unit): generateStorageFilename output never contains a path separator or '..' for any known or unknown mimetype", () => {
        const inputs = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/x-evil", "../../../etc/passwd", undefined, ""];
        for (const mt of inputs) {
            const name = imageSearchRouter.generateStorageFilename(mt);
            assert.ok(!name.includes("/"), `filename for ${mt} contained '/'`);
            assert.ok(!name.includes("\\"), `filename for ${mt} contained '\\'`);
            assert.ok(!name.includes(".."), `filename for ${mt} contained '..'`);
            assert.ok(!name.includes("\0"), `filename for ${mt} contained a null byte`);
        }
    });

    await test("Fix 2 (unit): path.join(UPLOAD_DIR, generatedFilename) always stays inside UPLOAD_DIR", () => {
        for (let i = 0; i < 20; i++) {
            const name = imageSearchRouter.generateStorageFilename("image/png");
            const resolved = path.resolve(imageSearchRouter.UPLOAD_DIR, name);
            assert.ok(resolved.startsWith(imageSearchRouter.UPLOAD_DIR + path.sep), `escaped UPLOAD_DIR: ${resolved}`);
        }
    });

    await test("Fix 3B (unit): hasValidImageSignature accepts real JPEG magic bytes", async () => {
        const tmp = path.join(require("os").tmpdir(), `sig-test-${Date.now()}.jpg`);
        fs.writeFileSync(tmp, JPEG_BYTES);
        try {
            assert.strictEqual(await imageSearchRouter.hasValidImageSignature(tmp), true);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    await test("Fix 3B (unit): hasValidImageSignature accepts real PNG magic bytes", async () => {
        const tmp = path.join(require("os").tmpdir(), `sig-test-${Date.now()}.png`);
        fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
        try {
            assert.strictEqual(await imageSearchRouter.hasValidImageSignature(tmp), true);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    await test("Fix 3B (unit): hasValidImageSignature rejects a plain text file even with a .jpg name", async () => {
        const tmp = path.join(require("os").tmpdir(), `sig-test-${Date.now()}-fake.jpg`);
        fs.writeFileSync(tmp, "this is not an image, just text pretending to be one");
        try {
            assert.strictEqual(await imageSearchRouter.hasValidImageSignature(tmp), false);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    await test("Fix 3C (unit): cleanupUpload removes an existing file", async () => {
        const tmp = path.join(require("os").tmpdir(), `cleanup-test-${Date.now()}.jpg`);
        fs.writeFileSync(tmp, "x");
        await imageSearchRouter.cleanupUpload(tmp);
        assert.strictEqual(fs.existsSync(tmp), false);
    });

    await test("Fix 3C (unit): cleanupUpload does not throw for an already-missing file", async () => {
        await imageSearchRouter.cleanupUpload(path.join(require("os").tmpdir(), "does-not-exist-at-all.jpg"));
    });

    // ==================================================================
    // Integration tests — real HTTP over the loopback interface, real
    // multer parsing, vision/search stubbed (no network)
    // ==================================================================

    await test("Integration: a genuine JPEG upload is accepted, processed, and cleaned up afterward", async () => {
        visionStub = async () => ({ brand: "Sony", productName: "WH-1000XM5" });
        searchStub = async () => [{ store: "Amazon", price: "36999" }];
        await withServer(async (port) => {
            const r = await postMultipart(port, { name: "image", filename: "photo.jpg", contentType: "image/jpeg", data: JPEG_BYTES });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.json?.success, true);
            assert.deepStrictEqual(uploadsDirEntries(), []);
        });
    });

    await test("Integration: an unsupported declared file type (text/plain) is rejected with a clean JSON error and never written to disk", async () => {
        await withServer(async (port) => {
            const r = await postMultipart(port, { name: "image", filename: "notes.txt", contentType: "text/plain", data: Buffer.from("hello") });
            assert.strictEqual(r.status, 400);
            assert.ok(r.json && typeof r.json.error === "string");
            assert.deepStrictEqual(uploadsDirEntries(), []);
        });
    });

    await test("Integration: a file declared as image/jpeg but containing non-image bytes is rejected by the magic-byte check, not silently forwarded", async () => {
        await withServer(async (port) => {
            const r = await postMultipart(port, {
                name: "image",
                filename: "fake.jpg",
                contentType: "image/jpeg",
                data: Buffer.from("definitely not a jpeg, just plain bytes"),
            });
            assert.strictEqual(r.status, 400);
            assert.deepStrictEqual(uploadsDirEntries(), []);
        });
    });

    await test("Integration: a crafted path-traversal filename ('../../../../tmp/evil.jpg') never escapes UPLOAD_DIR and never creates a file outside it", async () => {
        const outsideTarget = path.join("/tmp", "phase18-evil-traversal-probe.jpg");
        if (fs.existsSync(outsideTarget)) fs.unlinkSync(outsideTarget);
        visionStub = async () => ({ brand: "Sony", productName: "WH-1000XM5" });
        searchStub = async () => [];
        await withServer(async (port) => {
            const r = await postMultipart(port, {
                name: "image",
                filename: "../../../../tmp/phase18-evil-traversal-probe.jpg",
                contentType: "image/jpeg",
                data: JPEG_BYTES,
            });
            // The request itself should still succeed (it's a valid JPEG) —
            // the important assertion is WHERE it was written, not whether
            // upload succeeded.
            assert.strictEqual(r.status, 200);
            assert.strictEqual(fs.existsSync(outsideTarget), false, "traversal target was created outside UPLOAD_DIR");
            assert.deepStrictEqual(uploadsDirEntries(), [], "file was not cleaned up from UPLOAD_DIR after processing");
        });
    });

    await test("Integration: an oversized upload is rejected with 413 and a clean JSON error, not a crash or hang", async () => {
        // Force a tiny limit for this one test by re-requiring the module with
        // the env override in place, isolated to this test only.
        const savedEnv = process.env.MAX_IMAGE_UPLOAD_BYTES;
        process.env.MAX_IMAGE_UPLOAD_BYTES = "1000";
        delete require.cache[require.resolve(imageSearchPath)];
        const tinyLimitRouter = require(imageSearchPath);
        try {
            assert.strictEqual(tinyLimitRouter.MAX_UPLOAD_BYTES, 1000);
            const app = express();
            app.use("/api/search-image", tinyLimitRouter);
            const server = app.listen(0);
            const port = server.address().port;
            try {
                const bigData = Buffer.alloc(5000, 1);
                const r = await postMultipart(port, { name: "image", filename: "big.jpg", contentType: "image/jpeg", data: bigData });
                assert.strictEqual(r.status, 413);
                assert.ok(r.json && typeof r.json.error === "string");
            } finally {
                await new Promise((resolve) => server.close(resolve));
            }
        } finally {
            if (savedEnv === undefined) delete process.env.MAX_IMAGE_UPLOAD_BYTES;
            else process.env.MAX_IMAGE_UPLOAD_BYTES = savedEnv;
            delete require.cache[require.resolve(imageSearchPath)];
        }
    });

    await test("Integration: cleanup still happens when downstream processing (Gemini) throws", async () => {
        visionStub = async () => {
            throw new Error("simulated Gemini failure");
        };
        await withServer(async (port) => {
            const r = await postMultipart(port, { name: "image", filename: "photo.jpg", contentType: "image/jpeg", data: JPEG_BYTES });
            assert.strictEqual(r.status, 500);
            assert.ok(r.json && typeof r.json.error === "string");
            assert.deepStrictEqual(uploadsDirEntries(), [], "upload was not cleaned up after a downstream failure");
        });
        visionStub = async () => ({ brand: "Sony", productName: "WH-1000XM5" }); // restore for any later tests
    });

    await test("Integration: a low-confidence / unusable identification (422) still cleans up the upload", async () => {
        visionStub = async () => ({ brand: "unknown", productName: "n/a" });
        await withServer(async (port) => {
            const r = await postMultipart(port, { name: "image", filename: "photo.jpg", contentType: "image/jpeg", data: JPEG_BYTES });
            assert.strictEqual(r.status, 422);
            assert.deepStrictEqual(uploadsDirEntries(), []);
        });
        visionStub = async () => ({ brand: "Sony", productName: "WH-1000XM5" }); // restore
    });

})().then(() => {
    // Restore the original require after this file's tests (defensive —
    // this process exits right after anyway, but keeps the pattern honest).
    Module.prototype.require = originalRequire;

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
});
