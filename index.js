// Load environment variables from .env file for local development
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
// Use a larger limit for the request body to handle base64 image data
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const OPENAI_API_URL = "https://api.openai.com/v1/responses";

// Health check endpoint to verify the server is running
app.get('/', (req, res) => {
  res.send('Toonmu Backend is running!');
});

// The main endpoint for generating toons
app.post('/generate-toon', async (req, res) => {
  console.log("Received request for /generate-toon");

  // 1. Validate and parse the incoming request body
  const { imageDataUrl, stylePrompt } = req.body;
  if (!imageDataUrl || !stylePrompt) {
    console.error("Validation Error: Missing imageDataUrl or stylePrompt");
    return res.status(400).json({ error: "Missing imageDataUrl or stylePrompt" });
  }

  // 2. Retrieve the OpenAI API key securely
  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) {
    console.error("Server Configuration Error: Missing OPENAI_API_KEY");
    return res.status(500).json({ error: "Server configuration error." });
  }

  // 3. Construct the request to OpenAI
  const userText = `Restyle this image in the following art style: ${stylePrompt}. Keep composition, subjects, and details.`;
  const body = {
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: userText },
          { type: "input_image", image_url: imageDataUrl }
        ]
      }
    ],
    tools: [{ type: "image_generation" }]
  };

  try {
    // 4. Call the OpenAI API
    console.log("Forwarding request to OpenAI API...");
    const openAIResponse = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openAIKey}`
      },
      body: JSON.stringify(body)
    });

    const responseData = await openAIResponse.json();

    if (!openAIResponse.ok) {
      console.error('OpenAI API error:', responseData);
      return res.status(openAIResponse.status).json({ error: responseData.error?.message || "OpenAI API request failed" });
    }

    // 5. Extract the generated image data
    const imageGenerationOutput = responseData.output?.find((o) => o.type === 'image_generation_call');
    if (!imageGenerationOutput || !imageGenerationOutput.result) {
      console.error("Extraction Error: Could not find generated image in OpenAI response.");
      return res.status(500).json({ error: 'Could not find generated image in OpenAI response.' });
    }

    // 6. Return the image data to the app
    console.log("Successfully generated toon, sending response to app.");
    res.status(200).json({ toonImageData: imageGenerationOutput.result });

  } catch (error) {
    console.error("An unexpected error occurred:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 