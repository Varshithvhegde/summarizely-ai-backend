require('dotenv').config();
const { createClient } = require('redis');

const redis = createClient({ url: process.env.REDIS_URL });
redis.connect();

async function storeArticle(article) {
  const key = `news:${article.id}`;
  await redis.json.set(key, '$', article);
}

async function articleExists(id) {
  const key = `news:${id}`;
  const exists = await redis.exists(key);
  return exists === 1;
}

// Enhanced RedisSearch index with better similarity features
async function createSearchIndex() {
  try {
    // Check if index already exists
    const indexExists = await redis.ft.info('idx:news').catch(() => false);
    if (indexExists) {
      console.log('Search index already exists');
      return;
    }

    console.log('Creating enhanced RedisSearch index...');
    await redis.ft.create('idx:news', {
      '$.title': { 
        type: 'TEXT', 
        AS: 'title'
      },
      '$.description': { 
        type: 'TEXT', 
        AS: 'description'
      },
      '$.content': { 
        type: 'TEXT', 
        AS: 'content'
      },
      '$.summary': { 
        type: 'TEXT', 
        AS: 'summary'
      },
      '$.sentiment': { type: 'TAG', AS: 'sentiment' },
      '$.source.name': { type: 'TAG', AS: 'source' },
      '$.publishedAt': { type: 'TEXT', AS: 'publishedAt' },
      '$.category': { type: 'TAG', AS: 'category' },
      '$.id': { type: 'TAG', AS: 'article_id' }
    }, { 
      ON: 'JSON', 
      PREFIX: 'news:'
    });
    
    console.log('Enhanced search index created successfully');
  } catch (error) {
    if (error.message.includes('Index already exists')) {
      console.log('Search index already exists');
    } else {
      console.error('Error creating search index:', error);
    }
  }
}

// Search articles by topic using RedisSearch (with pagination)
async function searchArticlesByTopic(topic, limit = 10, offset = 0) {
  try {
    // Build proper search query for multiple fields
    const searchQuery = [
      `@title:${topic}`,
      `@description:${topic}`,
      `@content:${topic}`,
      `@summary:${topic}`
    ].join(' | ');
    
    const query = `(${searchQuery})`;
    
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
    
    return {
      articles: results.documents.map(doc => doc.value),
      totalCount
    };
  } catch (error) {
    console.error('Error searching articles:', error);
    return { articles: [], totalCount: 0 };
  }
}

// Search articles by sentiment (with pagination)
async function searchArticlesBySentiment(sentiment, limit = 10, offset = 0) {
  try {
    // Get total count first
    const countResults = await redis.ft.search(
      'idx:news',
      `@sentiment:{${sentiment}}`,
      { 
        LIMIT: { from: 0, size: 0 } // Only get count
      }
    );
    
    const totalCount = countResults.total || 0;
    
    // Get paginated results
    const results = await redis.ft.search(
      'idx:news',
      `@sentiment:{${sentiment}}`,
      { 
        SORTBY: { BY: 'publishedAt', DIRECTION: 'DESC' }, 
        LIMIT: { from: offset, size: limit } 
      }
    );
    
    return {
      articles: results.documents.map(doc => doc.value),
      totalCount
    };
  } catch (error) {
    console.error('Error searching articles by sentiment:', error);
    return { articles: [], totalCount: 0 };
  }
}

// Enhanced similarity search using Redis 8 features (with pagination)
async function findSimilarArticles(articleId, limit = 6, offset = 0) {
  try {
    // Get the target article
    const key = `news:${articleId}`;
    const targetArticle = await redis.json.get(key);
    
    if (!targetArticle) {
      console.log('Article not found:', articleId);
      return { articles: [], totalCount: 0 };
    }

    // Use multiple Redis 8 enhanced similarity strategies
    const strategies = await Promise.allSettled([
      advancedTextSimilarity(targetArticle, limit + offset + 10), // Get more for better ranking
      semanticSimilarity(targetArticle, limit + offset + 10),
      categoryBasedSimilarity(targetArticle, limit + offset + 10),
      temporalSimilarity(targetArticle, limit + offset + 10)
    ]);

    // Combine and rank results using Redis ZUNIONSTORE for score aggregation
    const combinedResults = await combineAndRankSimilarity(
      strategies.filter(s => s.status === 'fulfilled').map(s => s.value),
      targetArticle.id,
      limit,
      offset
    );

    return combinedResults;
  } catch (error) {
    console.error('Error finding similar articles:', error);
    return await fallbackSimilarSearch(articleId, limit, offset);
  }
}

// Advanced text similarity using Redis FT.SEARCH with scoring
async function advancedTextSimilarity(targetArticle, limit) {
  try {
    const searchTerms = extractEnhancedKeywords(
      `${targetArticle.title} ${targetArticle.summary || ''} ${targetArticle.description || ''}`
    );

    if (searchTerms.length === 0) return [];

    // Build simpler query that works with Redis node client
    const queryParts = searchTerms.map(term => {
      // Escape special characters and use simpler syntax
      const escapedTerm = term.replace(/[^\w\s]/g, '');
      return `@title|summary|description:(${escapedTerm})`;
    });

    const query = `(${queryParts.join(' | ')}) -@article_id:{${targetArticle.id}}`;

    const results = await redis.ft.search(
      'idx:news',
      query,
      {
        SORTBY: { BY: 'publishedAt', DIRECTION: 'DESC' },
        LIMIT: { from: 0, size: limit }
      }
    );
    console.log("advanced text similarity", results.documents.length);
    return results.documents.map((doc, index) => ({
      ...doc.value,
      similarity_score: 1.0 - (index / results.documents.length), // Simple relevance scoring
      similarity_type: 'text'
    }));
  } catch (error) {
    console.error('Error in advanced text similarity:', error);
    return [];
  }
}

// Semantic similarity using RedisSearch aggregation
async function semanticSimilarity(targetArticle, limit) {
  try {
    // Create semantic fingerprint using key phrases
    const semanticTerms = extractSemanticTerms(targetArticle);
    
    if (semanticTerms.length === 0) return [];

    // Use simpler FT.SEARCH instead of FT.AGGREGATE for better compatibility
    const escapedTerms = semanticTerms.map(term => 
      term.replace(/[^\w\s]/g, '').split(' ').join(' ')
    ).filter(term => term.length > 0);

    if (escapedTerms.length === 0) return [];

    const query = `(@title|summary|description:(${escapedTerms.join(' | ')})) -@article_id:{${targetArticle.id}}`;

    const results = await redis.ft.search(
      'idx:news',
      query,
      {
        SORTBY: { BY: 'publishedAt', DIRECTION: 'DESC' },
        LIMIT: { from: 0, size: limit }
      }
    );
    console.log("semantic similarity", results.documents.length);
    return results.documents.map((doc, index) => ({
      ...doc.value,
      similarity_score: Math.max(0.1, 1.0 - (index / results.documents.length)),
      similarity_type: 'semantic'
    }));
  } catch (error) {
    console.error('Error in semantic similarity:', error);
    return [];
  }
}

// Category-based similarity with sentiment weighting
async function categoryBasedSimilarity(targetArticle, limit) {
  try {
    let query = '*';
    const filters = [];

    // Same sentiment gets higher score
    if (targetArticle.sentiment) {
      filters.push(`@sentiment:{${targetArticle.sentiment}}`);
    }

    // Same source gets moderate score
    if (targetArticle.source?.name) {
      filters.push(`@source:{${targetArticle.source.name}}`);
    }

    if (filters.length > 0) {
      query = filters.join(' | ');
    }

    query += ` -@article_id:{${targetArticle.id}}`;

    const results = await redis.ft.search(
      'idx:news',
      query,
      {
        SORTBY: { BY: 'publishedAt', DIRECTION: 'DESC' },
        LIMIT: { from: 0, size: limit },
        SCORER: 'DISMAX'
      }
    );
    console.log("category similarity", results.documents.length);
    return results.documents.map(doc => ({
      ...doc.value,
      similarity_score: calculateCategoryScore(targetArticle, doc.value),
      similarity_type: 'category'
    }));
  } catch (error) {
    console.error('Error in category similarity:', error);
    return [];
  }
}

// Temporal similarity - articles from similar time period
async function temporalSimilarity(targetArticle, limit) {
  try {
    const targetDate = new Date(targetArticle.publishedAt);
    const daysBefore = 7;
    const daysAfter = 7;
    
    // Create date range strings in a simpler format
    const startDate = new Date(targetDate.getTime() - daysBefore * 24 * 60 * 60 * 1000);
    const endDate = new Date(targetDate.getTime() + daysAfter * 24 * 60 * 60 * 1000);

    // Use a simpler approach - search all and filter by date
    const results = await redis.ft.search(
      'idx:news',
      `* -@article_id:{${targetArticle.id}}`,
      {
        SORTBY: { BY: 'publishedAt', DIRECTION: 'DESC' },
        LIMIT: { from: 0, size: limit } // Get more to filter
      }
    );

    // Filter by date range and calculate temporal score
    const filteredResults = results.documents
      .map(doc => {
        const articleDate = new Date(doc.value.publishedAt);
        const isInRange = articleDate >= startDate && articleDate <= endDate;
        return {
          ...doc.value,
          similarity_score: isInRange ? calculateTemporalScore(targetDate, articleDate) : 0,
          similarity_type: 'temporal',
          inRange: isInRange
        };
      })
      .filter(article => article.inRange)
      .slice(0, limit);

    return filteredResults;
  } catch (error) {
    console.error('Error in temporal similarity:', error);
    return [];
  }
}

// Combine and rank similarity results using Redis sorted sets (with pagination)
async function combineAndRankSimilarity(strategyResults, targetId, limit, offset) {
  try {
    const tempKey = `temp:similarity:${targetId}:${Date.now()}`;
    
    // Weight different similarity types
    const weights = {
      text: 0.4,
      semantic: 0.3,
      category: 0.2,
      temporal: 0.1
    };

    // Collect all articles with weighted scores
    const articleScores = new Map();
    
    for (const results of strategyResults) {
      for (const article of results) {
        if (article.id && article.id !== targetId) {
          const weight = weights[article.similarity_type] || 0.1;
          const weightedScore = (article.similarity_score || 0) * weight;
          
          const currentScore = articleScores.get(article.id) || 0;
          articleScores.set(article.id, currentScore + weightedScore);
        }
      }
    }

    const totalCount = articleScores.size;

    // Add all results to a temporary sorted set
    if (articleScores.size > 0) {
      const scoreMembers = Array.from(articleScores.entries()).map(([id, score]) => ({
        score: score,
        value: id
      }));
      
      await redis.zAdd(tempKey, scoreMembers);
      
      // Get paginated results by combined score
      const topIds = await redis.zRangeByScore(tempKey, '-inf', '+inf', {
        REV: true,
        LIMIT: { offset: offset, count: limit }
      });
      
      // Clean up temporary key
      await redis.del(tempKey);

      // Fetch full article data
      const similarArticles = [];
      for (const articleId of topIds) {
        const article = await redis.json.get(`news:${articleId}`);
        if (article) {
          // Find the article in strategy results to get similarity info
          const found = strategyResults.flat().find(a => a.id === articleId);
          similarArticles.push({
            ...article,
            similarity_score: articleScores.get(articleId) || 0,
            similarity_type: found?.similarity_type || 'combined'
          });
        }
      }

      return { articles: similarArticles, totalCount };
    }
    
    return { articles: [], totalCount: 0 };
  } catch (error) {
    console.error('Error combining similarity results:', error);
    // Fallback to first strategy result with pagination
    const firstResults = strategyResults[0] || [];
    const paginatedResults = firstResults.slice(offset, offset + limit);
    return { articles: paginatedResults, totalCount: firstResults.length };
  }
}

// Enhanced keyword extraction with NLP-like features
function extractEnhancedKeywords(text) {
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3)
    .filter(word => !isStopWord(word));

  // Create n-grams for better semantic matching
  const unigrams = words.slice(0, 8);
  const bigrams = [];
  
  for (let i = 0; i < words.length - 1 && bigrams.length < 4; i++) {
    if (!isStopWord(words[i]) && !isStopWord(words[i + 1])) {
      bigrams.push(`${words[i]} ${words[i + 1]}`);
    }
  }

  return [...unigrams, ...bigrams];
}

// Extract semantic terms (named entities, important phrases)
function extractSemanticTerms(article) {
  const text = `${article.title} ${article.summary || ''} ${article.description || ''}`;
  
  // Look for capitalized words (potential named entities)
  const namedEntities = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  
  // Look for quoted text
  const quotes = text.match(/"([^"]+)"/g) || [];
  
  // Technical terms (words with numbers, hyphens, etc.)
  const technicalTerms = text.match(/\b\w*[A-Z]\w*\b|\b\w+-\w+\b|\b\w*\d+\w*\b/g) || [];
  
  return [...new Set([...namedEntities, ...quotes, ...technicalTerms])].slice(0, 10);
}

// Calculate category-based similarity score
function calculateCategoryScore(target, candidate) {
  let score = 0;
  
  if (target.sentiment === candidate.sentiment) score += 0.3;
  if (target.source?.name === candidate.source?.name) score += 0.2;
  if (target.category === candidate.category) score += 0.3;
  
  return score;
}

// Calculate temporal similarity score
function calculateTemporalScore(targetDate, candidateDate) {
  const diffMs = Math.abs(targetDate.getTime() - candidateDate.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  
  // Closer dates get higher scores
  return Math.max(0, 1 - (diffDays / 30)); // Normalize to 30 days
}

// Enhanced stop words list
function isStopWord(word) {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'have', 'will', 'from', 'they', 
    'been', 'were', 'said', 'each', 'which', 'their', 'time', 'would', 'there', 
    'could', 'other', 'than', 'first', 'very', 'after', 'where', 'most', 'over', 
    'even', 'much', 'make', 'before', 'great', 'back', 'through', 'years', 'should', 
    'well', 'people', 'down', 'just', 'because', 'good', 'those', 'feel', 'seem', 
    'how', 'high', 'too', 'place', 'little', 'world', 'still', 'nation', 'hand', 
    'life', 'tell', 'write', 'become', 'here', 'show', 'house', 'both', 'between', 
    'need', 'mean', 'call', 'develop', 'under', 'last', 'right', 'move', 'thing', 
    'general', 'school', 'never', 'same', 'another', 'begin', 'while', 'number', 
    'part', 'turn', 'real', 'leave', 'might', 'want', 'point', 'form', 'child', 
    'small', 'since', 'against', 'late', 'hard', 'major', 'example', 'hear', 'talk', 
    'report', 'today', 'bring', 'tomorrow', 'carry', 'clear', 'above', 'news', 'article'
  ]);
  
  return stopWords.has(word);
}

// Enhanced fallback method with better Redis utilization (with pagination)
async function fallbackSimilarSearch(articleId, limit = 6, offset = 0) {
  try {
    const key = `news:${articleId}`;
    const targetArticle = await redis.json.get(key);
    
    if (!targetArticle) return { articles: [], totalCount: 0 };

    // Extract keywords and create multiple search queries
    const keywords = extractEnhancedKeywords(targetArticle.title + ' ' + (targetArticle.summary || ''));
    
    if (keywords.length > 0) {
      const query = keywords.slice(0, 5).map(keyword => 
        `@title|summary:(${keyword}~1)`
      ).join(' | ');
      
      // Get total count
      const countResults = await redis.ft.search(
        'idx:news',
        `(${query}) -@article_id:{${articleId}}`,
        { 
          LIMIT: { from: 0, size: 0 }
        }
      );
      
      const totalCount = countResults.total || 0;
      
      // Get paginated results
      const results = await redis.ft.search(
        'idx:news',
        `(${query}) -@article_id:{${articleId}}`,
        { 
          SORTBY: { BY: '__score', DIRECTION: 'DESC' }, 
          LIMIT: { from: offset, size: limit },
          SCORER: 'BM25'
        }
      );
      
      return {
        articles: results.documents.map(doc => doc.value),
        totalCount
      };
    }
    
    return { articles: [], totalCount: 0 };
  } catch (error) {
    console.error('Error in fallback similar search:', error);
    return { articles: [], totalCount: 0 };
  }
}

// Get all articles (optimized with Redis SCAN and pagination)
async function getAllArticles(limit = 10, offset = 0) {
  try {
    // Get total count first
    const countResults = await redis.ft.search(
      'idx:news',
      '*',
      {
        LIMIT: { from: 0, size: 0 } // Only get count
      }
    );
    
    const totalCount = countResults.total || 0;
    
    // Use FT.SEARCH with pagination for better performance
    const results = await redis.ft.search(
      'idx:news',
      '*',
      {
        SORTBY: { BY: 'publishedAt', DIRECTION: 'DESC' },
        LIMIT: { from: offset, size: limit }
      }
    );
    
    return {
      articles: results.documents.map(doc => doc.value),
      totalCount
    };
  } catch (error) {
    console.error('Error getting all articles:', error);
    
    // Fallback to original method with pagination
    try {
      const keys = await redis.keys('news:*');
      const totalCount = keys.length;
      
      if (keys.length === 0) {
        return { articles: [], totalCount: 0 };
      }

      // Apply pagination to keys
      const paginatedKeys = keys.slice(offset, offset + limit);
      
      const articles = [];
      const pipeline = redis.multi();
      
      paginatedKeys.forEach(key => {
        pipeline.json.get(key);
      });
      
      const results = await pipeline.exec();
      
      results.forEach((result, index) => {
        if (result[1]) {
          articles.push(result[1]);
        }
      });

      // Sort by published date
      articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      
      return { articles, totalCount };
    } catch (fallbackError) {
      console.error('Error in fallback getAllArticles:', fallbackError);
      return { articles: [], totalCount: 0 };
    }
  }
}

module.exports = { 
  redis, 
  storeArticle, 
  articleExists, 
  createSearchIndex,
  searchArticlesByTopic,
  searchArticlesBySentiment,
  findSimilarArticles,
  getAllArticles
};