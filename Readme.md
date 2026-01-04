# 4chan Thread Muncher
A chrome extension that uses API (not HTML crawling) to monitor and download media from 4chan.  
Muncher is 99 % AI vibe coded, using free versions of Grok, Claude and Gemini.

Click the extension icon to open the Muncher window. You may close the tab from where you clicked the icon.  

<br>

## FEATURES: 
・ Add threads manually by ID.  
・ Add threads automatically via a "watch job" (board + regex).  

・ Run multiple watch jobs at the same time.  
・ Add banned usernames (to skip their posts).  
・ Duplicate downloads prevention.  

・ Checkbox: Hide the browser's download icon.  
・ Checkbox: Auto-remove muncher downloads from the browser's download list.  
・ Checkbox: Prepend name of parent folders to files.  

<br>

## KNOWN ISSUES:
・ Issues related to the Muncher window not being focused and then timing out in various ways.  
・ "Check All" button broken in latest version? Seems to do nothing now.  

<br>

## CHANGELOG:
**2025-08-17**  
・ $\color{Lime}{\textsf{Added}}$ a visual indicator for time left before a thread auto-closes.  
・ $\color{Lime}{\textsf{Added}}$ a "Hide Inactive" checkbox. Hides closed or errored threads from the list.  
・ $\color{Lime}{\textsf{Added}}$ a "Add PName" checkbox. Prepends name of parent folders to files. (parentname｜filename.ext)  
・ $\color{Lime}{\textsf{Added}}$ a "Hide DL Icon" checkbox. If checked, the browser's download icon is hidden.  
・ $\color{Lime}{\textsf{Added}}$ a "Populate DLs" checkbox. If unchecked, downloads are auto-removed from the browser's download list.  
・ $\color{Purple}{\textsf{Improved}}$ spacing of some UI elements.  
・ $\color{Purple}{\textsf{Improved}}$ some log text colors.  
・ $\color{Purple}{\textsf{Improved}}$ heartbeat mechanisms to help with timing out issues.  
・ $\color{Yellow}{\textsf{Fixed}}$: Stuck timer never closing a thread.  
・ $\color{Yellow}{\textsf{Fixed}}$: UI can disappear if unfocused and needs a manual refocus.  
・ $\color{Yellow}{\textsf{Fixed}}$: Some UI elements don't update until the window is manually refocused.  
・ $\color{Yellow}{\textsf{Fixed}}$: Watch jobs don't pause on muncher window exit.  
・ $\color{Red}{\textsf{Removed}}$ content-script.js - no longer needed.  
・ $\color{Red}{\textsf{Removed}}$ activeTab permission - no longer needed.  

**2025-08-09**  
・ $\color{Lime}{\textsf{Added}}$ simultaneous watching of multiple searches ("board + regex").  
・ $\color{Lime}{\textsf{Added}}$ history dropdown menus for convenience.  
・ $\color{Lime}{\textsf{Added}}$ a UI element to change max concurrent threads.  
・ $\color{Lime}{\textsf{Added}}$ the ability to ban usernames.  
・ $\color{Purple}{\textsf{Improved}}$ rendering and fixed weird flashing buttons.  
・ $\color{Purple}{\textsf{Improved}}$ download delays to adapt to max concurrent threads.  
・ $\color{Yellow}{\textsf{Fixed}}$:  Watch Jobs don't pause processing when muncher window is closed.  
・ $\color{Yellow}{\textsf{Fixed}}$: When adding a new Watch Job, downloads wait for the Next Update timer to run out.  
・ $\color{Yellow}{\textsf{Fixed}}$: Next Update timer doesn't show up until the window is manually refocused.  
・ $\color{Red}{\textsf{New Issue}}$: Some UI elements don't update until the window is manually refocused.  

---
*#4chan #Extension #Chrome #AI #Vibe_Coding*
































