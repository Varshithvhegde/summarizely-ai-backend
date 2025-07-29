require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function summarizeAndAnalyze(title, content) {
  const prompt = `Summarize the following news article in 2-3 sentences and provide its sentiment (positive, negative, or neutral).

Title: ${title}
Content: ${content}

Respond in JSON:
{
  "summary": "...",
  "sentiment": "..."
}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
    });
    
    const text = response.text;
    
    // Clean up the response - remove markdown code blocks if present
    let jsonText = text.trim();
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    return JSON.parse(jsonText);
  } catch (e) {
    console.error('Error calling Gemini API:', e);
    console.error('Raw response:', response?.text);
    return { summary: '', sentiment: 'neutral' };
  }
}

// Generate an embedding vector for a given text using Gemini
async function generateEmbedding(text) {
  try {
    const response = await ai.embeddings.create({
      model: "models/embedding-001",
      content: text,
    });
    // Gemini returns { embeddings: [ { values: [...] } ] }
    return response.embeddings[0].values;
  } catch (e) {
    console.error('Error generating embedding:', e);
    return [];
  }
}

module.exports = { summarizeAndAnalyze, generateEmbedding }; 