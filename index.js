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
    const userFolder = String(userId).toLowerCase();
    const filePath = `${userFolder}/${creationId}.png`;
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

// Secure account deletion (requires Supabase access token from client)
app.delete('/account', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const { data: userData, error: getUserError } = await supabase.auth.getUser(token);
    if (getUserError || !userData?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const userId = userData.user.id;

    // 1) Collect storage keys from DB before we delete DB rows
    const { data: creationRows } = await supabase
      .from('toon_creations')
      .select('image_url')
      .eq('user_id', userId);

    const extractKey = (url) => {
      try {
        if (!url) return null;
        const u = new URL(url);
        const path = decodeURIComponent(u.pathname);
        const markers = ['/object/public/creations/', '/storage/v1/object/public/creations/'];
        for (const m of markers) {
          const i = path.indexOf(m);
          if (i >= 0) return path.substring(i + m.length);
        }
        // fallback: if it already looks like a key
        if (!path.includes('/')) return path;
        return null;
      } catch { return null; }
    };

    const keysFromDB = (creationRows || [])
      .map(r => extractKey(r.image_url))
      .filter(Boolean);

    if (keysFromDB.length > 0) {
      const { data: removed, error: remErr } = await supabase.storage
        .from('creations')
        .remove(keysFromDB);
      if (remErr) {
        console.warn('[DELETE /account] Storage remove (from DB keys) error:', remErr);
      } else {
        console.log(`[DELETE /account] Removed ${Array.isArray(removed) ? removed.length : keysFromDB.length} files by DB keys`);
      }
    }

    // 2) Best-effort delete of profile row if present
    await supabase.from('profiles').delete().eq('id', userId);

    // 3) Delete Storage files under possible user folders (handle case mismatches)
    const candidates = Array.from(new Set([
      String(userId),
      String(userId).toLowerCase(),
      String(userId).toUpperCase()
    ]));
    let totalRemoved = 0;
    for (const folder of candidates) {
      const { data: files, error: listErr } = await supabase.storage
        .from('creations')
        .list(folder, { limit: 1000 });
      if (listErr) {
        console.warn(`[DELETE /account] Storage list error for ${folder}:`, listErr);
        continue;
      }
      if (files && files.length > 0) {
        const paths = files.map(f => `${folder}/${f.name}`);
        const { data: removed, error: remErr } = await supabase.storage.from('creations').remove(paths);
        if (remErr) {
          console.warn(`[DELETE /account] Storage remove error for ${folder}:`, remErr);
        } else {
          totalRemoved += Array.isArray(removed) ? removed.length : paths.length;
          console.log(`[DELETE /account] Removed ${Array.isArray(removed) ? removed.length : paths.length} files from ${folder}`);
        }
      }
    }

    // Also remove avatar files if any
    for (const folder of candidates) {
      const { data: files, error: listErr } = await supabase.storage
        .from('avatars')
        .list(folder, { limit: 1000 });
      if (!listErr && files && files.length > 0) {
        const paths = files.map(f => `${folder}/${f.name}`);
        await supabase.storage.from('avatars').remove(paths);
        console.log(`[DELETE /account] Removed ${paths.length} avatar files from ${folder}`);
      }
    }

    // 4) Delete DB rows owned by the user (after storage to preserve keys)
    await supabase.from('toon_creations').delete().eq('user_id', userId);

    // 3) Delete the auth user
    const { error: delErr } = await supabase.auth.admin.deleteUser(userId);
    if (delErr) {
      return res.status(500).json({ error: delErr.message || 'Failed to delete user' });
    }

    console.log(`[DELETE /account] Deleted user ${userId}`);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Delete account failed:', e);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
