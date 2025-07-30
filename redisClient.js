require('dotenv').config();
const { createClient } = require('redis');
const { generateEmbedding } = require('./geminiClient'); 
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
    // const indexExists = await redis.ft.info('idx:news').catch(() => false);
    // if (indexExists) {
    //   console.log('Search index already exists');
    //   return;
    // }

    // Drop existing index if it exists (in case of schema changes)
    try {
      await redis.ft.dropIndex('idx:news');
      console.log('Dropped existing index to recreate with new schema');
    } catch (e) {
      // Index doesn't exist, that's fine
    }

    // // Get actual embedding dimension from a sample article
    // let embeddingDimension = 3072; // Default
    // try {
    //   const sampleKey = await redis.keys('news:*').then(keys => keys[0]);
    //   if (sampleKey) {
    //     const sampleArticle = await redis.json.get(sampleKey);
    //     if (sampleArticle && sampleArticle.vector) {
    //       embeddingDimension = sampleArticle.vector.length;
    //       console.log(`Detected embedding dimension: ${embeddingDimension}`);
    //     }
    //   }
    // } catch (e) {
    //   console.log('Could not detect embedding dimension, using default:', embeddingDimension);
    // }

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
      '$.keywords': { type: 'TAG', AS: 'keywords' },
      '$.source.name': { type: 'TAG', AS: 'source' },
      '$.publishedAt': { type: 'TEXT', AS: 'publishedAt' },
      '$.category': { type: 'TAG', AS: 'category' },
      '$.id': { type: 'TAG', AS: 'article_id' },
      '$.urlToImage': { type: 'TEXT', AS: 'urlToImage' },
      '$.url': { type: 'TEXT', AS: 'url' },
      '$.vector': { 
        type: 'VECTOR', 
        AS: 'vector', 
        ALGORITHM: 'FLAT', 
        TYPE: 'FLOAT32',
        DIM: 3072, 
        DISTANCE_METRIC: 'COSINE' 
      }
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

async function vectorSearchSimilarNews(searchText, limit = 10, threshold = 0.7, filters = {}, excludeId = null) {
  try {
    console.log(`Searching for similar news to: "${searchText}"`);
    
    // Generate embedding for the search text using Gemini
    const searchVector = await generateEmbedding(searchText);
    
    if (!searchVector || !Array.isArray(searchVector)) {
      throw new Error('Failed to generate embedding for search text');
    }

    console.log(`Generated embedding with dimension: ${searchVector.length}`);

    // Build the vector similarity query
    let baseQuery = `*=>[KNN ${limit * 2} @vector $BLOB AS vector_score]`;
    const queryFilters = [];

    // Add filters if provided
    if (filters.category) {
      queryFilters.push(`@category:{${filters.category}}`);
    }
    if (filters.source) {
      queryFilters.push(`@source:{${filters.source}}`);
    }
    if (filters.sentiment) {
      queryFilters.push(`@sentiment:{${filters.sentiment}}`);
    }

    // Exclude specific article ID if provided
    if (excludeId) {
      queryFilters.push(`-@article_id:{${excludeId}}`);
    }

    // Combine filters with base query
    let finalQuery = baseQuery;
    if (queryFilters.length > 0) {
      finalQuery = `(${queryFilters.join(' ')})=>[KNN ${limit * 2} @vector $BLOB AS vector_score]`;
    }

    // Prepare the vector search parameters
    const vectorQuery = Buffer.from(new Float32Array(searchVector).buffer);

    // Perform vector similarity search
    const searchResults = await redis.ft.search('idx:news', finalQuery, {
      PARAMS: {
        BLOB: vectorQuery
      },
      SORTBY: {
        BY: 'vector_score',
        DIRECTION: 'ASC' // Lower scores mean higher similarity in cosine distance
      },
      RETURN: [
        'title', 'description', 'content', 'summary', 'sentiment', 
        'source', 'publishedAt', 'category', 'article_id', 'urlToImage', 'url', 'vector_score'
      ],
      LIMIT: {
        from: 0,
        size: limit * 2 // Get more results to filter by threshold
      },
      DIALECT: 2
    });
    console.log(searchResults);

    // Process and filter results
    const similarArticles = [];
    
    if (searchResults && searchResults.documents) {
      for (const doc of searchResults.documents) {
        const score = parseFloat(doc.value.vector_score || 1);
        const similarity = 1 - score; // Convert distance to similarity (higher is more similar)
        console.log(similarity);
        // Filter by similarity threshold
        if (similarity >= threshold) {
          similarArticles.push({
            id: doc.value.article_id,
            title: doc.value.title,
            description: doc.value.description,
            content: doc.value.content,
            summary: doc.value.summary,
            sentiment: doc.value.sentiment,
            source: doc.value.source,
            publishedAt: doc.value.publishedAt,
            category: doc.value.category,
            urlToImage: doc.value.urlToImage,
            url: doc.value.url,
            similarity: similarity,
            distance: score
          });
        }
      }
    }

    // Sort by similarity (highest first) and limit results
    const finalResults = similarArticles
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    console.log(`Found ${finalResults.length} similar articles above threshold ${threshold}`);
    return finalResults;

  } catch (error) {
    console.error('Error in vector search:', error);
    throw error;
  }
}

async function storeUserPreferences(userId, preferences) {
  const key = `user:${userId}:preferences`;
  await redis.json.set(key, '$', {
    userId,
    preferences,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

// Get user preferences
async function getUserPreferences(userId) {
  const key = `user:${userId}:preferences`;
  const prefs = await redis.json.get(key);
  return prefs;
}

// Update user preferences
async function updateUserPreferences(userId, preferences) {
  const key = `user:${userId}:preferences`;
  const exists = await redis.exists(key);
  
  if (exists) {
    await redis.json.set(key, '$.preferences', preferences);
    await redis.json.set(key, '$.updatedAt', new Date().toISOString());
  } else {
    await storeUserPreferences(userId, preferences);
  }
}

// Get personalized news based on user preferences using vector search
async function getPersonalizedNews(userId, limit = 10, offset = 0) {
  try {
    const userPrefs = await getUserPreferences(userId);
    
    if (!userPrefs || !userPrefs.preferences || userPrefs.preferences.length === 0) {
      // Fallback to general articles if no preferences
      return getAllArticles(limit, offset);
    }

    const { preferences } = userPrefs;
    
    // Use vector search for each preference and combine results
    const allVectorResults = [];
    
    for (const preference of preferences) {
      try {
        // Use vector search for each preference with lower threshold for more results
        const vectorResults = await vectorSearchSimilarNews(preference, limit * 2, 0.3, {});
        
        // Add preference info to each result
        const resultsWithPreference = vectorResults.map(article => ({
          ...article,
          personalized: true,
          matched_preference: preference,
          similarity_score: article.similarity
        }));
        
        allVectorResults.push(...resultsWithPreference);
      } catch (vectorError) {
        console.error(`Vector search failed for preference "${preference}":`, vectorError);
        // Fallback to text search for this preference
        const textResults = await searchArticlesByTopic(preference, limit, 0);
        const textResultsWithPreference = textResults.articles.map(article => ({
          ...article,
          personalized: true,
          matched_preference: preference,
          search_method: 'text'
        }));
        allVectorResults.push(...textResultsWithPreference);
      }
    }
    
    // Remove duplicates and rank by similarity
    const uniqueArticles = new Map();
    
    for (const article of allVectorResults) {
      if (!uniqueArticles.has(article.id)) {
        uniqueArticles.set(article.id, article);
      } else {
        // If article already exists, keep the one with higher similarity
        const existing = uniqueArticles.get(article.id);
        if (article.similarity_score > existing.similarity_score) {
          uniqueArticles.set(article.id, article);
        }
      }
    }
    
    // Sort by similarity score (highest first) and apply pagination
    const sortedArticles = Array.from(uniqueArticles.values())
      .sort((a, b) => (b.similarity_score || 0) - (a.similarity_score || 0))
      .slice(offset, offset + limit);
    
    // If we don't have enough personalized results, mix with general articles
    if (sortedArticles.length < limit) {
      const remainingLimit = limit - sortedArticles.length;
      const existingIds = new Set(sortedArticles.map(a => a.id));
      
      const generalResult = await getAllArticles(remainingLimit * 2, 0);
      const generalArticles = generalResult.articles
        .filter(article => !existingIds.has(article.id))
        .slice(0, remainingLimit)
        .map(article => ({ 
          ...article, 
          personalized: false,
          search_method: 'general'
        }));
      
      sortedArticles.push(...generalArticles);
    }
    
    return {
      articles: sortedArticles.slice(0, limit),
      totalCount: uniqueArticles.size
    };
  } catch (error) {
    console.error('Error getting personalized news:', error);
    // Fallback to regular articles
    return getAllArticles(limit, offset);
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

// Enhanced similarity search using Redis 8 features with advanced caching
async function findSimilarArticles(articleId, limit = 6, offset = 0, options = {}) {
  try {
    const {
      forceRefresh = false,
      cacheTimeout = 3600, // 1 hour default
      includeCacheStats = false,
      useBloomFilter = true,
      enablePipeline = true
    } = options;

    // Generate cache key with parameters for better granularity
    const cacheKey = `similar:${articleId}:${limit}:${offset}`;
    const metaCacheKey = `similar_meta:${articleId}`;
    const bloomKey = `similar_bloom:${articleId}`;
    const statsKey = `similar_stats:${articleId}`;

    // Check if article exists using Redis 8's improved EXISTS with pipeline
    let pipeline = enablePipeline ? redis.multi() : null;
    
    if (!forceRefresh) {
      if (enablePipeline) {
        // Use pipeline for batch cache check
        pipeline.json.get(cacheKey);
        pipeline.json.get(metaCacheKey);
        
        try {
          const results = await pipeline.exec();
          
          // Safely extract results, handling null/error cases
          const cachedResults = results && results[0] && results[0][0] === null ? results[0][1] : null;
          const metaData = results && results[1] && results[1][0] === null ? results[1][1] : null;
          
          if (cachedResults && metaData && cachedResults.results) {
            // Update cache hit statistics
            await redis.hIncrBy(statsKey, 'cache_hits', 1);
            await redis.hIncrBy(statsKey, 'total_requests', 1);
            await redis.expire(statsKey, cacheTimeout);

            console.log(`Cache HIT for similar articles: ${articleId}`);
            
            const response = {
              articles: cachedResults.results.slice(offset, offset + limit),
              totalCount: metaData.totalCount,
              cached: true,
              cacheAge: Date.now() - metaData.timestamp
            };

            if (includeCacheStats) {
              const stats = await redis.hGetAll(statsKey);
              response.cacheStats = {
                hits: parseInt(stats.cache_hits || 0),
                misses: parseInt(stats.cache_misses || 0),
                hitRate: stats.cache_hits ? (parseInt(stats.cache_hits) / parseInt(stats.total_requests || 1)) * 100 : 0
              };
            }

            return response;
          }
        } catch (pipelineError) {
          console.log('Pipeline cache check failed, falling back to individual calls:', pipelineError);
          // Fall through to non-pipeline approach
        }
      }
      
      // Non-pipeline approach or fallback
      try {
        const [cachedResults, metaData] = await Promise.all([
          redis.json.get(cacheKey).catch(() => null),
          redis.json.get(metaCacheKey).catch(() => null)
        ]);
        
        if (cachedResults && metaData && cachedResults.results) {
          await redis.hIncrBy(statsKey, 'cache_hits', 1);
          await redis.hIncrBy(statsKey, 'total_requests', 1);
          await redis.expire(statsKey, cacheTimeout);
          
          console.log(`Cache HIT for similar articles: ${articleId}`);
          
          const response = {
            articles: cachedResults.results.slice(offset, offset + limit),
            totalCount: metaData.totalCount,
            cached: true,
            cacheAge: Date.now() - metaData.timestamp
          };

          if (includeCacheStats) {
            const stats = await redis.hGetAll(statsKey);
            response.cacheStats = {
              hits: parseInt(stats.cache_hits || 0),
              misses: parseInt(stats.cache_misses || 0),
              hitRate: stats.total_requests ? (parseInt(stats.cache_hits || 0) / parseInt(stats.total_requests)) * 100 : 0
            };
          }

          return response;
        }
      } catch (cacheError) {
        console.log('Cache check failed:', cacheError);
        // Continue to cache miss logic
      }
    }

    // Cache miss - update statistics
    await redis.hIncrBy(statsKey, 'cache_misses', 1);
    await redis.hIncrBy(statsKey, 'total_requests', 1);
    await redis.expire(statsKey, cacheTimeout);

    console.log(`Cache MISS for similar articles: ${articleId}`);

    // Get the target article using Redis 8's improved JSON operations
    const articleKey = `news:${articleId}`;
    const targetArticle = await redis.json.get(articleKey);
    
    if (!targetArticle) {
      console.log('Article not found:', articleId);
      return { articles: [], totalCount: 0, cached: false };
    }

    // Use Redis 8's Bloom Filter for efficient duplicate checking (if enabled)
    if (useBloomFilter) {
      try {
        // Create bloom filter if it doesn't exist
        await redis.bf.reserve(bloomKey, 0.01, 1000).catch(() => {
          // Bloom filter might already exist
        });
        console.log('Bloom filter created');
        
        // Check if we've processed this article recently
        const recentlyProcessed = await redis.bf.exists(bloomKey, articleId);
        console.log('Recently processed:', recentlyProcessed);
        if (recentlyProcessed && !forceRefresh) {
          console.log('Article recently processed, using cached computation');
        }
        
        // Add to bloom filter
        await redis.bf.add(bloomKey, articleId);
        await redis.expire(bloomKey, cacheTimeout);
      } catch (bloomError) {
        console.log('Bloom filter not available, continuing without it');
      }
    }

    // Determine search strategy
    const keywords = targetArticle.keywords || [];
    let searchText;
    let searchMethod = 'vector';
    
    if (keywords.length === 0) {
      console.log('No keywords found in article, using title as fallback');
      searchText = targetArticle.title;
    } else {
      searchText = keywords.join(' ');
      console.log(`Searching with stored keywords: ${searchText}`);
    }
    
    let similarArticles = [];
    let totalCount = 0;

    // Primary: Vector search with Redis 8's enhanced vector operations
    try {
      const vectorResults = await vectorSearchSimilarNews(
        searchText, 
        limit + offset + 20, // Get more for better caching
        0.5, 
        {}, 
        articleId
      );
      
      similarArticles = vectorResults.map(article => ({
        ...article,
        similarity_score: article.similarity,
        search_method: 'vector',
        keywords_used: keywords.length > 0 ? keywords : [targetArticle.title]
      }));
      
      totalCount = vectorResults.length;
      
    } catch (vectorError) {
      console.error('Vector search failed, falling back to text-based similarity:', vectorError);
      searchMethod = 'text';
      
      // Fallback to text-based methods
      const strategies = await Promise.allSettled([
        advancedTextSimilarity(targetArticle, limit + offset + 20),
        semanticSimilarity(targetArticle, limit + offset + 20),
        categoryBasedSimilarity(targetArticle, limit + offset + 20),
        temporalSimilarity(targetArticle, limit + offset + 20)
      ]);

      const combinedResults = await combineAndRankSimilarity(
        strategies.filter(s => s.status === 'fulfilled').map(s => s.value),
        targetArticle.id,
        limit + offset + 20,
        0
      );

      similarArticles = combinedResults.articles || [];
      totalCount = combinedResults.totalCount || 0;
    }

    // Cache the results using Redis 8's improved caching with multiple strategies
    const cacheData = {
      results: similarArticles,
      timestamp: Date.now(),
      searchMethod: searchMethod,
      articleId: articleId,
      version: '1.0'
    };

    const metaData = {
      totalCount: totalCount,
      timestamp: Date.now(),
      searchMethod: searchMethod,
      lastUpdated: new Date().toISOString()
    };

    // Use Redis 8's pipeline for efficient bulk operations
    const cachePipeline = redis.multi();
    
    // Store main cache data with compression hint
    cachePipeline.json.set(cacheKey, '$', cacheData);
    cachePipeline.expire(cacheKey, cacheTimeout);
    
    // Store metadata separately for quick access
    cachePipeline.json.set(metaCacheKey, '$', metaData);
    cachePipeline.expire(metaCacheKey, cacheTimeout);
    
    // Use Redis 8's sorted sets for LRU-style cache management
    const cacheManagementKey = `similar_cache_lru`;
    cachePipeline.zAdd(cacheManagementKey, {
      score: Date.now(),
      value: cacheKey
    });
    
    // Keep only the most recent 1000 cached similar article sets
    cachePipeline.zRemRangeByRank(cacheManagementKey, 0, -1001);
    cachePipeline.expire(cacheManagementKey, cacheTimeout * 24); // Keep management key longer
    
    // Execute all cache operations
    await cachePipeline.exec();

    // Use Redis 8's HyperLogLog for unique visitor tracking
    try {
      await redis.pfAdd(`similar_unique_articles:${new Date().toISOString().split('T')[0]}`, articleId);
    } catch (hllError) {
      console.log('HyperLogLog tracking failed:', hllError);
    }

    console.log(`Cached similar articles for: ${articleId} (${similarArticles.length} articles)`);

    // Prepare response
    const response = {
      articles: similarArticles.slice(offset, offset + limit),
      totalCount: totalCount,
      cached: false,
      searchMethod: searchMethod,
      processingTime: Date.now() - cacheData.timestamp
    };

    if (includeCacheStats) {
      const stats = await redis.hGetAll(statsKey);
      response.cacheStats = {
        hits: parseInt(stats.cache_hits || 0),
        misses: parseInt(stats.cache_misses || 0),
        hitRate: stats.total_requests ? (parseInt(stats.cache_hits || 0) / parseInt(stats.total_requests)) * 100 : 0
      };
    }

    return response;

  } catch (error) {
    console.error('Error in cached findSimilarArticles:', error);
    
    // Error fallback - try to return any available cached data
    try {
      const fallbackKey = `similar:${articleId}:fallback`;
      const fallbackData = await redis.json.get(fallbackKey);
      if (fallbackData) {
        console.log('Returning fallback cached data due to error');
        return {
          articles: fallbackData.results.slice(offset, offset + limit),
          totalCount: fallbackData.totalCount || 0,
          cached: true,
          fallback: true,
          error: error.message
        };
      }
    } catch (fallbackError) {
      console.error('Fallback cache also failed:', fallbackError);
    }
    
    // Final fallback - return basic article info
    return {
      articles: [],
      totalCount: 0,
      cached: false,
      error: error.message,
      fallback: true
    };
  }
}

// Utility function to get cache statistics and health
async function getSimilarArticleCacheStats(articleId = null) {
  try {
    const stats = {};
    
    if (articleId) {
      // Get stats for specific article
      const statsKey = `similar_stats:${articleId}`;
      const articleStats = await redis.hGetAll(statsKey);
      stats.article = {
        id: articleId,
        hits: parseInt(articleStats.cache_hits || 0),
        misses: parseInt(articleStats.cache_misses || 0),
        totalRequests: parseInt(articleStats.total_requests || 0),
        hitRate: articleStats.total_requests ? 
          (parseInt(articleStats.cache_hits || 0) / parseInt(articleStats.total_requests)) * 100 : 0
      };
    }
    
    // Get overall cache management stats
    const lruKey = 'similar_cache_lru';
    const totalCached = await redis.zCard(lruKey);
    const oldestCache = await redis.zRange(lruKey, 0, 0, { WITHSCORES: true });
    const newestCache = await redis.zRange(lruKey, -1, -1, { WITHSCORES: true });
    
    stats.overall = {
      totalCachedArticles: totalCached,
      oldestCacheTime: oldestCache.length > 0 ? new Date(oldestCache[0].score) : null,
      newestCacheTime: newestCache.length > 0 ? new Date(newestCache[0].score) : null
    };
    
    // Get daily unique articles processed using HyperLogLog
    try {
      const today = new Date().toISOString().split('T')[0];
      const uniqueToday = await redis.pfCount(`similar_unique_articles:${today}`);
      stats.daily = {
        date: today,
        uniqueArticlesProcessed: uniqueToday
      };
    } catch (hllError) {
      stats.daily = { error: 'HyperLogLog not available' };
    }
    
    return stats;
  } catch (error) {
    console.error('Error getting cache stats:', error);
    return { error: error.message };
  }
}

// Function to clear cache for specific article or all similar article caches
async function clearSimilarArticleCache(articleId = null, options = {}) {
  try {
    const { clearStats = false, clearBloom = false } = options;
    
    if (articleId) {
      // Clear cache for specific article
      const pattern = `similar:${articleId}:*`;
      const keys = await redis.keys(pattern);
      
      if (keys.length > 0) {
        await redis.del(keys);
      }
      
      // Clear metadata
      await redis.del(`similar_meta:${articleId}`);
      
      if (clearStats) {
        await redis.del(`similar_stats:${articleId}`);
      }
      
      if (clearBloom) {
        await redis.del(`similar_bloom:${articleId}`);
      }
      
      // Remove from LRU management
      const lruKey = 'similar_cache_lru';
      const lruKeys = await redis.zRange(lruKey, 0, -1);
      const keysToRemove = lruKeys.filter(key => key.includes(articleId));
      if (keysToRemove.length > 0) {
        await redis.zRem(lruKey, keysToRemove);
      }
      
      console.log(`Cleared cache for article: ${articleId}`);
      return { cleared: keys.length + 1, articleId };
    } else {
      // Clear all similar article caches
      const patterns = ['similar:*', 'similar_meta:*', 'similar_cache_lru'];
      let totalCleared = 0;
      
      for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.del(keys);
          totalCleared += keys.length;
        }
      }
      
      if (clearStats) {
        const statsKeys = await redis.keys('similar_stats:*');
        if (statsKeys.length > 0) {
          await redis.del(statsKeys);
          totalCleared += statsKeys.length;
        }
      }
      
      if (clearBloom) {
        const bloomKeys = await redis.keys('similar_bloom:*');
        if (bloomKeys.length > 0) {
          await redis.del(bloomKeys);
          totalCleared += bloomKeys.length;
        }
      }
      
      console.log(`Cleared all similar article caches: ${totalCleared} keys`);
      return { cleared: totalCleared, scope: 'all' };
    }
  } catch (error) {
    console.error('Error clearing cache:', error);
    return { error: error.message };
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
  searchArticlesByTopic,
  searchArticlesBySentiment,
  getAllArticles,
  createSearchIndex,
  findSimilarArticles,
  getSimilarArticleCacheStats,
  clearSimilarArticleCache,
  storeArticle,
  articleExists,
  // Add these new exports
  storeUserPreferences,
  getUserPreferences,
  updateUserPreferences,
  getPersonalizedNews,
  vectorSearchSimilarNews
};