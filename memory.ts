import * as fs from 'fs';
import * as path from 'path';
import { generateText } from './llm';

const MEMORY_DIR = path.resolve(process.cwd(), 'user_data');
const MEMORY_FILE = path.resolve(MEMORY_DIR, 'post_memory.json');

interface MemoryData {
  postedTexts: string[];
  interactedUrls: string[];
}

// Ensure the memory file exists and returns the data
function loadMemory(): MemoryData {
  try {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    if (!fs.existsSync(MEMORY_FILE)) {
      const initial: MemoryData = { postedTexts: [], interactedUrls: [] };
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    const content = fs.readFileSync(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return {
      postedTexts: Array.isArray(parsed.postedTexts) ? parsed.postedTexts : [],
      interactedUrls: Array.isArray(parsed.interactedUrls) ? parsed.interactedUrls : [],
    };
  } catch (err: any) {
    console.error(`⚠️ Error loading memory from ${MEMORY_FILE}:`, err.message || err);
    return { postedTexts: [], interactedUrls: [] };
  }
}

// Saves the memory data back to the file
function saveMemory(data: MemoryData): void {
  try {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err: any) {
    console.error(`⚠️ Error saving memory to ${MEMORY_FILE}:`, err.message || err);
  }
}

/**
 * Checks if a candidate post text is too semantically similar to any of the last 100 posts using AI.
 */
export async function isSimilarToRecentPosts(candidate: string): Promise<boolean> {
  const memory = loadMemory();
  const recentPosts = memory.postedTexts;

  if (recentPosts.length === 0) {
    return false;
  }

  // First do a simple exact match fallback to avoid LLM call for exact matches
  const normCandidate = candidate.trim().toLowerCase().replace(/\s+/g, ' ');
  const exactMatch = recentPosts.some(p => p.trim().toLowerCase().replace(/\s+/g, ' ') === normCandidate);
  if (exactMatch) {
    console.log(`      🔍 Exact duplicate detected locally for text: "${candidate.substring(0, 40)}..."`);
    return true;
  }

  console.log(`      🤖 Querying AI to check similarity of candidate post with the last ${recentPosts.length} posts...`);
  
  // Format the posts with indexes so the LLM can scan them easily
  const formattedPosts = recentPosts
    .map((post, idx) => `[Post ${idx + 1}] "${post.replace(/\n/g, ' ')}"`)
    .join('\n');

  const prompt = `You are a content filtering system for a technology Twitter bot.
Your job is to prevent the bot from posting tweets that are redundant, cover the exact same news story/topic/announcement, or sound too similar to what it has posted recently.

Here is the numbered list of recently posted tweets (starting from most recent):
${formattedPosts}

Here is the new candidate tweet to evaluate:
"${candidate}"

Does this new candidate tweet talk about the exact same news event, update, or topic, or does it sound extremely similar to any of the recent tweets above?
Only reply with "YES" if it is too similar/redundant, or "NO" if it is sufficiently distinct and covers a different update or perspective. Do not write any other explanation.`;

  try {
    const response = await generateText(prompt, "Respond with only YES or NO.");
    const isSimilar = response.toUpperCase().includes('YES');
    console.log(`      🤖 AI Similarity decision: ${isSimilar ? '⚠️ SIMILAR (REJECT)' : '✅ DISTINCT (ACCEPT)'} (AI Response: "${response.trim()}")`);
    return isSimilar;
  } catch (err: any) {
    console.error(`      ⚠️ Failed to run AI similarity check, falling back to local text matching:`, err.message || err);
    return false;
  }
}

/**
 * Adds a new post text to the persistent history, keeping only the last 100.
 */
export function recordPostedText(text: string): void {
  const memory = loadMemory();
  
  // Remove existing duplicate if present to move it to the front
  memory.postedTexts = memory.postedTexts.filter(p => p.trim() !== text.trim());
  
  // Insert at the front (most recent)
  memory.postedTexts.unshift(text.trim());
  
  // Keep only the last 100
  memory.postedTexts = memory.postedTexts.slice(0, 100);
  
  saveMemory(memory);
  console.log(`      💾 Saved new post to persistent memory. Total remembered posts: ${memory.postedTexts.length}`);
}

/**
 * Checks if a tweet URL has already been interacted with.
 */
export function hasInteractedWithUrl(url: string): boolean {
  const memory = loadMemory();
  return memory.interactedUrls.some(u => u.trim().toLowerCase() === url.trim().toLowerCase());
}

/**
 * Adds a tweet URL to the interacted list, keeping only the last 100.
 */
export function recordInteractedUrl(url: string): void {
  const memory = loadMemory();
  
  // Remove existing duplicate if present to move it to the front
  memory.interactedUrls = memory.interactedUrls.filter(u => u.trim().toLowerCase() !== url.trim().toLowerCase());
  
  // Insert at the front (most recent)
  memory.interactedUrls.unshift(url.trim());
  
  // Keep only the last 100
  memory.interactedUrls = memory.interactedUrls.slice(0, 100);
  
  saveMemory(memory);
  console.log(`      💾 Saved interacted URL to persistent memory. Total remembered URLs: ${memory.interactedUrls.length}`);
}
