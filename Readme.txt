4chan-Thread-Muncher-9000 is a chrome extension that uses API to monitor and download media from 4chan.

----

Click the extension icon to open the Muncher window.
You may close the tab from where you clicked the icon. 
If the constant download popups are annoying, you can disable chrome's download thingy with another extension (search "Disable Download Shelf" or something similar).

----

Muncher is 99 % vibe coded, using free versions of Grok, Claude and Gemini.
Muncher has some quirks. Feel free to fix them.

Muncher tries to prevent downloading duplicates by various means.
If you want to redownload the same thread twice, use the Forget buttons.

You can add threads by ID or via a search (within a board).
Auto-adding threads is based on the last search.

----

KNOWN ISSUES:
Downloads resume before the control window is open.

-----

Muncher uses 4chan API, not HTML crawling.
In background.js, you might want to adjust these values:

✱ const RATE_LIMIT_MS = 1500;
    Default value is 1.5 seconds.
    Delay between downloading images in ms.
    Adjust at risk of provoking 4chan.

✱ const MAX_CONCURRENT_THREADS = 5;
    Default value is 5.
    Number of max threads running at the same time.
    Adjust at risk of provoking 4chan.

✱ const STUCK_TIMER = 5 * 60 * 1000;
    Default value is 5 minutes.    
    Time until a thread is auto-closed when inactive. (actually may take longer by up to MANAGE_THREADS_INTERVAL)

✱ const MANAGE_THREADS_INTERVAL = 1;
    Default value is 1 minute.
    Time between updating threads and performing checks.
