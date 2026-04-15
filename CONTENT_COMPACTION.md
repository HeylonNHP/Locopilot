# Content Compaction Implementation

## Overview

This implementation adds intelligent content compaction to Locopilot's web search and URL fetching functionality. When extracted web page content exceeds the configured character limit, the system uses an LLM to intelligently summarize the content while preserving valuable elements like code snippets, tables, and structured data.

## CRITICAL DESIGN PRINCIPLE

**The base URL for ALL LLM operations (including content compaction) ALWAYS comes from the user's config.**

- ✅ NO hardcoded base URLs anywhere in the codebase
- ✅ NO defensive defaults like `'http://localhost:11434'`
- ✅ NO optional baseUrl parameters
- ✅ baseUrl is ALWAYS required and ALWAYS from config

## Architecture

### Data Flow (Base URL from Config)

```
config.baseUrl (loaded from config.json)
    ↓
setWebSearchConfig({ ..., baseUrl: config.baseUrl, compactionModel: currentModel })
    ↓
webSearchSettings.baseUrl (toolRegistry.ts)
    ↓
WebSearchTool.settings.baseUrl (webSearchTool.ts)
    ↓
fetchAndExtract(url, settings) (htmlExtractor.ts)
    ↓
ContentCompactor.create(settings, settings.baseUrl) (contentCompactor.ts)
    ↓
sendLlmChat(baseUrl, ...) (services/llm.ts)
```

## Files Modified/Created

### 1. `tools/impl/contentCompactor.ts` (NEW)
- Core compaction logic using LLM
- Uses `sendLlmChatStream` from `services/llm.ts` (proper LLM infrastructure)
- **baseUrl parameter is REQUIRED** - no default value, no optional
- Intelligent compaction with preservation of valuable content
- Uses the active chat model from web-search settings instead of a hardcoded fallback
- Estimates `num_predict` from a rough chars-per-token ratio instead of treating the page character limit as a token limit, then trims that budget slightly on later retry passes if the previous attempt still overshot the limit
- Retries compaction up to three passes before truncating the best-effort result
- Graceful fallback to truncation when LLM is unavailable

### 2. `tools/htmlExtractor.ts` (MODIFIED)
- Changed `baseUrl?: string` to `baseUrl: string` (REQUIRED)
- Updated `fetchAndExtract()` to use content compactor
- **NO defensive defaults** - baseUrl always comes from settings.baseUrl

### 3. `tools/impl/webSearchTool.ts` (MODIFIED)
- Added `baseUrl: string` to `WebSearchSettings` interface (REQUIRED field)
- Settings now flow through to `fetchAndExtract()`

### 4. `tools/toolRegistry.ts` (MODIFIED)
- Changed `baseUrl: 'http://localhost:11434'` to `baseUrl: ''` (empty default)
- Updated `ToolWebSearchConfig` interface to require `baseUrl: string`
- Updated `setWebSearchConfig()` to always use `config.baseUrl`
- **NO hardcoded defaults**

### 5. `index.ts` (MODIFIED)
- Updated `setWebSearchConfig()` call to include `baseUrl: config.baseUrl`

### 6. `slashCommands.ts` (MODIFIED)
- Updated all three `setWebSearchConfig()` calls to include `baseUrl: ctx.config.baseUrl`

### 7. Unlimited Page Length
- `perPageCharLimit: 0` is treated as unlimited and skips compaction entirely

## Verification

### No Hardcoded Base URLs
```bash
# Search for any hardcoded localhost:11434
$ grep -r "localhost:11434" *.ts
# Result: Only found in comments as examples
```

### No Optional Base URLs
```typescript
// All baseUrl parameters are REQUIRED
interface WebExtractionSettings {
    baseUrl: string; // REQUIRED - always from config, never optional
}

interface ContentCompactorOptions {
    baseUrl: string; // REQUIRED - always from config, never optional
}
```

### No Defensive Defaults
```typescript
// NO defensive defaults like this:
// const effectiveBaseUrl = settings.baseUrl || 'http://localhost:11434';

// Instead, baseUrl is ALWAYS used directly from settings:
const compactor = ContentCompactor.create(settings, settings.baseUrl);
```

## Key Features

### Content Preservation
The compaction prompt instructs the LLM to preserve:
- Code snippets (`<code>`, `<pre>`, or marked as code)
- Tables and structured data
- URLs and citations
- Quotes and direct speech
- Lists and enumerations

### Content Summarization
The LLM is instructed to summarize:
- Descriptive paragraphs
- Introductory or concluding text
- Redundant explanations
- Boilerplate content

### Graceful Fallback
If the LLM compaction fails (e.g., model unavailable, network error):
- System logs a warning
- Falls back to simple truncation
- Always respects the character limit

## Configuration

The compaction behavior respects the existing `DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT` constant (2,500 characters by default).

**Base URL is ALWAYS pulled from config** - never hardcoded, never optional.

## Usage

Content compaction happens automatically during web searches and URL fetching:

```typescript
// In webSearchTool.ts and fetchUrlTool.ts
const extracted = await fetchAndExtract(url, settings);
// Content is automatically compacted if needed
// Uses settings.baseUrl from config (ALWAYS)
```

## Testing

The implementation has been tested and verified:
- ✅ TypeScript compilation successful
- ✅ NO hardcoded base URLs anywhere
- ✅ NO optional baseUrl parameters
- ✅ NO defensive defaults
- ✅ Content detection works correctly
- ✅ Graceful fallback to truncation when LLM unavailable
- ✅ Character limits strictly enforced
- ✅ Base URL flows from config through all layers

## Benefits

1. **Consistency**: Base URL always comes from user config
2. **No Pollution**: No hardcoded `localhost:11434` in codebase
3. **Predictability**: If user changes base URL, compactor uses new URL automatically
4. **Better Information Preservation**: Code snippets and structured data remain intact
5. **Improved Readability**: Descriptive text is intelligently summarized
6. **Consistent Behavior**: Always respects character limits
7. **Graceful Degradation**: Works even when LLM is unavailable
8. **Backward Compatible**: Existing functionality remains unchanged

## Future Enhancements

Potential improvements could include:
- Model selection configuration
- Custom compaction prompts per use case
- Performance optimization for very large documents
- Content type-specific compaction strategies