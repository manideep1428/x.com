import OpenAI from 'openai';
import Exa from 'exa-js';
import { GoogleGenAI } from '@google/genai';
import { TWEET_SYSTEM_PROMPT, REPLY_SYSTEM_PROMPT } from './prompt';

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
  // Check if Exa is configured
  const exaKey = process.env.EXA_API_KEY;
  if (!exaKey || exaKey === 'your_exa_api_key_here') {
    console.log('   ⚠️ EXA_API_KEY is not configured. Skipping web search and replying directly.');
    return generateText(
      `Write a concise reply to this tweet: "${tweetText}"`,
      REPLY_SYSTEM_PROMPT
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

        return generateText(promptWithContext, REPLY_SYSTEM_PROMPT);
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
    REPLY_SYSTEM_PROMPT
  );
}

export interface NewsArticle {
  title: string;
  url: string;
  image: string | null;
}

/**
 * Fetches the latest AI and tech news from Exa.
 */
export async function fetchLatestAINews(): Promise<{ context: string; articles: NewsArticle[] }> {
  try {
    const exa = getExa();
    const oneDayAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    
    console.log('      🔍 Searching Exa for latest AI/tech developments...');
    const response = await exa.searchAndContents(
      "latest AI news developments chips companies NVIDIA OpenAI Anthropic startup model",
      {
        numResults: 5,
        startPublishedDate: oneDayAgo,
        highlights: {
          numSentences: 3
        },
        category: "news"
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
          image: (res as any).image || null
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
 * Generates a tweet based on the latest AI news fetched from Exa.
 */
export async function generateTweetFromNews(): Promise<{ text: string; imageUrl?: string }> {
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
    const text = await generateTweet(fallbackTopic);
    return { text };
  }
  
  const prompt = `Here are some recent news articles and developments in artificial intelligence and tech:
${news.context}

Choose the most interesting, significant, or hype-worthy development from the list (focusing on AI companies, models, chips, hardware, or startup funding) and write a short, witty, cynical, or sharp post about it. Do not just list the news; share a strong developer perspective, commentary, or critical/cynical take on it.

Make sure the tweet content is completely self-contained (do not say "According to this article" or include links). Just write the commentary/post directly.

Respond with a JSON object in this format:
{
  "selected_index": <number 1-5 indicating which article you commented on>,
  "tweet": "<your post text>"
}
Ensure it is a valid JSON object. Do not include markdown code block formatting (like \`\`\`json).`;

  try {
    const responseText = await generateText(prompt, TWEET_SYSTEM_PROMPT);
    let cleanText = responseText.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```json\s*/, '').replace(/```$/, '').trim();
    }
    const data = JSON.parse(cleanText);
    const index = Number(data.selected_index);
    const text = data.tweet;
    const selectedArticle = news.articles[index - 1];
    return {
      text,
      imageUrl: selectedArticle?.image || undefined
    };
  } catch (e) {
    console.warn("      ⚠️ Failed to parse LLM response as JSON. Falling back to direct generation.");
    // Fallback: retry with simpler instructions or get direct text
    const fallbackPrompt = `Here are some recent news articles and developments in artificial intelligence and tech:
${news.context}

Choose the most interesting, significant, or hype-worthy development from the list (focusing on AI companies, models, chips, hardware, or startup funding) and write a short, witty, cynical, or sharp post about it. Do not just list the news; share a strong developer perspective, commentary, or critical/cynical take on it.
Do not include links, write the post directly.`;
    const text = await generateText(fallbackPrompt, TWEET_SYSTEM_PROMPT);
    return { text };
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

