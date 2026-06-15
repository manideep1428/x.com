import { generateTweet } from './llm';

async function main() {
  console.log("Testing llm.ts...");
  try {
    const text = await generateTweet("Next.js 16 release");
    console.log(`Generated Tweet: "${text}"`);
  } catch (error: any) {
    console.error("Test execution failed:", error.message || error);
  }
}

main();
