# News Summarization Backend

A Node.js backend application for news summarization with AI-powered features, Redis caching, and vector search capabilities.

## Project Structure

```
backend/
├── src/
│   ├── controllers/          # Request handlers
│   │   └── newsController.js
│   ├── routes/              # Route definitions
│   │   └── newsRoutes.js
│   ├── services/            # Business logic and external services
│   │   ├── redisService.js
│   │   ├── geminiService.js
│   │   └── newsFetcherService.js
│   ├── middleware/          # Express middleware
│   │   ├── errorHandler.js
│   │   └── logger.js
│   ├── utils/              # Utility functions
│   │   └── pagination.js
│   ├── config/             # Configuration files
│   │   └── database.js
│   ├── scripts/            # Management scripts
│   │   ├── clearAllCache.js
│   │   ├── clearCache.js
│   │   ├── clearNews.js
│   │   └── deleteSearchIndex.js
│   └── app.js              # Main Express application
├── docs/                   # Documentation
│   ├── README.md
│   └── CACHE_MANAGEMENT.md
├── logs/                   # Log files
├── index.js                # Application entry point
├── package.json
└── .env                    # Environment variables
```

## Features

- **AI-Powered News Summarization** - Uses Gemini AI for content analysis
- **Redis Vector Search** - Semantic similarity search with Redis 8
- **Personalized News Feed** - User preference-based recommendations
- **Comprehensive Caching** - Multi-layer caching with Redis
- **RESTful API** - Well-structured API endpoints
- **Pagination Support** - Efficient data pagination
- **Error Handling** - Robust error management
- **Logging** - Request/response logging

## Quick Start

### Prerequisites
- Node.js 16+
- Redis 8+
- Gemini API key

### Installation
```bash
npm install
```

### Environment Setup
Create a `.env` file:
```env
REDIS_URL=redis://localhost:6379
GEMINI_API_KEY=your_gemini_api_key
PORT=3001
```

### Running the Application
```bash
# Development
npm run dev

# Production
npm start
```

## API Endpoints

### News Endpoints
- `GET /api/news` - Get all news articles
- `GET /api/news/:id` - Get specific article
- `GET /api/news/:id/similar` - Get similar articles
- `GET /api/news/search` - Search articles
- `GET /api/news/topic/:topic` - Get articles by topic
- `GET /api/news/sentiment/:sentiment` - Get articles by sentiment

### User Endpoints
- `POST /api/user/generate-id` - Generate user ID
- `POST /api/user/:userId/preferences` - Store user preferences
- `GET /api/user/:userId/preferences` - Get user preferences
- `PUT /api/user/:userId/preferences` - Update user preferences
- `GET /api/user/:userId/personalized-news` - Get personalized news
- `GET /api/user/:userId/personalized-news/search` - Search personalized news

### Metadata Endpoints
- `GET /api/topics` - Get available topics
- `GET /api/sentiments` - Get available sentiments
- `GET /api/sources` - Get available sources

### Admin Endpoints
- `GET /api/getSimiliarStats/:id` - Get similar articles stats
- `GET /api/clearSimilarArticleCache/:id` - Clear similar articles cache
- `GET /api/health` - Health check

## Cache Management

### Available Scripts
```bash
# Show cache statistics
npm run cache:stats

# Clear all cache (with confirmation)
npm run cache:clear

# Force clear all cache (no confirmation)
npm run cache:force

# ☢️  NUCLEAR: Clear everything in Redis
npm run cache:nuclear

# Show complete Redis statistics
npm run cache:complete-stats

# Show help
npm run cache:help
```

## Development

### Code Organization
- **Controllers**: Handle HTTP requests and responses
- **Services**: Contain business logic and external service interactions
- **Routes**: Define API endpoints and their handlers
- **Middleware**: Request processing and error handling
- **Utils**: Reusable utility functions
- **Config**: Application configuration
- **Scripts**: Management and maintenance scripts

### Adding New Features
1. Create service functions in `src/services/`
2. Add controller functions in `src/controllers/`
3. Define routes in `src/routes/`
4. Add middleware if needed in `src/middleware/`

## Redis Features Used

- **Vector Search**: Semantic similarity with KNN
- **JSON Storage**: Article data storage
- **Caching**: Multi-layer caching system
- **Search Indexing**: Full-text search capabilities
- **Bloom Filters**: Efficient duplicate detection
- **LRU Management**: Cache eviction strategies

## Monitoring

- Request/response logging
- Error tracking
- Cache performance metrics
- Memory usage monitoring
- API response times

## Documentation

- [Cache Management Guide](docs/CACHE_MANAGEMENT.md)
- [API Documentation](docs/README.md)

## License

ISC 