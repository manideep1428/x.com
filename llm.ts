import OpenAI from 'openai';
import Exa from 'exa-js';
import { GoogleGenAI } from '@google/genai';
import { TWEET_SYSTEM_PROMPT, HARSH_TWEET_SYSTEM_PROMPT, REPLY_GOOD_PROMPT, REPLY_BAD_PROMPT, REPLY_STRAIGHT_PROMPT } from './prompt';

let openaiClients: Record<string, OpenAI> = {};
let googleClient: GoogleGenAI | null = null;
let exaClient: Exa | null = null;

// Helper to get cached OpenAI-compatible client for a given provider
function getOpenAIClient(provider: string): OpenAI {
  if (!openaiClients[provider]) {
    let apiKey: string | undefined;
    let baseURL: string | undefined;

    if (provider === 'deepseek') {
      apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
      baseURL = "https://api.deepseek.com";
    } else if (provider === 'groq') {
      apiKey = process.env.GROQ_API_KEY;
      baseURL = "https://api.groq.com/openai/v1";
    } else {
      // default: openai
      apiKey = process.env.OPENAI_API_KEY;
    }

    if (!apiKey) {
      throw new Error(
        `Missing API key for provider "${provider}". Please define it in your .env file (e.g. ${provider.toUpperCase()}_API_KEY or OPENAI_API_KEY).`
      );
    }
    openaiClients[provider] = new OpenAI({ apiKey, baseURL });
  }
  return openaiClients[provider]!;
}

// Helper to get cached Google GenAI / Vertex AI client
function getGoogleClient(): GoogleGenAI {
  if (!googleClient) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Missing Gemini API key. Please define GEMINI_API_KEY or GOOGLE_API_KEY in your .env file.'
      );
    }
    googleClient = new GoogleGenAI({
      vertexai: true,
      apiKey: apiKey
    });
  }
  return googleClient;
}

// Helper to get default model for a given provider
function getDefaultModel(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'groq':
      return 'llama-3.3-70b-versatile';
    case 'vertexai':
    case 'gemini':
      return 'gemini-3.5-flash';
    case 'deepseek':
    default:
      return 'deepseek-chat';
  }
}

// Helper to get the Exa client instance lazily
function getExa(): Exa {
  if (!exaClient) {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey || apiKey === 'your_exa_api_key_here') {
      throw new Error(
        'Missing EXA_API_KEY environment variable. Please define it in your .env file.'
      );
    }
    exaClient = new Exa(apiKey);
  }
  return exaClient;
}

/**
 * Generates a text response using the configured LLM provider and model.
 * @param prompt The prompt to send to the LLM.
 * @param systemInstruction Optional system instruction to guide the LLM context/behavior.
 * @returns The generated string.
 */
export async function generateText(prompt: string, systemInstruction?: string): Promise<string> {
  const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
  const model = process.env.LLM_MODEL || getDefaultModel(provider);

  console.log(`🤖 generating text with provider: ${provider}, model: ${model}`);

  try {
    if (provider === 'vertexai' || provider === 'gemini') {
      const client = getGoogleClient();

      const contents = systemInstruction
        ? `${systemInstruction}\n\nUser: ${prompt}`
        : prompt;

      const response = await client.models.generateContent({
        model: model,
        contents: contents,
        config: {
          temperature: 0.7,
        }
      });

      const text = response.text;
      if (!text) {
        throw new Error('Vertex AI / Gemini returned an empty response.');
      }
      return text.trim();
    } else {
      // OpenAI, DeepSeek, or Groq
      const client = getOpenAIClient(provider);
      const response = await client.chat.completions.create({
        model: model,
        messages: [
          ...(systemInstruction ? [{ role: 'system' as const, content: systemInstruction }] : []),
          { role: 'user' as const, content: prompt },
        ],
        temperature: 0.7,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error(`${provider} returned an empty response.`);
      }
      return content.trim();
    }
  } catch (error: any) {
    console.error(`❌ Error generating text with ${provider}:`, error.message || error);
    throw error;
  }
}

/**
 * Generates a tweet of under 280 characters based on a given topic/trend.
 * @param topic The topic or trend to write about.
 * @returns A formatted tweet string.
 */
export async function generateTweet(topic: string): Promise<string> {
  const prompt = `Write a short post about this trend: "${topic}"`;
  return generateText(prompt, TWEET_SYSTEM_PROMPT);
}

/**
 * Decides whether a tweet requires a web search, performs the search if needed,
 * and generates a reply.
 * @param tweetText The text of the tweet to reply to.
 * @returns The generated reply string.
 */
export async function generateReplyWithSearch(tweetText: string): Promise<string> {
  // Select a reply tone: good, bad, or straight
  const replyTones = ['good', 'bad', 'straight'] as const;
  const tone = replyTones[Math.floor(Math.random() * replyTones.length)]!;
  console.log(`      Selected reply tone: ${tone.toUpperCase()}`);

  let systemInstruction = REPLY_STRAIGHT_PROMPT;
  if (tone === 'good') {
    systemInstruction = REPLY_GOOD_PROMPT;
  } else if (tone === 'bad') {
    systemInstruction = REPLY_BAD_PROMPT;
  }

  // Check if Exa is configured
  const exaKey = process.env.EXA_API_KEY;
  if (!exaKey || exaKey === 'your_exa_api_key_here') {
    console.log('   ⚠️ EXA_API_KEY is not configured. Skipping web search and replying directly.');
    return generateText(
      `Write a concise reply to this tweet: "${tweetText}"`,
      systemInstruction
    );
  }

  try {
    // 1. Ask OpenAI if we need to search the web
    console.log('      Analyzing tweet to determine if web search is needed...');
    const decisionPrompt =
      `Analyze the following tweet. If answering or replying to this tweet requires recent facts, news, references, ` +
      `or external information that an LLM might not know (e.g. current events, sports scores, release dates, factual queries), ` +
      `respond with 'YES'. Otherwise, if it is a general opinion, joke, personal thought, or simple greeting, respond with 'NO'.\n\n` +
      `Tweet: "${tweetText}"\n\n` +
      `Decision (YES/NO):`;

    const decisionResponse = await generateText(decisionPrompt, 'Respond only with YES or NO.');
    const needsSearch = decisionResponse.toUpperCase().includes('YES');

    if (needsSearch) {
      console.log('      🔍 Web search is needed. Generating search query...');
      // 2. Ask OpenAI to generate a search query
      const queryPrompt =
        `Based on this tweet: "${tweetText}"\n\n` +
        `Generate a single, concise search query optimized for search engines to find the relevant context or facts. ` +
        `Do not include search operators like site: or quotes. Just the keywords.`;

      const searchQuery = await generateText(queryPrompt, 'Respond with only the search query keywords.');
      console.log(`      🔎 Exa Search Query: "${searchQuery}"`);

      // 3. Perform Exa Search
      const exa = getExa();
      const searchResult = await exa.search(searchQuery, {
        numResults: 3,
        contents: {
          highlights: true,
        },
      });

      // 4. Extract highlights
      let searchContext = '';
      if (searchResult.results && searchResult.results.length > 0) {
        searchContext = searchResult.results.map((res, i) => {
          const highlightStr = res.highlights ? res.highlights.join(' ') : '';
          return `[Result ${i + 1}] Title: ${res.title}\nURL: ${res.url}\nContext: ${highlightStr}\n`;
        }).join('\n');
      }

      if (searchContext) {
        console.log('      ✅ Web search results fetched and injected into context.');
        // Generate reply using the search context
        const promptWithContext =
          `Here is a tweet you need to reply to: "${tweetText}"\n\n` +
          `We searched the web for relevant context and found the following information:\n` +
          `${searchContext}\n` +
          `Using this context to ensure factual accuracy, write a concise, conversational reply to the tweet.`;

        return generateText(promptWithContext, systemInstruction);
      } else {
        console.log('      ⚠️ Web search returned no results. Falling back to direct reply.');
      }
    } else {
      console.log('      ⚡ No web search required. Replying directly.');
    }
  } catch (error: any) {
    console.warn('      ⚠️ Exa search failed or threw an error:', error.message || error);
    console.log('      Falling back to direct reply...');
  }

  // Fallback direct reply
  return generateText(
    `Write a concise reply to this tweet: "${tweetText}"`,
    systemInstruction
  );
}

export interface NewsArticle {
  title: string;
  url: string;
  image: string | null;
  highlights: string[] | null;
  imageLinks?: string[] | null;
}

/**
 * Generates a specific tech-related search query dynamically from a set of categories.
 */
export async function generateTechTrendQuery(): Promise<string> {
  const categories = [
    "semiconductor chips, GPU hardware engineering, CUDA, Blackwell, AMD, or TSMC fabrication",
    "compiler optimizations, LLM inference engines, llama.cpp, vLLM, TensorRT, or WebAssembly AI runtime",
    "databases, vector search, pgvector, Qdrant, Milvus, or database scaling architectures",
    "agentic AI frameworks, LangChain, CrewAI, Autogen, or browser automation agents",
    "systems programming languages, Rust, WebAssembly, Zig, or Go in modern backend infrastructure",
    "local LLMs, edge computing, Ollama, apple silicon optimization, or on-device intelligence",
    "frontend framework wars, Next.js, Vite, React Server Components, or build tooling updates",
    "open-source AI models, Hugging Face trends, fine-tuning techniques, LoRA, or quantization breakthroughs",
    "developer tools, GitHub Copilot alternatives, LSP protocols, or code generation models",
    "cloud infrastructure scaling, Kubernetes, serverless compute, or edge caching for AI applications"
  ];
  
  const selectedCategory = categories[Math.floor(Math.random() * categories.length)];
  
  const prompt = `Generate a single, highly specific search query to find the latest trending developments, news articles, blog posts, or research updates in this tech category: "${selectedCategory}".
The query should be optimized for a search engine to return the most interesting developer-centric news or announcements from the past 48 hours.
Do not use search operators (like AND, OR, site:). Return ONLY the query keywords.
Example: "nvidia blackwell gpu benchmarks performance" or "vllm inference optimization llama 3" or "rust webassembly compiler performance updates".
Return only the query text.`;

  try {
    const query = await generateText(prompt, "Respond with only the search query.");
    console.log(`      💡 Generated tech trend search query for category [${selectedCategory}]: "${query}"`);
    return query;
  } catch (error) {
    console.warn("⚠️ Failed to generate tech trend query dynamically, using fallback query.");
    return "latest tech developments open source compiler database backend";
  }
}

/**
 * Searches specifically for an image on Exa related to the given topic.
 */
export async function searchForImage(topic: string): Promise<string | undefined> {
  const exaKey = process.env.EXA_API_KEY;
  if (!exaKey || exaKey === 'your_exa_api_key_here') return undefined;

  try {
    const exa = getExa();
    console.log(`      🔍 Deep searching Exa specifically for an image on: "${topic}"...`);
    const searchRes = await exa.search(`${topic} photo image`, {
      numResults: 3,
      contents: {
        extras: {
          imageLinks: 5
        } as any
      }
    });
    for (const res of searchRes.results) {
      if (res.image) return res.image;
      const extraLinks = (res as any).imageLinks;
      if (extraLinks && extraLinks.length > 0) {
        return extraLinks[0];
      }
    }
  } catch (err: any) {
    console.warn(`      ⚠️ Failed to search for fallback image:`, err.message || err);
  }
  return undefined;
}

/**
 * Fetches the latest tech/AI news from Exa using a dynamically generated topic.
 */
export async function fetchLatestAINews(): Promise<{ context: string; articles: NewsArticle[] }> {
  try {
    const query = await generateTechTrendQuery();
    const exa = getExa();
    const oneDayAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    
    console.log(`      🔍 Deep searching Exa for latest developments on: "${query}"...`);
    const response = await exa.searchAndContents(
      query,
      {
        numResults: 5,
        startPublishedDate: oneDayAgo,
        highlights: {
          numSentences: 3
        },
        category: "news",
        contents: {
          highlights: true,
          extras: {
            imageLinks: 5
          }
        } as any
      }
    );
    
    let searchContext = '';
    const articles: NewsArticle[] = [];
    if (response.results && response.results.length > 0) {
      searchContext = response.results.map((res, i) => {
        const highlightStr = res.highlights ? res.highlights.join(' ') : '';
        articles.push({
          title: res.title || '',
          url: res.url || '',
          image: (res as any).image || null,
          highlights: res.highlights || null,
          imageLinks: (res as any).imageLinks || null
        });
        return `[Article ${i + 1}] Title: ${res.title}\nContext: ${highlightStr}\n`;
      }).join('\n');
    }
    
    return { context: searchContext, articles };
  } catch (error: any) {
    console.warn('      ⚠️ Exa news search failed:', error.message || error);
    return { context: '', articles: [] };
  }
}

/**
 * Helper to filter out news articles that cover topics we have recently posted about.
 */
async function filterDuplicateNews(articles: NewsArticle[], recentPosts: string[]): Promise<NewsArticle[]> {
  if (articles.length === 0 || recentPosts.length === 0) {
    return articles;
  }
  
  console.log(`      🤖 Filtering fetched news against ${recentPosts.length} recent posts...`);
  
  const articlesFormatted = articles.map((art, idx) => {
    return `[Article ${idx + 1}] Title: ${art.title}\nUrl: ${art.url}`;
  }).join('\n\n');
  
  const postsFormatted = recentPosts.map((post, idx) => `[Post ${idx + 1}] "${post.replace(/\n/g, ' ')}"`).join('\n');
  
  const prompt = `You are a tech/AI news filtering agent.
We want to avoid publishing posts about news events, company updates, or specific announcements that we have already posted about recently.

Here are our last 15 posts:
${postsFormatted}

Here are the candidate news articles we just fetched:
${articlesFormatted}

Identify which candidate articles are about the exact same news story, product launch, company update, or specific event as any of our recent posts.
For example, if we posted about "Anthropic Claude 3.5 Fable jailbreak" and a candidate article is about "Anthropic's Fable model being bricked", they cover the same topic and that article is a duplicate topic.

Respond with a JSON array of 1-based indices containing ONLY the articles that are NEW and DISTINCT (not covering any topic we recently posted about).
Format: [index1, index2, ...]
Example: If articles 1, 3, and 5 cover new distinct topics, return: [1, 3, 5]
If none of the articles are distinct, return: []
Do not include markdown code block formatting (like \`\`\`json). Return ONLY the raw JSON array.`;

  try {
    const responseText = await generateText(prompt, "Respond with only a JSON array of numbers.");
    let cleanText = responseText.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```json\s*/, '').replace(/```$/, '').trim();
    }
    const distinctIndices: number[] = JSON.parse(cleanText);
    const distinctArticles = distinctIndices
      .map(idx => articles[idx - 1])
      .filter((art): art is NewsArticle => !!art);
    
    console.log(`      🤖 Filtered out ${articles.length - distinctArticles.length} duplicate/similar news topics.`);
    return distinctArticles;
  } catch (err: any) {
    console.warn("      ⚠️ Error filtering duplicate news with LLM, using all articles as fallback:", err.message || err);
    return articles;
  }
}

/**
 * Generates a tweet based on the latest AI news fetched from Exa, avoiding topics in recentPosts.
 */
export async function generateTweetFromNews(
  recentPosts: string[] = [],
  options?: { isHarsh?: boolean }
): Promise<{ text: string; imageUrls?: string[] }> {
  const isHarsh = options?.isHarsh ?? false;
  const systemInstruction = isHarsh ? HARSH_TWEET_SYSTEM_PROMPT : TWEET_SYSTEM_PROMPT;
  
  const news = await fetchLatestAINews();
  
  if (!news.context || news.articles.length === 0) {
    console.log('      ⚠️ No news context available. Generating a general AI/tech topic post as fallback...');
    const generalPrompts = [
      "AI chip demand and GPU scaling bottlenecks",
      "the hype cycle of new LLM releases and benchmarks",
      "why local-first AI models running on consumer devices are better than cloud APIs",
      "VC funding trends in AI startups building wrapper apps",
      "software engineers trying to use AI to write code that they don't understand"
    ];
    const fallbackTopic = generalPrompts[Math.floor(Math.random() * generalPrompts.length)]!;
    
    const prompt = `Write a short post about this trend: "${fallbackTopic}"`;
    const text = await generateText(prompt, systemInstruction);
    // Text-only is the default normal behavior. No fallback image searches.
    return { text, imageUrls: [] };
  }
  
  // Filter the fetched articles based on recent posts
  const distinctArticles = await filterDuplicateNews(news.articles, recentPosts);
  
  if (distinctArticles.length === 0) {
    console.log('      ⚠️ All fetched news articles are similar to recent posts. Generating a distinct general AI/tech topic post...');
    const prompt = `Here are the last 15 posts we made:
${recentPosts.map((post, idx) => `[Post ${idx + 1}] "${post}"`).join('\n')}

We want to post about a general AI or software engineering topic that is NOT related to any of these recent posts.
Choose or generate a topic from this list (or create a new similar engineering/AI topic):
- AI chip demand and GPU scaling bottlenecks
- the hype cycle of new LLM releases and benchmarks
- why local-first AI models running on consumer devices are better than cloud APIs
- VC funding trends in AI startups building wrapper apps
- software engineers trying to use AI to write code that they don't understand

Write a short, witty, cynical post (under 280 characters) about the chosen topic. Ensure the topic is distinct from the recent posts.`;
    const text = await generateText(prompt, systemInstruction);
    
    // Text-only is the default normal behavior. No fallback image searches.
    return { text, imageUrls: [] };
  }

  // Treat all distinct articles normally (no image prioritization)
  let candidateArticles = distinctArticles;

  // Format context for only the distinct candidate articles
  const distinctContext = candidateArticles.map((art, idx) => {
    const highlightStr = art.highlights ? art.highlights.join(' ') : '';
    return `[Article ${idx + 1}] Title: ${art.title}\nContext: ${highlightStr}\n`;
  }).join('\n');
  
  const prompt = `Here are some recent news articles and developments in artificial intelligence and tech:
${distinctContext}

Choose the most interesting, significant, or hype-worthy development from the list (focusing on AI companies, models, chips, hardware, or startup funding) and write a short, witty, cynical, or sharp post about it. Do not just list the news; share a strong developer perspective, commentary, or critical/cynical take on it.

Make sure the tweet content is completely self-contained (do not say "According to this article" or include links). Just write the commentary/post directly.

Respond with a JSON object in this format:
{
  "selected_index": <number 1-${candidateArticles.length} indicating which article you commented on>,
  "tweet": "<your post text>",
  "image_required": <boolean, set to true ONLY if the post content absolutely requires a visual/image reference to be understood or effective, otherwise false>
}
Ensure it is a valid JSON object. Do not include markdown code block formatting (like \`\`\`json).`;

  try {
    const responseText = await generateText(prompt, systemInstruction);
    let cleanText = responseText.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```json\s*/, '').replace(/```$/, '').trim();
    }
    const data = JSON.parse(cleanText);
    const index = Number(data.selected_index);
    const text = data.tweet;
    const imageRequired = !!data.image_required;
    const selectedArticle = candidateArticles[index - 1] || candidateArticles[0];
    
    // Build candidate image URLs ONLY if the AI explicitly marked it as required
    const candidateUrls: string[] = [];
    if (imageRequired && selectedArticle) {
      if (selectedArticle.image) {
        candidateUrls.push(selectedArticle.image);
      }
      if (selectedArticle.imageLinks && selectedArticle.imageLinks.length > 0) {
        for (const link of selectedArticle.imageLinks) {
          if (link && !candidateUrls.includes(link)) {
            candidateUrls.push(link);
          }
        }
      }
    }

    return {
      text,
      imageUrls: candidateUrls
    };
  } catch (e) {
    console.warn("      ⚠️ Failed to parse LLM response as JSON. Falling back to direct generation.");
    // Fallback: retry with simpler instructions or get direct text (text-only)
    const fallbackPrompt = `Here are some recent news articles and developments in artificial intelligence and tech:
${distinctContext}

Choose the most interesting, significant, or hype-worthy development from the list (focusing on AI companies, models, chips, hardware, or startup funding) and write a short, witty, cynical, or sharp post about it. Do not just list the news; share a strong developer perspective, commentary, or critical/cynical take on it.
Do not include links, write the post directly.`;
    const text = await generateText(fallbackPrompt, systemInstruction);
    
    return { text, imageUrls: [] };
  }
}

/**
 * Checks if a tweet is related to technology, coding, AI, ML, chips/hardware, or tech companies.
 */
export async function isTechRelated(text: string): Promise<boolean> {
  if (!text || !text.trim()) return false;
  
  const prompt = `Analyze the following tweet text and determine if it is related to technology, software development, coding, artificial intelligence (AI), machine learning (ML), microchips/hardware (e.g. GPUs, CPUs, semiconductor manufacturing, NVIDIA, AMD, TSMC, Intel), tech companies (e.g., OpenAI, Google, Microsoft, Meta, Apple, tech startups), or general engineering and technology topics.
  
Tweet text: "${text}"

Respond with ONLY "YES" if the tweet is related to tech/AI, and ONLY "NO" if it is about general topics, politics, sports, general news, lifestyle, personal anecdotes without tech context, or other unrelated topics. Do not explain your reasoning.`;

  try {
    const response = await generateText(prompt, "Respond with only YES or NO.");
    return response.toUpperCase().includes('YES');
  } catch (error) {
    console.error("⚠️ Error checking if tweet is tech-related:", error);
    return false;
  }
}

