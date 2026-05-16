// ─── functions/index.js ───────────────────────────────────
// Function 1: onAudioUploaded — audio analysis (Storage trigger)
// Function 2: identifyBookCover — Gemini book cover identification
// Function 3: verifyChildCode — anonymous child auth via child code
// Function 4: verifyFamilyCode — anonymous guest auth via family code
// Function 5: setParentClaims — parent custom-claims bootstrap
// ──────────────────────────────────────────────────────────

const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { analyzeFromPCM } = require("./analysis-engine");

admin.initializeApp();
const db = admin.firestore();
const storage = admin.storage();

// ══════════════════════════════════════════
// HELPER: Decode audio blob to PCM using ffmpeg
// ══════════════════════════════════════════

async function decodeAudioToPCM(bucket, filePath) {
  const tempInput = path.join(os.tmpdir(), `input_${Date.now()}`);
  const tempOutput = path.join(os.tmpdir(), `output_${Date.now()}.pcm`);
  try {
    await bucket.file(filePath).download({ destination: tempInput });
    execSync(
      `ffmpeg -y -i "${tempInput}" -ac 1 -ar 16000 -f f32le "${tempOutput}"`,
      { stdio: "pipe", timeout: 30000 }
    );
    const rawBuffer = fs.readFileSync(tempOutput);
    const samples = new Float32Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 4);
    return { samples, sampleRate: 16000 };
  } finally {
    try { fs.unlinkSync(tempInput); } catch (e) { /* ok */ }
    try { fs.unlinkSync(tempOutput); } catch (e) { /* ok */ }
  }
}

// ══════════════════════════════════════════
// HELPER: Find session doc by audio path
// ══════════════════════════════════════════

async function findSessionByAudioPath(filePath) {
  const audioFields = [
    "audioPath_min1", "audioPath_min2", "audioPath_min5",
    "audioPath_min8", "audioPath_min9", "audioPath_min10", "audioPath_min13",
    "audioPath"
  ];
  for (const field of audioFields) {
    const snap = await db.collection("sessions")
      .where(field, "==", filePath)
      .limit(1)
      .get();
    if (!snap.empty) {
      return { docId: snap.docs[0].id, session: snap.docs[0].data(), matchedField: field };
    }
  }
  return null;
}

// ══════════════════════════════════════════
// HELPER: Extract snippet key from file path
// ══════════════════════════════════════════

function extractSnippetKey(filePath) {
  const fileName = path.basename(filePath).split(".")[0];
  const keyMap = {
    "hljod_30s": "min1", "hljod_1": "min1", "hljod_2m": "min2",
    "hljod_5": "min5", "hljod_5m": "min5", "hljod_8m": "min8",
    "hljod_9": "min9", "hljod_10m": "min10", "hljod_13": "min13"
  };
  return keyMap[fileName] || fileName;
}

// ══════════════════════════════════════════
// FUNCTION 1: onAudioUploaded
// ══════════════════════════════════════════

exports.onAudioUploaded = onObjectFinalized({
  bucket: "lesum-22e85.firebasestorage.app",
  region: "europe-west1",
  timeoutSeconds: 120,
  memory: "512MiB"
}, async (event) => {
  const filePath = event.data.name;
  if (!filePath.startsWith("recordings/")) return;

  logger.info("Greining byrjar:", filePath);

  try {
    const sessionMatch = await findSessionByAudioPath(filePath);
    if (!sessionMatch) { logger.warn("Fann ekki session fyrir:", filePath); return; }

    const { docId, matchedField } = sessionMatch;
    const snippetKey = extractSnippetKey(filePath);
    logger.info(`Session: ${docId}, snippet: ${snippetKey}, field: ${matchedField}`);

    const bucket = storage.bucket("lesum-22e85.firebasestorage.app");
    const { samples, sampleRate } = await decodeAudioToPCM(bucket, filePath);
    logger.info(`Decoded: ${samples.length} samples @ ${sampleRate}Hz (${(samples.length / sampleRate).toFixed(1)}s)`);

    const result = analyzeFromPCM(samples, sampleRate);
    logger.info(`Greining lokið: ${result.sessionSummary.syllables} atkvæði, artRate=${result.sessionSummary.articulationRate}, usable=${result.usability.usable}`);

    await db.collection("sessions").doc(docId).set({
      analysisRaw: {
        [snippetKey]: {
          summary: result.sessionSummary,
          usability: result.usability,
          snippets: result.snippets,
          rawMetrics: result.rawMetrics,
          audioPath: filePath,
          sampleRate,
          durationSec: result.sessionSummary.sessionDuration,
          analyzedAt: new Date().toISOString()
        }
      }
    }, { merge: true });

    logger.info(`Greining vistuð á session ${docId}, snippet ${snippetKey}`);
  } catch (err) {
    logger.error("Villa í greiningu:", err.message, err.stack);
    try {
      const sessionMatch = await findSessionByAudioPath(filePath);
      if (sessionMatch) {
        await db.collection("sessions").doc(sessionMatch.docId).set({
          analysisRaw: { [extractSnippetKey(filePath)]: { error: err.message, analyzedAt: new Date().toISOString() } }
        }, { merge: true });
      }
    } catch (writeErr) { logger.error("Gat ekki skráð villu:", writeErr.message); }
  }
});

// ══════════════════════════════════════════
// FUNCTION 2: identifyBookCover
// ══════════════════════════════════════════

const { VertexAI } = require("@google-cloud/vertexai");

const vertexAI = new VertexAI({
  project: "lesum-22e85",
  location: "europe-west3",
});

const geminiModel = vertexAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: {
      type: "OBJECT",
      properties: {
        title: { type: "STRING", description: "Book title as printed on cover" },
        author: { type: "STRING", description: "Author name as printed on cover" },
      },
      required: ["title", "author"],
    },
    temperature: 0.1,
  },
});

exports.identifyBookCover = onCall(
  { region: "europe-west1", cors: true, maxInstances: 10, timeoutSeconds: 30 },
  async (request) => {
    const { gsPath } = request.data;
    if (!gsPath || !gsPath.startsWith("gs://")) {
      throw new HttpsError("invalid-argument", "gsPath required (gs://...)");
    }

    try {
      // Les mynd úr Storage
      const pathParts = gsPath.replace("gs://", "").split("/");
      const bucketName = pathParts.shift();
      const filePath = pathParts.join("/");
      const bucket = storage.bucket(bucketName);
      const [fileBuffer] = await bucket.file(filePath).download();
      const base64 = fileBuffer.toString("base64");

      logger.info("identifyBookCover: analyzing", filePath, `(${Math.round(base64.length * 0.75 / 1024)}KB)`);

      // Kalla Gemini með structured output
      const result = await geminiModel.generateContent({
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: base64 } },
            { text: "Read the title and author from this book cover." },
          ],
        }],
      });

      const text = result.response.candidates[0].content.parts[0].text;
      const json = JSON.parse(text);
      logger.info("identifyBookCover: result", json);
      return { title: json.title || "", author: json.author || "" };
    } catch (e) {
      logger.error("identifyBookCover error:", e.message, e.stack);
      throw new HttpsError("internal", "Failed to identify book cover");
    }
  }
);

// ══════════════════════════════════════════
// AUTH HELPERS — rate limiting (per-instance, in-memory)
// ══════════════════════════════════════════

const _rateLimits = new Map();
function checkRateLimit(uid, prefix, max = 5, windowMs = 60000) {
  const key = `${prefix}:${uid}`;
  const now = Date.now();
  const entry = _rateLimits.get(key) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
  entry.count++;
  _rateLimits.set(key, entry);
  if (entry.count > max) {
    throw new HttpsError("resource-exhausted", "Of margar tilraunir. Reyndu aftur eftir smá stund.");
  }
}

// ══════════════════════════════════════════
// FUNCTION 3: verifyChildCode
// ══════════════════════════════════════════
// Caller: anonymous Firebase user (signed in on index.html before calling)
// Action: verifies code against 'codes' collection, sets custom claims on caller
// Returns: { ok, familyId, childKey, childName }

exports.verifyChildCode = onCall(
  { region: "europe-west1", maxInstances: 10 },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Innskráning vantar.");
    }

    const { code } = request.data;
    if (!code || typeof code !== "string") {
      throw new HttpsError("invalid-argument", "Kóðinn vantar.");
    }

    const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalizedCode.length < 4) {
      throw new HttpsError("invalid-argument", "Kóðinn er of stuttur.");
    }

    checkRateLimit(request.auth.uid, "child");

    const snap = await db.collection("codes").doc(normalizedCode).get();
    if (!snap.exists || snap.data()?.deleted) {
      throw new HttpsError("not-found", "Kóðinn fannst ekki — athugaðu með foreldri.");
    }

    const data = snap.data();

    await admin.auth().setCustomUserClaims(request.auth.uid, {
      role: "child",
      familyId: data.familyId,
      childKey: data.childKey,
      childName: data.childName || "",
    });

    return {
      ok: true,
      familyId: data.familyId,
      childKey: data.childKey,
      childName: data.childName || "",
    };
  }
);

// ══════════════════════════════════════════
// FUNCTION 4: verifyFamilyCode
// ══════════════════════════════════════════
// Caller: anonymous Firebase user
// Action: verifies family code, sets guest claims, returns children list
// Returns: { ok, familyId, children }

exports.verifyFamilyCode = onCall(
  { region: "europe-west1", maxInstances: 10 },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Innskráning vantar.");
    }

    const { code, guestName, guestRole } = request.data;
    if (!code || typeof code !== "string") {
      throw new HttpsError("invalid-argument", "Kóðinn vantar.");
    }
    if (!guestName || typeof guestName !== "string") {
      throw new HttpsError("invalid-argument", "Nafnið vantar.");
    }

    const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalizedCode.length < 4) {
      throw new HttpsError("invalid-argument", "Kóðinn er of stuttur.");
    }

    checkRateLimit(request.auth.uid, "fam");

    const snap = await db.collection("familycodes").doc(normalizedCode).get();
    if (!snap.exists || snap.data()?.deleted) {
      throw new HttpsError("not-found", "Kóðinn fannst ekki — athugaðu með fjölskyldumeðlim.");
    }

    const data = snap.data();

    let children = [];
    if (data.parentUid) {
      const userSnap = await db.collection("users").doc(data.parentUid).get();
      if (userSnap.exists) {
        children = userSnap.data()?.children || [];
      }
    }

    await admin.auth().setCustomUserClaims(request.auth.uid, {
      role: "guest",
      familyId: data.familyId,
      familyCode: normalizedCode,
      guestName: String(guestName).slice(0, 50),
      guestRole: String(guestRole || "").slice(0, 20),
    });

    return { ok: true, familyId: data.familyId, children };
  }
);

// ══════════════════════════════════════════
// FUNCTION 5: setParentClaims
// ══════════════════════════════════════════
// Caller: authenticated parent (email/password Firebase user)
// Action: reads familyId from users/{uid}, sets parent claims on caller
// Returns: { ok }

exports.setParentClaims = onCall(
  { region: "europe-west1", maxInstances: 10 },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Innskráning vantar.");
    }

    // Only real (non-anonymous) users can be parents
    const userRecord = await admin.auth().getUser(request.auth.uid);
    if (!userRecord.providerData?.length) {
      throw new HttpsError("permission-denied", "Aðeins foreldrar geta notað þessa aðgerð.");
    }

    const snap = await db.collection("users").doc(request.auth.uid).get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Notandinn finnst ekki í gagnagrunni.");
    }

    const data = snap.data();
    if (!data.familyId) {
      throw new HttpsError("failed-precondition", "Fjölskylduauðkenni vantar í prófíl.");
    }

    await admin.auth().setCustomUserClaims(request.auth.uid, {
      role: "parent",
      familyId: data.familyId,
    });

    return { ok: true };
  }
);
