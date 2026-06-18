# Twitter/X Automation Bot

An autonomous agent that monitors tech/AI developments, posts updates, and interacts with the Twitter/X timeline.

## How It Works

1. **Browser Session & Authentication**
   - The bot launches a local Google Chrome browser instance via Puppeteer.
   - On the first run, if no valid authentication session is found, it pauses and waits for you to manually complete the login process in the browser window.
   - Once logged in, it extracts the session cookies and writes them to the local `user_data` directory.
   - Subsequent runs will restore this session from the `user_data` folder automatically, removing the need to log in again.

2. **Autonomous Timeline & Trend Monitoring**
   - The bot performs web searches (via Exa) to keep track of the latest announcements and engineering updates in AI, compilers, hardware, and database technologies.
   - It references recent posting history stored in `user_data/post_memory.json` to prevent publishing redundant or similar topics.

3. **Posting & Interactions**
   - **Post News/Trends:** Generates commentary on recent articles and publishes them as new posts.
   - **Quote Reposts:** Quotes timeline tweets with a custom comment.
   - **Replies:** Analyzes timeline tweets and generates direct, contextually relevant replies (mixed between encouraging, critical, or blunt tones).
   - **Liking:** Likes relevant timeline tweets.

4. **Image Handling**
   - Posts are text-only by default to mimic normal user behavior.
   - An image is only downloaded and posted if the generated post explicitly benefits from visual context and the target news article provides a valid image link.

---

## Setup & Running

### Installation

Install dependencies using Bun:
```bash
bun install
```

### Configuration

Create a `.env` file in the root directory and add your API credentials:
```env
LLM_PROVIDER=gemini       # e.g., gemini, openai, deepseek, groq
GEMINI_API_KEY=your_key   # or OPENAI_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY
EXA_API_KEY=your_key
```

### Run the Bot

To start the bot in production loop mode:
```bash
bun run start
```

To run a quick 2-iteration dry run to verify logic and session persistence:
```bash
bun run start:test
```
