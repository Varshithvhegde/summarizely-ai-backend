require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { 
  redis, 
  searchArticlesByTopic, 
  searchArticlesBySentiment, 
  getAllArticles,
  createSearchIndex,
  findSimilarArticles
} = require('./redisClient');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize search index on startup
createSearchIndex();

// Pagination helper function
function getPaginationParams(req) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  
  return { page, limit, offset };
}

// Create pagination response
function createPaginatedResponse(articles, totalCount, page, limit, req) {
  const totalPages = Math.ceil(totalCount / limit);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;
  
  // Build base URL for pagination links
  const baseUrl = `${req.protocol}://${req.get('host')}${req.path}`;
  const queryParams = new URLSearchParams(req.query);
  
  // Remove page from query params for link building
  queryParams.delete('page');
  const baseQuery = queryParams.toString();
  
  return {
    data: articles,
    pagination: {
      currentPage: page,
      totalPages,
      totalCount,
      limit,
      hasNext,
      hasPrev,
      nextPage: hasNext ? page + 1 : null,
      prevPage: hasPrev ? page - 1 : null,
      links: {
        first: `${baseUrl}?${baseQuery ? baseQuery + '&' : ''}page=1`,
        last: `${baseUrl}?${baseQuery ? baseQuery + '&' : ''}page=${totalPages}`,
        next: hasNext ? `${baseUrl}?${baseQuery ? baseQuery + '&' : ''}page=${page + 1}` : null,
        prev: hasPrev ? `${baseUrl}?${baseQuery ? baseQuery + '&' : ''}page=${page - 1}` : null
      }
    }
  };
}

// Get news by topic (with pagination)
app.get('/api/news/topic/:topic', async (req, res) => {
  try {
    const { topic } = req.params;
    const { page, limit, offset } = getPaginationParams(req);
    
    const result = await searchArticlesByTopic(topic, limit, offset);
    const response = createPaginatedResponse(
      result.articles, 
      result.totalCount, 
      page, 
      limit, 
      req
    );
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching news by topic:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// Get news by sentiment (with pagination)
app.get('/api/news/sentiment/:sentiment', async (req, res) => {
  try {
    const { sentiment } = req.params;
    const { page, limit, offset } = getPaginationParams(req);
    
    const result = await searchArticlesBySentiment(sentiment, limit, offset);
    const response = createPaginatedResponse(
      result.articles, 
      result.totalCount, 
      page, 
      limit, 
      req
    );
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching news by sentiment:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// Search news with custom query (with pagination)
app.get('/api/news/search', async (req, res) => {
  try {
    // console.log(req.query);
    const { q, sentiment, source, topic } = req.query;
    const { page, limit, offset } = getPaginationParams(req);
    
    // Handle different filter combinations
    const hasSearchFilters = q || sentiment || source;
    const hasTopic = topic;
    
    // Case 1: Only topic is present - use topic search
    if (hasTopic && !hasSearchFilters) {
      const result = await searchArticlesByTopic(topic, limit, offset);
      const response = createPaginatedResponse(
        result.articles, 
        result.totalCount, 
        page, 
        limit, 
        req
      );
      return res.json(response);
    }
    
    // Case 2: Both topic and search filters are present - use intersection approach
    if (hasTopic && hasSearchFilters) {
      return await handleSearchWithTopic(req, res, { q, sentiment, source, topic }, { page, limit, offset });
    }
    
    // Case 3: Only search filters are present (no topic) - use regular search
    if (hasSearchFilters && !hasTopic) {
      // Build query parts for regular search
      const queryParts = [];
      
      if (q) {
        // Search in multiple fields with OR logic
        const searchQuery = [
          `@title:${q}`,
          `@description:${q}`,
          `@content:${q}`,
          `@summary:${q}`,
        ].join(' | ');
        queryParts.push(`(${searchQuery})`);
      }
      
      if (sentiment) {
        queryParts.push(`@sentiment:{${sentiment}}`);
      }
      
      if (source) {
        queryParts.push(`@source:{${source}}`);
      }
      
      // Combine all query parts with AND logic
      const query = queryParts.join(' ');
      
      // Get total count first
      const countResults = await redis.ft.search(
        'idx:news',
        query,
        { 
          LIMIT: { from: 0, size: 0 } // Only get count
        }
      );
      
      const totalCount = countResults.total || 0;
      
      // Get paginated results
      const results = await redis.ft.search(
        'idx:news',
        query,
        { 
          SORTBY: { BY: 'publishedAt', DIRECTION: 'DESC' }, 
          LIMIT: { from: offset, size: limit } 
        }
      );

      const articles = results.documents.map(doc => doc.value);
      const response = createPaginatedResponse(articles, totalCount, page, limit, req);
      
      return res.json(response);
    }
    
    // Case 4: No filters provided - return all articles (same as /api/news)
    const result = await getAllArticles(limit, offset);
    const response = createPaginatedResponse(
      result.articles, 
      result.totalCount, 
      page, 
      limit, 
      req
    );
    
    res.json(response);
  } catch (error) {
    console.error('Error searching news:', error);
    res.status(500).json({ error: 'Failed to search news' });
  }
});

// Helper function to handle search with topic intersection
async function handleSearchWithTopic(req, res, filters, pagination) {
  try {
    const { q, sentiment, source, topic } = filters;
    const { page, limit, offset } = pagination;
    
    // Build search query (excluding topic)
    const queryParts = [];
    
    if (q) {
      const searchQuery = [
        `@title:${q}`,
        `@description:${q}`,
        `@content:${q}`,
        `@summary:${q}`,
      ].join(' | ');
      queryParts.push(`(${searchQuery})`);
    }
    
    if (sentiment) {
      queryParts.push(`@sentiment:{${sentiment}}`);
    }
    
    if (source) {
      queryParts.push(`@source:{${source}}`);
    }
    
    const searchQuery = queryParts.length > 0 ? queryParts.join(' ') : '*';
    
    // Get all search results (we need all for intersection)
    const searchResults = await redis.ft.search(
      'idx:news',
      searchQuery,
      { 
        SORTBY: { BY: 'publishedAt', DIRECTION: 'DESC' },
        LIMIT: { from: 0, size: 1000 } // Get more results for better intersection
      }
    );
    
    // Get all topic results
    const topicResults = await searchArticlesByTopic(topic, 1000, 0);
    
    // Create sets for efficient intersection
    const searchIds = new Set(searchResults.documents.map(doc => doc.value.id));
    const topicIds = new Set(topicResults.articles.map(article => article.id));
    
    // Find intersection
    const intersectionIds = new Set();
    for (const id of searchIds) {
      if (topicIds.has(id)) {
        intersectionIds.add(id);
      }
    }
    
    // Convert back to full articles and sort by publishedAt
    const intersectionArticles = searchResults.documents
      .map(doc => doc.value)
      .filter(article => intersectionIds.has(article.id))
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    
    // Apply pagination to intersection results
    const totalCount = intersectionArticles.length;
    const paginatedArticles = intersectionArticles.slice(offset, offset + limit);
    
    const response = createPaginatedResponse(paginatedArticles, totalCount, page, limit, req);
    
    res.json(response);
  } catch (error) {
    console.error('Error in search with topic intersection:', error);
    res.status(500).json({ error: 'Failed to search news with topic' });
  }
}

// Get a single article by ID
app.get('/api/news/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const key = `news:${id}`;
    const article = await redis.json.get(key);
    
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    
    res.json(article);
  } catch (error) {
    console.error('Error fetching article:', error);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

// Get similar articles using Redis Vector Search (with pagination)
app.get('/api/news/:id/similar', async (req, res) => {
  try {
    console.log(req.params);
    const { id } = req.params;
    const { page, limit, offset } = getPaginationParams(req);
    
    const result = await findSimilarArticles(id, limit, offset);
    const response = createPaginatedResponse(
      result.articles, 
      result.totalCount, 
      page, 
      limit, 
      req
    );
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching similar articles:', error);
    res.status(500).json({ error: 'Failed to fetch similar articles' });
  }
});

// Get all news articles (with pagination)
app.get('/api/news', async (req, res) => {
  try {
    console.log("Getting paginated news articles");
    const { page, limit, offset } = getPaginationParams(req);
    
    const result = await getAllArticles(limit, offset);
    const response = createPaginatedResponse(
      result.articles, 
      result.totalCount, 
      page, 
      limit, 
      req
    );
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// Get available topics
app.get('/api/topics', async (req, res) => {
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
  res.json(topics);
});

// Get available sentiments
app.get('/api/sentiments', async (req, res) => {
  const sentiments = ['positive', 'negative', 'neutral'];
  res.json(sentiments);
});

// Get available sources (with pagination)
app.get('/api/sources', async (req, res) => {
  try {
    const { page, limit, offset } = getPaginationParams(req);
    
    const results = await redis.ft.aggregate(
      'idx:news',
      '*',
      {
        GROUPBY: { REDUCE: 'COUNT', BY: '@source' },
        SORTBY: { BY: '@__key', DIRECTION: 'DESC' },
        LIMIT: { from: offset, size: limit }
      }
    );
    
    // Get total count of sources
    const totalResults = await redis.ft.aggregate(
      'idx:news',
      '*',
      {
        GROUPBY: { REDUCE: 'COUNT', BY: '@source' }
      }
    );
    
    const sources = results.results.map(result => result.source);
    const totalCount = totalResults.results.length;
    
    const response = createPaginatedResponse(sources, totalCount, page, limit, req);
    res.json(response);
  } catch (error) {
    console.error('Error fetching sources:', error);
    res.json({
      data: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalCount: 0,
        limit: 10,
        hasNext: false,
        hasPrev: false
      }
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

module.exports = app;