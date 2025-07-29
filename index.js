require('dotenv').config();
const cron = require('node-cron');
const { fetchNews } = require('./newsFetcher');
const { summarizeAndAnalyze } = require('./geminiClient');
const { storeArticle, articleExists } = require('./redisClient');
const crypto = require('crypto');
const axios = require('axios');

async function generateEmbedding(text) {
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=' + process.env.GEMINI_API_KEY;
    const body = {
      content: { parts: [{ text }] }
    };
    const response = await axios.post(url, body);
    // The vector is in response.data.embedding.values
    return response.data.embedding.values;
  } catch (e) {
    console.error('Error generating embedding:', e?.response?.data || e);
    return [];
  }
}

async function processNews() {
  console.log('Fetching news for multiple topics...');
  
  // Popular topics to fetch news for
  const topics = [
    'India',
    'Technology', 
    'World',
    'Sports',
    'Business',
    'Entertainment',
    'Science',
    'Health'
  ];
  
  const allArticles = [];
  
  // Fetch news for each topic
  for (const topic of topics) {
    try {
      console.log(`Fetching news for: ${topic}`);
      const articles = await fetchNews(topic, 8); // 8 articles per topic
      allArticles.push(...articles);
    } catch (error) {
      console.error(`Error fetching news for ${topic}:`, error);
    }
  }
  
  console.log(`Total articles fetched: ${allArticles.length}`);
  
  // Process all articles
  for (const article of allArticles) {
    // Use a hash of title+publishedAt as unique ID
    const id = crypto.createHash('sha256').update(article.title + article.publishedAt).digest('hex');
    if (await articleExists(id)) {
      console.log(`Skipping duplicate: ${article.title}`);
      continue;
    }
    const { summary, sentiment } = await summarizeAndAnalyze(article.title, article.content || article.description || '');
    // Generate embedding vector for title + content
    const embeddingText = `${article.title} ${article.content || article.description || ''}`;
    const vector = await generateEmbedding(embeddingText);
    const newsObj = {
      id,
      title: article.title,
      content: article.content,
      summary,
      sentiment,
      source: article.source, // Save full source object
      publishedAt: article.publishedAt,
      url: article.url,
      urlToImage: article.urlToImage,
      vector,
      author: article.author || null,
      description: article.description || null
    };
    await storeArticle(newsObj);
    console.log(`Stored: ${article.title}`);
  }
}

// Run every 10 minutes
cron.schedule('*/10 * * * *', processNews);

// Run once at startup
processNews(); 