4chan-Thread-Muncher-9000 is a chrome extension that uses API (not HTML crawling) to monitor and download media from 4chan.

----

Click the extension icon to open the Muncher window.
You may close the tab from where you clicked the icon.
If the constant download popups are annoying, you can disable chrome's download thingy with another extension (search "Disable Download Shelf" or something similar).

----

Muncher is 99 % AI vibe coded, using free versions of Grok, Claude and Gemini.

Muncher tries to prevent downloading duplicates.
If you do want to redownload the same thread twice, use the Forget buttons.

You can add threads by ID or via a search (board + regex search string).
Multiple searches can be monitored at the same time.

----

CHANGELOG:

2025-08-07b
・ Added simultaneous watching of multiple searches of "board + regex search string".

2025-08-07a
・ Added history dropdown menu for convenience.
・ Added a UI element to change max concurrent threads.
・ Edited download delays to adapt to max concurrent threads to hopefully not anger 4chan API.

2025-04-06
・ Added the ability to ban usernames (to skip their posts).

2025-04-05
・ All threads now pause on exit.

-----

In background.js, you might want to adjust these values:

✱ const MANAGE_THREADS_INTERVAL = 1;
    Default value is 1 minute.
    Time between updating threads and performing checks.

✱ const STUCK_TIMER = 5 * 60 * 1000;
    Default value is 5 minutes.    
    Time until a thread is auto-closed when inactive. (based on timing may take longer by up to MANAGE_THREADS_INTERVAL)

✱ const RATE_LIMIT_MS = 1500;
    Default value is 1.5 seconds.
    Delay between downloading images in ms.
    [Update] No longer the main controller of delay, instead used when a request fails and needs to be retried.

-----

#4chan #Extension #Chrome #AI #Vibe_Coding
