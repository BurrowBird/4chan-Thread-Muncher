# 4chan-Thread-Muncher
A chrome extension that uses API (not HTML crawling) to monitor and download media from 4chan.  
Muncher is 99 % AI vibe coded, using free versions of Grok, Claude and Gemini.

Click the extension icon to open the Muncher window. You may close the tab from where you clicked the icon.  
You can disable chrome's download popups with another extension (search "Disable Download Shelf" or similar).

<br>

## FEATURES: 
・ Add thread by ID.  
・ Add threads via a "watch job" (board + regex search string).  
・ Multiple watch jobs can run at the same time.  
・ Muncher prevents downloading duplicates. If you do want to redownload a thread, use the Forget buttons.  

<br>

## KNOWN ISSUES:
・ Some UI elements still don't update until the window is manually refocused.  

<br>

## CHANGELOG:
**2025-08-09**  
・ Fixed:  Watch Jobs don't pause processing when muncher window is closed.  

**2025-08-08c**  
・ Fixed: When adding a new Watch Job, downloads wait for the Next Update timer to run out.  
・ Fixed: Next Update timer doesn't show up until the window is manually refocused.  

**2025-08-08a**  
・ Improved rendering and fixed weird flashing buttons.  
・ New issue: Next Update timer doesn't show up until the window is manually refocused.  

**2025-08-07b**  
・ Added simultaneous watching of multiple searches ("board + regex search string").  

**2025-08-07a**  
・ Added history dropdown menus for convenience.  
・ Added a UI element to change max concurrent threads.  
・ Edited download delays to adapt to max concurrent threads.  

**2025-04-06**  
・ Added the ability to ban usernames (to skip their posts).  

<br>

## NOTES:
In background.js, you might want to adjust these values:

✱ **const MANAGE_THREADS_INTERVAL = 1;**  
    Default value is 1 minute.  
    Time between updating threads and performing checks.  

✱ **const STUCK_TIMER = 5 * 60 * 1000;**  
    Default value is 5 minutes.      
    Time until a thread is auto-closed when inactive. (based on timing may take longer by up to MANAGE_THREADS_INTERVAL)  

✱ **const RATE_LIMIT_MS = 1500;**  
    Default value is 1.5 seconds.  
    Delay between downloading images in ms.  
    [Update] No longer the main controller of delay, instead used when a request fails and needs to be retried.  

---

*#4chan #Extension #Chrome #AI #Vibe_Coding*








