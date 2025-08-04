require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// --- Initialization ---
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);


// --- Background Processing Function ---
const processGeneration = async (creationId, imageDataUrl, stylePrompt, userId) => {
  try {
    // 1. Construct the request to OpenAI
    const userText = `Restyle this image in the following art style: ${stylePrompt}. Keep composition, subjects, and details.`;
    const body = {
      model: "gpt-4o-mini",
      input: [{ role: "user", content: [{ type: "input_text", text: userText }, { type: "input_image", image_url: imageDataUrl }] }],
      tools: [{ type: "image_generation" }]
      // 'input_fidelity' has been removed as it was causing the error.
    };

    // 2. Call the OpenAI API
    console.log(`[${creationId}] Forwarding request to OpenAI...`);
    const openAIResponse = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body)
    });
    
    const responseData = await openAIResponse.json();

    if (!openAIResponse.ok) {
      throw new Error(responseData.error?.message || "OpenAI API request failed");
    }

    // 3. Extract the generated image data
    const imageBase64 = responseData.output?.find((o) => o.type === 'image_generation_call')?.result;
    if (!imageBase64) {
      throw new Error("Could not find generated image in OpenAI response.");
    }

    // 4. Upload the result to Supabase Storage
    console.log(`[${creationId}] Uploading result to Supabase Storage...`);
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const filePath = `${userId}/${creationId}.png`;
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('creations')
      .upload(filePath, imageBuffer, { contentType: 'image/png', upsert: true });
      
    if (uploadError) throw uploadError;

    // 5. Get public URL and update the record as "completed"
    const { data: { publicUrl } } = supabase.storage.from('creations').getPublicUrl(filePath);
    
    console.log(`[${creationId}] Generation successful. Updating status.`);
    await supabase
      .from('toon_creations')
      .update({ status: 'completed', image_url: publicUrl })
      .eq('id', creationId);

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

app.post('/generate-toon', async (req, res) => {
  console.log("Received request for /generate-toon");
  const { imageDataUrl, stylePrompt, userId } = req.body;
  if (!imageDataUrl || !stylePrompt || !userId) {
    return res.status(400).json({ error: "Missing imageDataUrl, stylePrompt, or userId" });
  }
  const { data, error } = await supabase
    .from('toon_creations')
    .insert({ user_id: userId, style_name: stylePrompt, status: 'pending' })
    .select('id')
    .single();

  if (error) {
    console.error("Failed to create job record:", error);
    return res.status(500).json({ error: "Could not create generation record." });
  }
  const creationId = data.id;
  console.log(`[${creationId}] Job created for user ${userId}.`);
  res.status(202).json({ creationId: creationId });
  processGeneration(creationId, imageDataUrl, stylePrompt, userId);
});

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
