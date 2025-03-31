4chan-Thread-Muncher-9000 is a chrome extension that uses API to monitor and download media from 4chan.

----

Click the extension icon to open the Muncher window.
You may close the tab from where you clicked the icon. 

----

Muncher is 99 % vibe coded, using free versions of Grok, Claude and Gemini.
Muncher has some quirks. Feel free to fix them.

Muncher tries to prevent downloading duplicates by various means.
If you want to redownload the same thread twice, use the Forget buttons.

You can add threads by ID or via a search (within a board).
Auto-adding threads is based on the last search.

----

Muncher uses 4chan API, not HTML crawling.
In background.js, you might want to adjust these values:

✱ const RATE_LIMIT_MS = 1500;
Delay between downloading images in ms.
Does not take into account parallel downloads. (room for improvement!)
Adjust at risk of provoking 4chan.

✱ const MAX_CONCURRENT_THREADS = 5;
Number of max threads running at the same time.
Adjust at risk of provoking 4chan.
