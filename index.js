const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs-extra");
const path = require("path");
const tmp = require("tmp");

const app = express();
const PORT = 4000;

const WORKFLOW_URL = "https://serverless.roboflow.com/traffic-9fffi/custom-workflow";
const API_KEY = "uRvyfuwUI6HgKCP2ixmw";

// Set up multer for file upload
const upload = multer({ dest: "uploads/" });

// Helper: Extract N frames per second from video to temporary folder
function extractFrames(videoPath, fps = 1) {
  return new Promise((resolve, reject) => {
    const framesDir = tmp.dirSync({ unsafeCleanup: true });
    ffmpeg(videoPath)
      .outputOptions([`-vf fps=${fps}`])
      .output(path.join(framesDir.name, "frame-%04d.png"))
      .on("end", () => {
        resolve(framesDir);
      })
      .on("error", err => reject(err))
      .run();
  });
}

// Helper: Send single frame to Roboflow workflow
async function sendFrameToRoboflow(base64Image) {
  const response = await fetch(`${WORKFLOW_URL}?api_key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64Image }),
  });
  if (!response.ok) throw new Error("Roboflow workflow API error");
  return response.json();
}

app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    const fps = 1; // Or pick a value that fits your use case
    const { path: videoPath } = req.file;

    // 1. Extract frames
    const framesDir = await extractFrames(videoPath, fps);
    const frameFiles = fs.readdirSync(framesDir.name)
      .filter(f => f.endsWith(".png"))
      .sort();

    let violationCount = 0;
    const frameOutputs = [];

    for (const file of frameFiles) {
      const framePath = path.join(framesDir.name, file);
      const base64Image = await fs.readFile(framePath, { encoding: "base64" });
      const result = await sendFrameToRoboflow(base64Image);

      // Assuming output_tracked_over_5min is the count you want
      if (result.output_tracked_over_5min && result.output_tracked_over_5min > 0) {
        violationCount += result.output_tracked_over_5min;
      }

      // Save processed images or collect them as needed (not shown here)
      frameOutputs.push(result);
    }

    // Clean up temp files
    fs.unlinkSync(videoPath);
    fs.removeSync(framesDir.name);

    // Respond with the violation count (and processed data if needed)
    res.json({
      tracked_objects: violationCount,
      outputs: frameOutputs // or just send what you need
      // video_url: ... // If you process and store a result video, send the URL here
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.toString() });
  }
});

// Endpoint: POST /process-video
app.post("/process-video", upload.single("video"), async (req, res) => {
  try {
    const fps = req.query.fps ? parseInt(req.query.fps) : 1; // 1 frame/sec default
    const { path: videoPath } = req.file;

    // 1. Extract frames
    const framesDir = await extractFrames(videoPath, fps);
    const frameFiles = fs.readdirSync(framesDir.name)
      .filter(f => f.endsWith(".png"))
      .sort(); // frame-0001.png, frame-0002.png...

    const outputs = [];

    // 2. Process each frame
    for (const file of frameFiles) {
      const framePath = path.join(framesDir.name, file);
      const base64Image = await fs.readFile(framePath, { encoding: "base64" });
      const result = await sendFrameToRoboflow(base64Image);
      outputs.push({ frame: file, ...result });
    }

    // 3. Cleanup
    fs.unlinkSync(videoPath);
    fs.removeSync(framesDir.name);

    // 4. Response
    res.json({ frames: outputs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.toString() });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});