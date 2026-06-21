import { generateReplyWithSearch } from './llm';

async function main() {
  console.log("Testing llm.ts generateReplyWithSearch...");
  
  try {
    console.log("\n--- TEST CASE 1: Query requiring search (Expect search to run & retrieve facts, allowing harsh tone) ---");
    const reply1 = await generateReplyWithSearch("What was the final score of the Euro 2024 final match between Spain and England?");
    console.log(`Generated Reply 1:\n"${reply1}"`);
  } catch (error: any) {
    console.error("Test case 1 failed:", error.message || error);
  }

  try {
    console.log("\n--- TEST CASE 2: General comment NOT requiring search (Should NOT allow harsh tone, only straight/good) ---");
    const reply2 = await generateReplyWithSearch("Good morning everyone, I hope you have a nice Sunday!");
    console.log(`Generated Reply 2:\n"${reply2}"`);
  } catch (error: any) {
    console.error("Test case 2 failed:", error.message || error);
  }
}

main();
