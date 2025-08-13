require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { fal } = require('@fal-ai/client');

// --- Initialization ---
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
fal.config({ credentials: process.env.FAL_KEY });


async function generateWithOpenAI(imageDataUrl, stylePrompt) {
  const userText = `Restyle this image in the following art style: ${stylePrompt}. Keep composition, subjects, and details.`;
  const body = {
    model: "gpt-4o-mini",
    input: [{ role: "user", content: [
      { type: "input_text", text: userText },
      { type: "input_image", image_url: imageDataUrl }
    ] }],
    tools: [{ type: "image_generation" }]
  };
  const r = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "OpenAI API request failed");
  const node = data.output?.find(o => o.type === 'image_generation_call');
  if (!node?.result) throw new Error('OpenAI: no image result');
  return Buffer.from(node.result, 'base64');
}

async function generateWithFALKontext(imageDataUrl, stylePrompt) {
  const userText = `Restyle this image in the following art style: ${stylePrompt}. Keep composition, subjects, and details.`;
  const result = await fal.subscribe("fal-ai/flux-pro/kontext", {
    input: { prompt: userText, image_url: imageDataUrl, output_format: "png" },
    logs: false
  });
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('FAL: no image url');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('FAL: fetch image failed');
  return Buffer.from(await resp.arrayBuffer());
}

// --- Background Processing Function ---
const processGeneration = async (creationId, imageDataUrl, stylePrompt, userId) => {
  try {
    let imageBuffer;
    try {
      console.log(`[${creationId}] OpenAI attempt...`);
      imageBuffer = await generateWithOpenAI(imageDataUrl, stylePrompt);
    } catch (e) {
      console.warn(`[${creationId}] OpenAI failed (${e.message}). Falling back to FAL Kontext...`);
      imageBuffer = await generateWithFALKontext(imageDataUrl, stylePrompt);
    }

    console.log(`[${creationId}] Uploading result to Supabase Storage...`);
    const filePath = `${userId}/${creationId}.png`;
    const { error: uploadError } = await supabase.storage
      .from('creations')
      .upload(filePath, imageBuffer, { contentType: 'image/png', upsert: true });
    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage.from('creations').getPublicUrl(filePath);
    await supabase
      .from('toon_creations')
      .update({ status: 'completed', image_url: publicUrl })
      .eq('id', creationId);
    console.log(`[${creationId}] Generation successful.`);

  } catch (error) {
    console.error(`[${creationId}] Generation failed:`, error);
    await supabase
      .from('toon_creations')
      .update({ status: 'failed', error_message: error.message })
      .eq('id', creationId);
  }
};

// --- API Endpoints ---

app.get('/', (req, res) => {
  res.send('Toonmu Backend is running!');
});

// Endpoint to start a generation job
app.post('/generate-toon', async (req, res) => {
  console.log("Received request for /generate-toon");

  const { imageDataUrl, stylePrompt, userId } = req.body;
  if (!imageDataUrl || !stylePrompt || !userId) {
    return res.status(400).json({ error: "Missing imageDataUrl, stylePrompt, or userId" });
  }

  // 1. Immediately insert a "pending" record into the database
  const { data, error } = await supabase
    .from('toon_creations')
    .insert({
      user_id: userId,
      style_name: stylePrompt, // Using the full prompt as the style name for now
      status: 'pending'
    })
    .select('id')
    .single();

  if (error) {
    console.error("Failed to create job record:", error);
    return res.status(500).json({ error: "Could not create generation record." });
  }

  const creationId = data.id;
  console.log(`[${creationId}] Job created for user ${userId}.`);

  // 2. Return the ID to the app immediately
  res.status(202).json({ creationId: creationId });

  // 3. Start the actual processing in the background (fire and forget)
  processGeneration(creationId, imageDataUrl, stylePrompt, userId);
});

// Endpoint for the app to poll for status
app.get('/creation-status/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('toon_creations')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "Creation not found." });
  }

  res.status(200).json(data);
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

