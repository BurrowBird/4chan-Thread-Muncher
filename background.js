console.log("Content script loaded.");
// No messaging needed unless explicitly required

let isRunning = false;
let watchedThreads = [];
let downloadedImages = new Map(); // Map<fullPath: string, { timestamp: number, threadId: number }>
let watchJobs = []; // -- NEW: Replaces lastSearchParams for multi-watching
let bannedUsernames = new Set(); // Set<string> - stores lowercase usernames
let activeDownloads = new Map(); // Map<downloadKey: string, downloadId: number | boolean> - boolean used for 'processing' state
let downloadLocks = new Map(); // Map<downloadKey: string, Promise<void>>
let openerTabId = null;
let windowId = null;
let threadProgressTimers = new Map(); // Map<threadId: number, timestamp: number>
let isResuming = false;
let lastResumeTime = 0;
let lastLogMessage = null;
let isInitialized = false;

// --- MODIFIED: Use 'let' and load from storage ---
let downloadPath = '4chan_downloads'; // -- NEW: Global download path
let MAX_CONCURRENT_THREADS = 5; 
const STUCK_TIMER = 5 * 60 * 1000; // 5 minutes
const MANAGE_THREADS_INTERVAL = 1; // 1 minute

const RATE_LIMIT_MS = 1500;
const MAX_DOWNLOADED_IMAGES = 18000; // Limit history size
const MIN_RESUME_INTERVAL = 1000;
const MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 15000;


// --- NEW: Global API Rate Limiter ---
const requestQueue = [];
let isQueueProcessing = false;
const API_REQUEST_INTERVAL = 1100; // 1.1 seconds, slightly above the 1s limit for safety

async function processQueue() {
    if (requestQueue.length === 0) {
        isQueueProcessing = false;
        return;
    }

    isQueueProcessing = true;
    const requestToProcess = requestQueue.shift(); // Get the oldest request

    try {
        await requestToProcess(); // Execute the async function (e.g., fetchWithRetry)
    } catch (error) {
        log(`Rate-limited request failed: ${error.message}`, "error");
    }

    // Wait for the interval before processing the next item
    setTimeout(processQueue, API_REQUEST_INTERVAL);
}

function scheduleRequest(asyncFunc) {
    return new Promise((resolve, reject) => {
        // Wrap the original function to resolve the promise with its result
        const wrappedFunc = async () => {
            try {
                const result = await asyncFunc();
                resolve(result);
            } catch (error) {
                reject(error);
            }
        };

        requestQueue.push(wrappedFunc);
        if (!isQueueProcessing) {
            processQueue();
        }
    });
}
// --- END: Global API Rate Limiter ---


function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function log(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString();

  // Basic log deduplication for common repetitive messages
  if (((message.startsWith("checkForNewThreads: Searching") || message.startsWith("searchAndWatchThreads: No new")) && lastLogMessage === message)) {
    return;
  }

  console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
  lastLogMessage = message;

  if (windowId) {
    chrome.windows.get(windowId, {}, (win) => {
      if (chrome.runtime.lastError) {
        // console.warn(`[${timestamp}] Window ${windowId} not found for logging: ${chrome.runtime.lastError.message}`);
        return; // Don't reset windowId here, it might reappear
      }
      if (win) {
        chrome.runtime.sendMessage({ type: "log", message: message, logType: type }, () => {
          if (chrome.runtime.lastError) {
            // console.warn(`[${timestamp}] Log message send failed: ${chrome.runtime.lastError.message}`);
          }
        });
      }
    });
  }
}

async function fetchWithRetry(url) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (!isRunning && !isInitialized) throw new Error("Process stopped during fetch"); // Allow fetch during init
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      return await response.json();
    } catch (error) {
      log(`Fetch failed for ${url}: ${error.message}. Retry ${i + 1}/${MAX_RETRIES}`, "warning");
      if (i === MAX_RETRIES - 1) {
        log(`Max retries reached for ${url}, giving up fetch`, "error");
        throw error; // Re-throw the last error
      }
      // Only delay if retrying
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS * (i + 1))); // Basic backoff
    }
  }
  throw new Error(`Fetch failed for ${url} after ${MAX_RETRIES} retries.`); // Should be unreachable but safer
}

function getFullPath(threadId, username, filename) {
  const sanitizedUsername = username ? username.replace(/[^a-zA-Z0-9_.-]/g, "_") : "Anonymous";
  const sanitizedFilename = filename ? filename.replace(/[^a-zA-Z0-9_.-]/g, "_") : "unknown_file";
  // Ensure download path doesn't have leading/trailing slashes for consistency
  const cleanDownloadPath = downloadPath.replace(/^\/+|\/+$/g, '');
  return `${cleanDownloadPath}/${threadId}/${sanitizedUsername}/${sanitizedFilename}`;
}

async function downloadImage(url, threadId, username) {
    const filename = url.split('/').pop();
    const thread = watchedThreads.find(t => t.id === threadId);
    if (!thread) {
        log(`Thread ${threadId} not found for ${url}`, "error");
        return { success: false, downloaded: false };
    }

    // Ensure thread properties are initialized
    thread.skippedImages = thread.skippedImages || new Set();
    thread.downloadedCount = thread.downloadedCount || 0;
    thread.totalImages = thread.totalImages || 0;

    // --- Banned Username Check ---
    // Use raw username (converted to lowercase) for matching the ban list
    const rawUsernameLower = (username || 'Anonymous').toLowerCase();
    if (bannedUsernames.has(rawUsernameLower)) {
        if (!thread.skippedImages.has(filename)) {
            thread.skippedImages.add(filename);
            thread.downloadedCount = Math.min(thread.skippedImages.size, thread.totalImages);
            log(`Skipped image ${filename} for thread ${threadId}: User "${username}" is banned. Count: ${thread.downloadedCount}/${thread.totalImages}`, "info");
            updateWatchedThreads(); // Save updated thread state
            debouncedUpdateUI();    // Update UI
        }
        return { success: true, downloaded: false }; // Treat as success (skipped), not downloaded
    }
    // --- End Banned Username Check ---


    const fullPath = getFullPath(threadId, username, filename);
    const downloadKey = `${threadId}-${filename}`; // Used for locks and active downloads map

    // Lock handling
    if (downloadLocks.has(downloadKey)) {
        await downloadLocks.get(downloadKey); // Wait for existing lock on this specific file
    }
    let resolveLock;
    const lockPromise = new Promise(resolve => { resolveLock = resolve; });
    downloadLocks.set(downloadKey, lockPromise);

    try {
        const isAlreadyDownloaded = downloadedImages.has(fullPath);
        const isAlreadySkipped = thread.skippedImages.has(filename);

        // If already known
        if (isAlreadyDownloaded || isAlreadySkipped) {
            if (!isAlreadySkipped) {
                thread.skippedImages.add(filename);
                thread.downloadedCount = Math.min(thread.skippedImages.size, thread.totalImages);
                updateWatchedThreads();
            }
            return { success: true, downloaded: false };
        }

        // Check if the thread is active *before* attempting download
        if (!thread.active) {
            // log(`Download skipped for ${url}: Thread ${threadId} is inactive (pre-check)`, "info");
            return { success: false, downloaded: false };
        }

        // --- Download attempt loop ---
        for (let i = 0; i < MAX_RETRIES; i++) {
             // Check global running state and thread active state *before each attempt*
            if (!isRunning || !watchedThreads.find(t => t.id === threadId)?.active) {
                 throw new Error("Process or thread stopped before download attempt");
            }
            let downloadId = null;

            try {
                // log(`Attempting download (${i + 1}/${MAX_RETRIES}): ${filename} for thread ${threadId}`, "info"); // Can be noisy
                downloadId = await new Promise((resolve, reject) => {
                    chrome.downloads.download({
                        url,
                        filename: fullPath,
                        conflictAction: 'uniquify'
                    }, (id) => {
                        if (chrome.runtime.lastError || id === undefined) {
                            reject(new Error(`Download initiation failed: ${chrome.runtime.lastError?.message || 'Unknown error or invalid ID'}`));
                        } else {
                            resolve(id);
                        }
                    });
                });

                activeDownloads.set(downloadKey, downloadId);

                // --- Wait for download completion or interruption ---
                const downloadResult = await new Promise((resolve, reject) => {
                    let listener = null;
                    const timeoutId = setTimeout(() => {
                        log(`Download timed out for ${filename} (ID: ${downloadId}) after ${DOWNLOAD_TIMEOUT_MS}ms`, "warning");
                        if (listener) chrome.downloads.onChanged.removeListener(listener);
                        activeDownloads.delete(downloadKey);
                        if (downloadId) {
                            chrome.downloads.cancel(downloadId, () => { chrome.downloads.erase({ id: downloadId }); });
                        }
                        reject(new Error("Download timed out"));
                    }, DOWNLOAD_TIMEOUT_MS);

                    listener = (delta) => {
                        if (delta.id === downloadId) {

                            // Handle completion
                            if (delta.state && delta.state.current === "complete") {
                                clearTimeout(timeoutId);
                                chrome.downloads.onChanged.removeListener(listener);
                                activeDownloads.delete(downloadKey);
                                resolve(true); // Success!
                            }
                            // Handle interruption
                            else if (delta.state && delta.state.current === "interrupted") {
                                clearTimeout(timeoutId);
                                chrome.downloads.onChanged.removeListener(listener);
                                activeDownloads.delete(downloadKey);
                                log(`Download interrupted for ${filename} (ID: ${downloadId}). Reason: ${delta.error?.current || 'Unknown'}`, "warning");
                                chrome.downloads.erase({ id: downloadId });
                                reject(new Error(`Download interrupted: ${delta.error?.current || 'Unknown reason'}`));
                            }
                        }
                    };
                    chrome.downloads.onChanged.addListener(listener);
                });

                // --- Post-successful download logic ---
                if (downloadResult === true) {
                    downloadedImages.set(fullPath, { timestamp: Date.now(), threadId });
                    if (!thread.skippedImages.has(filename)) { thread.skippedImages.add(filename); }
                    thread.downloadedCount = Math.min(thread.skippedImages.size, thread.totalImages);

                    if (downloadedImages.size > MAX_DOWNLOADED_IMAGES) {
                        const oldest = Array.from(downloadedImages.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
                        downloadedImages.delete(oldest[0]);
                        log(`Removed oldest entry (${oldest[0]}) from downloadedImages to maintain size limit`, "info");
                    }

                    chrome.storage.local.set({ downloadedImages: Array.from(downloadedImages.entries()) });
                    updateWatchedThreads();
                    log(`Successfully downloaded ${filename} to ${fullPath} for thread ${threadId}`, "success");
                    debouncedUpdateUI();
                    return { success: true, downloaded: true };
                }
                throw new Error("Download completion promise resolved unexpectedly.");

            } catch (error) {
                activeDownloads.delete(downloadKey);
                if (downloadId) { chrome.downloads.erase({ id: downloadId }); }
                log(`Download attempt ${i + 1}/${MAX_RETRIES} failed for ${url}: ${error.message}`, "warning");

                if (i === MAX_RETRIES - 1) {
                    log(`Max retries reached for ${url}, marking as failed for this run`, "error");
                } else {
                    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS * (i + 1)));
                    // Check global running state and thread active state *before next retry*
                    if (!isRunning || !watchedThreads.find(t => t.id === threadId)?.active) {
                        log(`Stopping retries for ${filename} as thread ${threadId} or process became inactive during wait`, "warning");
                        throw new Error("Thread or process inactive during retry wait"); // Break retry loop
                    }
                }
            }
        }
        // If the loop finishes without returning success
        throw new Error(`Download failed permanently for ${filename} after ${MAX_RETRIES} retries`);

    } catch (error) {
        log(`Failed to download ${filename} for thread ${threadId}: ${error.message}`, "error");
        activeDownloads.delete(downloadKey);
        return { success: false, downloaded: false };
    } finally {
        if (resolveLock) resolveLock();
        downloadLocks.delete(downloadKey);
    }
}

const handleDownloadCreated = debounce((downloadItem) => {
  // This listener primarily handles CANCELLING duplicate downloads created by Chrome's 'uniquify'
  // It also ensures the base file is marked as 'skipped' in the thread state if a duplicate was cancelled.
  try {
    if (!downloadItem || typeof downloadItem.filename !== 'string' || !downloadItem.id) {
      log(`Invalid downloadItem in onCreated listener: ${JSON.stringify(downloadItem)}`, "warning");
      return;
    }

    const fullPath = downloadItem.filename.replace(/\\/g, '/');
    const pathParts = fullPath.split('/');
    if (pathParts.length < 4) return; // Expecting downloadPath/threadId/username/filename structure

    const filename = pathParts[pathParts.length - 1]; // Get filename part
    const username = pathParts[pathParts.length - 2]; // Get username part
    const threadIdStr = pathParts[pathParts.length - 3]; // Get thread ID part
    const downloadBasePath = pathParts.slice(0, -3).join('/'); // Get base download path

    // Basic validation
    if (!filename || !username || !threadIdStr || isNaN(parseInt(threadIdStr))) return;
    const threadId = parseInt(threadIdStr);

    // Check if the filename indicates a Chrome-generated duplicate (e.g., "image (1).jpg")
    const duplicateMatch = filename.match(/^(.*) \((\d+)\)(\.\w+)$/);
    if (duplicateMatch) {
      const baseFilename = duplicateMatch[1] + duplicateMatch[3]; // Reconstruct original filename
      const baseFullPath = `${downloadBasePath}/${threadId}/${username}/${baseFilename}`; // Reconstruct original full path

      // Check if the *original* file path is already known in our master downloaded list
      const isOriginalDownloaded = downloadedImages.has(baseFullPath);

      if (isOriginalDownloaded) {
        // If the original is known, cancel this duplicate download
        log(`Detected duplicate download: ${filename}. Cancelling ID ${downloadItem.id}.`, "info");
        chrome.downloads.cancel(downloadItem.id, () => {
          if (chrome.runtime.lastError) {
            log(`Failed to cancel duplicate download ${downloadItem.id} (${filename}): ${chrome.runtime.lastError.message}`, "warning");
          } else {
            // Successfully cancelled, now erase it from history/disk
            chrome.downloads.erase({ id: downloadItem.id });

            // Ensure the original base filename is marked as skipped in the corresponding thread object
            const thread = watchedThreads.find(t => t.id === threadId);
            if (thread) {
              thread.skippedImages = thread.skippedImages || new Set(); // Ensure the set exists
              if (!thread.skippedImages.has(baseFilename)) {
                thread.skippedImages.add(baseFilename);
                // --- Crucial: Update count based on set size and cap ---
                thread.downloadedCount = Math.min(thread.skippedImages.size, thread.totalImages);
                log(`Marked base file ${baseFilename} as skipped for thread ${threadId} due to cancelled duplicate. New count: ${thread.downloadedCount}`, "info");
                updateWatchedThreads(); // Save the updated thread state
                debouncedUpdateUI(); // Update the UI
              }
            }
          }
        });
      } else {
        // If the original isn't in our map, this might be a legitimate file with "(n)" in name, or the first download is still pending. Let it proceed.
        // log(`Download ${filename} looks like a duplicate, but original ${baseFilename} not found in map. Allowing download.`, "debug");
      }
    }
  } catch (error) {
    log(`Error in downloads.onCreated listener: ${error.message}`, "error");
  }
}, 250); // Debounce slightly longer

chrome.downloads.onCreated.addListener(handleDownloadCreated);

let updateQueue = []; // Simple flag/queue for debouncing UI updates
const debouncedUpdateUI = debounce(() => {
  if (updateQueue.length > 0 || true) { // Always update if called? Or use queue length? Let's always update for simplicity.
    updateUI();
    updateQueue = []; // Reset queue/flag
  }
}, 600); // Debounce UI updates slightly longer

function updateUI() {
  if (windowId) {
    chrome.windows.get(windowId, {}, (win) => {
      if (chrome.runtime.lastError || !win) {
        // Window closed or doesn't exist, no need to warn constantly
        // log(`Control window ${windowId} not found for UI update.`, "info");
        // windowId = null; // Consider if resetting windowId here is desired. Maybe not, it might reappear.
        return;
      }
      // Send status to the control window
      chrome.runtime.sendMessage({
        type: "updateStatus",
        isRunning: watchedThreads.some(t => t.active && !t.closed), // isRunning based on actual active threads
        watchedThreads: watchedThreads.map(thread => ({
          ...thread,
          skippedImages: Array.from(thread.skippedImages || new Set()), // Convert Set to array for serialization
          downloadedCount: thread.downloadedCount || 0,
          totalImages: thread.totalImages || 0
        })),
        trackedDownloads: downloadedImages.size,
        watchJobs: watchJobs, // --- NEW: Send watch jobs to UI
        bannedUsernames: Array.from(bannedUsernames), // Send banned list
        nextManageThreads: chrome.alarms.get("manageThreads")?.scheduledTime || null, // Get next alarm time
        maxConcurrentThreads: MAX_CONCURRENT_THREADS // --- NEW: Send current value to UI
      }, () => {
          if (chrome.runtime.lastError) {
              // Suppress common errors like "Receiving end does not exist" if window closed between get and send
              if (!chrome.runtime.lastError.message.includes("Receiving end does not exist")) {
                 log(`UI update message failed: ${chrome.runtime.lastError.message}`, "warning");
              }
          }
      });
    });
  }
}

function deduplicateWatchedThreads() {
  const seenIds = new Set();
  const uniqueThreads = [];
  for (const thread of watchedThreads) {
    if (seenIds.has(thread.id)) {
      log(`Removed duplicate thread entry ${thread.id} (${thread.title}) during deduplication`, "warning");
    } else {
      seenIds.add(thread.id);
      uniqueThreads.push(thread);
    }
  }
  if (uniqueThreads.length !== watchedThreads.length) {
      watchedThreads = uniqueThreads;
      // No need to call updateWatchedThreads here, caller will do it.
      return true; // Indicate changes were made
  }
  return false; // Indicate no changes
}

function updateWatchedThreads() {
  const changed = deduplicateWatchedThreads(); // Ensure no duplicate thread objects by ID
  // Ensure counts are capped after any potential external modification
  let corrected = false;
  watchedThreads.forEach(t => {
      const newCount = Math.min(t.skippedImages?.size || 0, t.totalImages || 0);
      if (t.downloadedCount !== newCount) {
          // log(`Correcting count for ${t.id} in updateWatchedThreads: ${t.downloadedCount} -> ${newCount}`, "debug");
          t.downloadedCount = newCount;
          corrected = true;
      }
  });
  if(changed || corrected){
      log("Persisting watched thread changes to storage.", "debug");
  }

  // Convert Sets to Arrays for storage
  const storableThreads = watchedThreads.map(thread => ({
      ...thread,
      skippedImages: Array.from(thread.skippedImages || new Set())
  }));

  chrome.storage.local.set({ watchedThreads: storableThreads }, () => {
    if (chrome.runtime.lastError) {
      log(`Error saving watchedThreads to storage: ${chrome.runtime.lastError.message}`, "error");
    }
    debouncedUpdateUI(); // Update UI after saving potentially changed threads
  });
}

async function processThread(thread) {
  if (!thread || !thread.id) {
      log("processThread called with invalid thread object", "error");
      return;
  }
  const threadUrl = thread.url;
  //log(`Processing thread "${thread.title}" (${thread.id})`, "info");
  activeDownloads.set(`${thread.id}-processing`, true); // Mark thread as being processed

  try {
    // --- MODIFIED: Use the new rate limiter ---
    const data = await scheduleRequest(() => fetchWithRetry(threadUrl));

    // Basic validation of API response
    if (!data || !Array.isArray(data.posts) || data.posts.length === 0) {
      throw new Error("Invalid or empty API response received");
    }

    // Check 4chan's closed/archived status
    if (data.posts[0].closed === 1 || data.posts[0].archived === 1) {
        log(`Thread "${thread.title}" (${thread.id}) is marked ${data.posts[0].closed ? 'closed' : 'archived'} on 4chan. Closing locally.`, "info");
        thread.closed = true;
        thread.active = false;
        thread.error = false; // Not an error, just closed state
        threadProgressTimers.delete(thread.id); // Remove any stuck timer
        updateWatchedThreads();
        activeDownloads.delete(`${thread.id}-processing`);
        await checkForNewThreads(); // Check if we need to start a new thread
        return; // Stop processing this closed thread
    }


    thread.error = false; // Reset error state on successful fetch and if not closed

    // --- Update total image count reliably ---
    const imagePosts = data.posts.filter(post => post.tim && post.ext); // Filter for posts with images
    const currentTotalImages = imagePosts.length;
    if (thread.totalImages !== currentTotalImages) {
        //log(`Updating total image count for thread "${thread.title}" (${thread.id}) from ${thread.totalImages || 0} to ${currentTotalImages}`, "info");
        thread.totalImages = currentTotalImages;
    }

    // --- Sync downloadedCount with skippedImages & cap ---
    thread.skippedImages = thread.skippedImages || new Set(); // Ensure set exists
    const newCount = Math.min(thread.skippedImages.size, thread.totalImages);
    if(thread.downloadedCount !== newCount) {
        log(`Syncing count for thread "${thread.title}" (${thread.id}): ${thread.downloadedCount} -> ${newCount}`, "info");
        thread.downloadedCount = newCount;
    }


    // Manage stuck timer based on whether processing is needed/possible
    if (thread.downloadedCount < thread.totalImages) {
        threadProgressTimers.delete(thread.id); // Reset stuck timer if there's work to do
    } else if (thread.totalImages > 0) {
        // If count >= total, start or update the stuck timer (potential completion)
        if (!threadProgressTimers.has(thread.id)) {
            log(`Thread "${thread.title}" (${thread.id}) appears complete (${thread.downloadedCount}/${thread.totalImages}). Starting potential close timer.`, "info");
            threadProgressTimers.set(thread.id, Date.now());
        }
    } else {
        // No images in thread, remove timer if it exists
        threadProgressTimers.delete(thread.id);
    }


    updateWatchedThreads(); // Persist count/total changes before processing images
    debouncedUpdateUI();

    // --- Process images if needed ---
    if (thread.downloadedCount < thread.totalImages) {
        //log(`Processing images for thread "${thread.title}" (${thread.id}): ${thread.downloadedCount} of ${thread.totalImages} known.`, "info");
        let downloadedInRun = 0;

        // --- NEW: Dynamic Image Download Delay ---
        // Calculate delay based on the number of currently *active* threads.
        const activeThreadCount = Math.max(1, watchedThreads.filter(t => t.active && !t.closed).length);
        // The more active threads, the longer the pause. A base of 200ms per active thread is reasonable.
        // Cap the max delay to avoid excessively slow downloads on a single thread.
        const dynamicDelay = Math.min(2000, 200 * activeThreadCount); 
        // log(`Dynamic image delay set to ${dynamicDelay}ms for thread ${thread.id} (${activeThreadCount} active threads)`, "debug");
        // --- END: NEW ---

        for (const post of imagePosts) { // Iterate only over posts with actual images
            // Frequent checks for active status
            if (!thread.active || !isRunning) {
                //log(`Stopping image processing loop for thread "${thread.title}" (${thread.id}): Thread/Process inactive.`, "warning");
                break; // Exit the loop
            }

            const imageUrl = `https://i.4cdn.org/${thread.board}/${post.tim}${post.ext}`;
            const filename = `${post.tim}${post.ext}`;

            // Only attempt download if not already skipped in this thread's context
            if (!thread.skippedImages.has(filename)) {
                const result = await downloadImage(imageUrl, thread.id, post.name); // Pass post.name as username
                if (result.success && result.downloaded) {
                    downloadedInRun++;
                    // --- MODIFIED: Use dynamic delay ---
                    // Optional short pause after successful download to ease load, using the dynamic delay
                    await new Promise(resolve => setTimeout(resolve, dynamicDelay));
                } else if (!result.success) {
                    // Logged inside downloadImage. Consider if pausing thread on failure is desired.
                    // Maybe break loop if multiple sequential failures? For now, continue.
                } else if (result.success && !result.downloaded) {
                    // This means it was skipped (e.g., banned user) or already existed.
                    // Logging is handled inside downloadImage for bans.
                }
            }
             // Re-check activity status after each potential download/wait
            if (!thread.active || !isRunning) break;
        }
        log(`processThread: Finished processing run for thread "${thread.title}" (${thread.id}). ${downloadedInRun} new images downloaded. Current state: ${thread.downloadedCount}/${thread.totalImages}`, "info");

        // After loop, re-check if finished and update timer accordingly
        if (thread.active && thread.downloadedCount >= thread.totalImages && thread.totalImages > 0) {
             //log(`processThread: Reached end of images for thread "${thread.title}" (${thread.id}) (${thread.downloadedCount}/${thread.totalImages}). Restarting potential close timer.`, "info");
             threadProgressTimers.set(thread.id, Date.now()); // Set/reset timer
        }
    } else if (thread.totalImages > 0) {
        // No new images needed, log is handled by timer logic above or below
        // log(`No new images to process in thread "${thread.title}" (${thread.id}) (${thread.downloadedCount}/${thread.totalImages}).`, "info");
    } else {
        log(`No images found in thread "${thread.title}" (${thread.id}).`, "info");
    }


  } catch (error) {
    // Handle errors during fetch or processing
    thread.error = true;  // Mark thread as having an error
    thread.active = false; // Pause thread on error
    log(`Error processing thread "${thread.title}" (${thread.id}): ${error.message}. Thread paused.`, "error");
    updateWatchedThreads();
    debouncedUpdateUI();
    // Don't automatically check for new threads here, let manageThreads handle scheduling
  } finally {
      activeDownloads.delete(`${thread.id}-processing`); // Unmark thread as being processed
      // Check if we need to potentially start a new thread if this one errored/closed
      if (!thread.active && isRunning) {
          await checkForNewThreads();
      }
  }
}

async function manageThreads() {
  if (!isInitialized) {
      log("manageThreads: Waiting for initialization.", "info");
      return;
  }

  // Filter for threads that are candidates for processing or checking
  // Active & not error & not closed: primary processing candidates
  // Inactive & error: candidates for potential retry (maybe later feature)
  // Inactive & finished (timer check): candidates for closing
  const processCandidates = watchedThreads.filter(t => t.active && !t.error && !t.closed);
  const finishedCandidates = watchedThreads.filter(t => !t.active && !t.closed && !t.error && t.downloadedCount >= t.totalImages && t.totalImages > 0);
  const stuckCandidates = watchedThreads.filter(t => t.active && !t.error && !t.closed && threadProgressTimers.has(t.id));

  log(`manageThreads: Processing ${processCandidates.length} active, checking ${stuckCandidates.length} potentially stuck.`, "debug");

  // --- Check potentially stuck/finished threads ---
  const now = Date.now();
  for (const thread of [...stuckCandidates, ...finishedCandidates]) {
    const timerStartTime = threadProgressTimers.get(thread.id);
    if (timerStartTime && (now - timerStartTime >= STUCK_TIMER)) {
      log(`Thread "${thread.title}" (${thread.id}) timer expired. Checking for new images...`, "info");
      try {
        // --- MODIFIED: Use the new rate limiter ---
        // Re-fetch thread data to see if new posts/images appeared
        const data = await scheduleRequest(() => fetchWithRetry(thread.url));
        const newImageCount = data.posts.filter(post => post.tim && post.ext).length;

        if (data.posts[0].closed === 1 || data.posts[0].archived === 1) {
             log(`Thread "${thread.title}" (${thread.id}) timer check: Thread now ${data.posts[0].closed ? 'closed' : 'archived'} on 4chan. Closing locally.`, "info");
             thread.closed = true;
             thread.active = false;
             thread.error = false;
             threadProgressTimers.delete(thread.id);
        } else if (newImageCount > thread.totalImages) {
          log(`Thread "${thread.title}" (${thread.id}) timer check: Found new images (${thread.totalImages} -> ${newImageCount}). Re-activating processing.`, "info");
          thread.totalImages = newImageCount; // Update total
          thread.active = true; // Ensure active
          thread.error = false; // Clear error state if any
          threadProgressTimers.delete(thread.id); // Remove timer, processing will restart it if needed
          // Process immediately if a slot is free? Or let the main loop pick it up? Let main loop handle it for consistency.
        } else {
          log(`Thread "${thread.title}" (${thread.id}) timer check: No new images found. Closing thread locally.`, "info");
          thread.closed = true; // Mark as closed locally
          thread.active = false; // Ensure inactive
          threadProgressTimers.delete(thread.id); // Remove timer
        }
      } catch (error) {
        log(`Failed to re-check thread "${thread.title}" (${thread.id}) state during timer check: ${error.message}. Closing thread.`, "error");
        thread.closed = true; // Close on error during check
        thread.active = false;
        thread.error = true; // Mark error state
        threadProgressTimers.delete(thread.id);
      }
      updateWatchedThreads(); // Save changes from timer check
      debouncedUpdateUI();
      await checkForNewThreads(); // Check if a slot opened up
    }
  }

  // --- Process active threads ---
  const activeProcessingCount = Array.from(activeDownloads.keys()).filter(k => k.endsWith('-processing')).length;
  const availableSlots = MAX_CONCURRENT_THREADS - activeProcessingCount;

  if (availableSlots <= 0) {
      // log(`manageThreads: All ${MAX_CONCURRENT_THREADS} processing slots busy.`, "debug");
      return; // All slots busy
  }

  // Find active threads that are NOT currently being processed and have work to do
  const threadsToProcess = processCandidates
      .filter(t => !activeDownloads.has(`${t.id}-processing`)) // Not already processing
      .filter(t => t.downloadedCount < t.totalImages || t.totalImages === 0) // Work needed or initial check
      .slice(0, availableSlots); // Limit to available slots

  if (threadsToProcess.length > 0) {
      //log(`manageThreads: Starting processing for ${threadsToProcess.length} threads.`, "info");
      // Process threads concurrently up to the limit
      await Promise.all(threadsToProcess.map(thread => processThread(thread).catch(err => {
          // Catch errors here to prevent Promise.all from rejecting early
          log(`Unhandled error during manageThreads processThread call for ${thread.id}: ${err.message}`, "error");
          // State update (error, active=false) should happen inside processThread's catch block
      })));
      //log(`manageThreads: Finished processing batch of ${threadsToProcess.length} threads.`, "info");
  } else if(processCandidates.length > 0){
      // log(`manageThreads: No idle threads need processing currently.`, "debug");
  }


  // --- Check if new threads need to be searched for ---
  const currentActiveCount = watchedThreads.filter(t => t.active && !t.closed && !t.error).length;
  if (currentActiveCount < MAX_CONCURRENT_THREADS && (isRunning || watchJobs.length > 0)) {
      await checkForNewThreads();
  }

  // Update isRunning state based on whether any threads are actually active
  isRunning = watchedThreads.some(t => t.active && !t.closed);
  chrome.storage.local.set({ isRunning }); // Persist running state

  if (!isRunning && watchedThreads.length > 0) {
      log("manageThreads: All watched threads are now inactive, paused, closed, or errored. Setting isRunning to false.", "info");
  }

  debouncedUpdateUI(); // Final UI update after management cycle
}


function setupAlarms() {
  log("Setting up 'manageThreads' alarm.", "info");
  chrome.alarms.create("manageThreads", {
       delayInMinutes: 0.1, // Start soon after setup
       periodInMinutes: MANAGE_THREADS_INTERVAL
    });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "manageThreads") {
    //log("Alarm 'manageThreads' triggered.", "debug");
    manageThreads().catch(error => {
        log(`Error during scheduled manageThreads execution: ${error.message}`, "error");
    });
  }
});

async function resumeActiveThreads() {
   // Renamed conceptually - this is now more like a 'sync and process' for active threads
   // Called on startup/resumeAll
  if (!isRunning) {
    log("syncAndProcessActiveThreads: Not running, skipping", "info");
    return;
  }

  const activeThreads = watchedThreads.filter(t => t.active && !t.closed && !t.error);
  if (activeThreads.length === 0) {
    log("syncAndProcessActiveThreads: No active, non-error, non-closed threads to process.", "info");
    return;
  }

  log(`syncAndProcessActiveThreads: Checking state for ${activeThreads.length} active threads...`, "info");
  for (const thread of activeThreads) {
      if (!thread.active || thread.closed || thread.error) continue; // Re-check state

      //log(`Syncing state for thread "${thread.title}" (${thread.id})...`, "debug");
      try {
        // --- MODIFIED: Use the new rate limiter ---
        // Fetch latest data first
        const data = await scheduleRequest(() => fetchWithRetry(thread.url));
        if (!data || !Array.isArray(data.posts)) throw new Error("Invalid API response during resume sync");

        if (data.posts[0].closed === 1 || data.posts[0].archived === 1) {
             log(`Thread "${thread.title}" (${thread.id}) resume check: Thread now ${data.posts[0].closed ? 'closed' : 'archived'}. Closing locally.`, "info");
             thread.closed = true;
             thread.active = false;
             thread.error = false;
             threadProgressTimers.delete(thread.id);
             updateWatchedThreads();
             continue; // Move to next thread
        }


        const newImageCount = data.posts.filter(post => post.tim && post.ext).length;
        thread.totalImages = newImageCount; // Update total count

        // Rebuild skippedImages set from the master downloadedImages map for this thread
        const initialSkippedSize = thread.skippedImages?.size || 0;
        thread.skippedImages = thread.skippedImages || new Set(); // Ensure exists
        const threadSpecificSkipped = new Set(); // Build a fresh set for accuracy

        // First, add items based on global download history
        for (const [path, imgData] of downloadedImages) {
            if (imgData.threadId === thread.id) {
            const filename = path.split('/').pop();
            if (filename) {
                threadSpecificSkipped.add(filename);
            }
            }
        }
        // Second, add items based on banned users (re-evaluate against current post list)
         data.posts.forEach(post => {
             if (post.tim && post.ext) {
                 const rawUsernameLower = (post.name || 'Anonymous').toLowerCase();
                 if (bannedUsernames.has(rawUsernameLower)) {
                     const filename = `${post.tim}${post.ext}`;
                     threadSpecificSkipped.add(filename);
                 }
             }
         });

        // Replace the old set with the rebuilt one for accuracy.
        thread.skippedImages = threadSpecificSkipped;
        const rebuiltSkippedCount = thread.skippedImages.size;


        // Now set downloadedCount based on the rebuilt set and cap it
        const oldCount = thread.downloadedCount;
        thread.downloadedCount = Math.min(rebuiltSkippedCount, thread.totalImages);

        if (oldCount !== thread.downloadedCount || initialSkippedSize !== rebuiltSkippedCount) {
            log(`Synced state for thread "${thread.title}" (${thread.id}): Count ${oldCount} -> ${thread.downloadedCount}, Skipped Set Size ${initialSkippedSize} -> ${rebuiltSkippedCount}, Total Images: ${thread.totalImages}`, "info");
        }

        // Reset error state as we successfully fetched data
        thread.error = false;
        updateWatchedThreads(); // Save synced state before potentially processing

        // Now, let manageThreads pick up the processing if needed.
        // We don't directly call processThread here to respect MAX_CONCURRENT_THREADS.
        // Ensure the timer is correctly set/cleared based on the synced state.
        if (thread.downloadedCount >= thread.totalImages && thread.totalImages > 0) {
            if (!threadProgressTimers.has(thread.id)) {
                threadProgressTimers.set(thread.id, Date.now());
            }
        } else {
            threadProgressTimers.delete(thread.id); // Need processing, remove timer
        }


      } catch (error) {
        log(`Failed to sync state for thread "${thread.title}" (${thread.id}) on resume: ${error.message}`, "error");
        thread.error = true;
        thread.active = false; // Pause on sync error
        updateWatchedThreads();
      }
  }
  log(`syncAndProcessActiveThreads: Finished state sync.`, "info");
  debouncedUpdateUI();
  // Trigger manageThreads to start processing based on updated states and concurrency limits
  manageThreads();
}

chrome.runtime.onStartup.addListener(() => {
  log("Service worker started (onStartup event).", "info");
  // Re-initialize state and alarms
  chrome.storage.local.get(["watchedThreads", "lastSearchParams", "downloadedImages", "isRunning", "bannedUsernames", "maxConcurrentThreads"], async (result) => {
       await initializeState(result); // Use the main init function
       if (isRunning) {
           log("onStartup: isRunning was true, attempting to sync/process active threads.", "info");
           resumeActiveThreads().catch(err => log(`Resume/Sync failed after startup: ${err.message}`, "error"));
       }
       setupAlarms(); // Ensure alarms are set up
       debouncedUpdateUI();
   });
});

// Listener for when the extension is installed or updated
chrome.runtime.onInstalled.addListener(details => {
  log(`Extension ${details.reason}. Initializing...`, "info");
  setupAlarms(); // Set up alarms on first install/update
  // Optionally clear state on update if needed:
  // if (details.reason === "update") {
  //   chrome.storage.local.clear(() => {
  //     log("Cleared storage on update.", "info");
  //   });
  // }
});


async function directoryExists(threadId) {
    // This is an imperfect check based on previously downloaded files.
    // A more robust check would require chrome.downloads.search with specific path, which can be slow.
    const cleanDownloadPath = downloadPath.replace(/^\/+|\/+$/g, '');
    // Regex to match files within the specific thread directory. Needs escaping.
    const escapedPath = cleanDownloadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexPattern = `^${escapedPath}/${threadId}/.*`;

    try {
        const results = await new Promise((resolve) => {
            chrome.downloads.search({ filenameRegex: regexPattern, limit: 1, state: "complete" }, resolve);
        });
        // If we find at least one completed download matching the path pattern, assume directory exists.
        return results && results.length > 0;
    } catch (error) {
        log(`Error searching downloads for thread ${threadId} directory check: ${error.message}`, "error");
        return false; // Assume not exists on error
    }
}


async function findMatchingThreads(board, searchTerm, existingIds) {
  const catalogUrl = `https://a.4cdn.org/${board}/catalog.json`;
  const regex = new RegExp(searchTerm, 'i');
  const sevenDaysAgo = Date.now() / 1000 - (7 * 24 * 60 * 60);
  let foundThreads = [];

  try {
    const catalog = await scheduleRequest(() => fetchWithRetry(catalogUrl));
    if (!Array.isArray(catalog)) throw new Error("Catalog response was not an array");

    for (const page of catalog) {
      if (!page || !Array.isArray(page.threads)) continue;

      for (const threadData of page.threads) {
        if (!threadData || !threadData.no || threadData.time < sevenDaysAgo || existingIds.includes(threadData.no)) {
          continue;
        }

        const matchesSubject = threadData.sub && regex.test(threadData.sub);
        const matchesText = threadData.com && regex.test(threadData.com);

        if (matchesSubject || matchesText) {
          const folderExists = await directoryExists(threadData.no);
          if (folderExists) {
            log(`Skipping potential thread ${threadData.no} - download directory seems to exist.`, "info");
            continue;
          }

          foundThreads.push({
            url: `https://a.4cdn.org/${board}/thread/${threadData.no}.json`,
            title: threadData.sub || `Thread ${threadData.no}`,
            board: board,
            id: threadData.no,
            time: threadData.time || Math.floor(Date.now() / 1000),
            active: false, downloadedCount: 0, totalImages: 0,
            error: false, closed: false, skippedImages: new Set()
          });
        }
      }
    }
  } catch (error) {
    log(`Error searching catalog for /${board}/ with term "${searchTerm}": ${error.message}`, "error");
  }

  return foundThreads.sort((a, b) => b.time - a.time);
}

async function checkForNewThreads() {
  if (watchJobs.length === 0) return;
  
  const activeThreadCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
  let availableSlots = MAX_CONCURRENT_THREADS - activeThreadCount;

  if (availableSlots <= 0) return;

  log(`Checking for new threads from ${watchJobs.length} watch jobs. Available slots for threads: ${availableSlots}`, "debug");

  const shuffledJobs = [...watchJobs].sort(() => 0.5 - Math.random());
  let newThreadsFound = false;

  for (const job of shuffledJobs) {
    if (availableSlots <= 0) break;

    //log(`Executing watch job: /${job.board}/ - "${job.searchTerm}"`, "debug");
    const existingIds = watchedThreads.map(t => t.id);
    const foundThreads = await findMatchingThreads(job.board, job.searchTerm, existingIds);

    if (foundThreads.length > 0) {
      const threadsToAdd = foundThreads.slice(0, availableSlots);
      log(`Found ${threadsToAdd.length} new matching threads from job /${job.board}/. Adding to watch list.`, "success");
      
      threadsToAdd.forEach(t => {
        t.active = true;
        watchedThreads.push(t);
        log(`Added: "${t.title}" (${t.id})`, "info");
      });
      
      availableSlots -= threadsToAdd.length;
      newThreadsFound = true;
    }
  }

  if (newThreadsFound) {
    updateWatchedThreads();
    manageThreads(); // Trigger processing for newly added threads
  } else {
    debouncedUpdateUI(); // Still update UI to show latest timer
  }
}

async function addThreadById(board, threadIdStr) {
    const threadId = parseInt(threadIdStr);
    if (isNaN(threadId)) {
        log(`Invalid Thread ID provided: ${threadIdStr}`, "error");
        return;
    }

    log(`Attempting to add thread ${threadId} from board /${board}/ by ID...`, "info");

    // Check if already watching
    if (watchedThreads.some(t => t.id === threadId)) {
        log(`Thread ${threadId} is already in the watch list.`, "warning");
        // Optionally re-activate if paused? For now, just notify.
        const existing = watchedThreads.find(t => t.id === threadId);
        if(existing && !existing.active){
            log(`Existing thread ${threadId} is inactive. Use Toggle/Resume to reactivate.`, "info");
        }
        return;
    }

    // Check if directory exists (imperfect)
    const folderExists = await directoryExists(threadId);
    if (folderExists) {
        log(`Thread ID ${threadId} not added - download directory seems to exist.`, "warning");
        return;
    }

    const threadUrl = `https://a.4cdn.org/${board}/thread/${threadId}.json`;
    try {
        // --- MODIFIED: Use the new rate limiter ---
        const data = await scheduleRequest(() => fetchWithRetry(threadUrl));
        if (!data || !Array.isArray(data.posts) || data.posts.length === 0) {
            throw new Error("Invalid or empty API response for thread ID");
        }
        const opPost = data.posts[0];

        const thread = {
            url: threadUrl,
            title: opPost.sub || `Thread ${threadId}`,
            board: board,
            id: threadId,
            time: opPost.time || Math.floor(Date.now() / 1000),
            active: false, // Add as inactive initially
            downloadedCount: 0,
            totalImages: 0, // Will be determined later
            error: false,
            closed: opPost.closed === 1 || opPost.archived === 1, // Set closed status from API
            skippedImages: new Set()
        };

        if (thread.closed) {
            log(`Thread "${thread.title}" (${threadId}) is already ${opPost.closed ? 'closed' : 'archived'} on 4chan. Adding as closed.`, "info");
        }

        // Add the thread to the list
        watchedThreads.push(thread);
        log(`Added thread "${thread.title}" (${threadId}) to watch list ${thread.closed ? '(as closed)' : ''}.`, "success");

        // Activate if not closed and slots available
        const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
        if (!thread.closed && activeCount < MAX_CONCURRENT_THREADS) {
            thread.active = true;
            log(`Activating new thread ${threadId}.`, "info");
            updateWatchedThreads(); // Save added thread state
            manageThreads(); // Trigger processing
        } else if (!thread.closed) {
            log(`Thread ${threadId} added but not activated (max concurrent threads reached).`, "warning");
            updateWatchedThreads(); // Save added thread state (inactive)
        } else {
            updateWatchedThreads(); // Save added thread state (closed)
        }

        debouncedUpdateUI();

    } catch (error) {
        log(`Error adding thread ${threadId} by ID from /${board}/: ${error.message}`, "error");
        // Optionally remove the failed thread entry if added partially? No, keep it for potential retry.
    }
}


async function addWatchJob(board, searchTerm) {
  if (!board || !searchTerm) {
    log("addWatchJob failed: Board and search term are required.", "error");
    return false;
  }
  try {
    new RegExp(searchTerm, 'i');
  } catch (e) {
    log(`addWatchJob failed: Invalid regex pattern "${searchTerm}".`, "error");
    return false;
  }

  const jobExists = watchJobs.some(j => j.board.toLowerCase() === board.toLowerCase() && j.searchTerm === searchTerm);
  if (jobExists) {
    log(`Watch job for /${board}/ with term "${searchTerm}" already exists.`, "warning");
    return false;
  }

  const newJob = {
    id: `job_${Date.now()}`,
    board: board,
    searchTerm: searchTerm
  };

  watchJobs.push(newJob);
  chrome.storage.local.set({ watchJobs: watchJobs });
  log(`Added new watch job: /${board}/ - "${searchTerm}"`, "success");

  await checkForNewThreads();
  return true;
}

function removeWatchJob(jobId) {
  const initialLength = watchJobs.length;
  watchJobs = watchJobs.filter(j => j.id !== jobId);
  if (watchJobs.length < initialLength) {
    chrome.storage.local.set({ watchJobs: watchJobs });
    log(`Removed watch job with ID ${jobId}.`, "info");
    debouncedUpdateUI();
  }
}

function stopScraping() {
  log("Stop command received: Pausing all active threads...", "info");
  let changed = false;
  watchedThreads.forEach(thread => {
    if (thread.active) {
      thread.active = false;
      changed = true;
      // Stop potential stuck timer when pausing
      threadProgressTimers.delete(thread.id);
      log(`Paused thread "${thread.title}" (${thread.id})`, "info");
    }
  });

  // Cancel any downloads associated with the threads being paused
  // (More robust: cancel *all* active downloads managed by this extension?)
  activeDownloads.forEach((downloadId, key) => {
      if (key.endsWith('-processing')) return; // Skip processing flags

      const threadIdMatch = key.match(/^(\d+)-/);
      if (threadIdMatch) {
          const threadId = parseInt(threadIdMatch[1]);
          const thread = watchedThreads.find(t => t.id === threadId);
          // Cancel if thread exists and was just deactivated (or if we want to cancel all)
          if (thread && !thread.active) {
             if (Number.isInteger(downloadId)) {
                 log(`Cancelling download ${downloadId} for paused thread ${threadId}`, "info");
                 chrome.downloads.cancel(downloadId, () => {
                     if (!chrome.runtime.lastError) chrome.downloads.erase({ id: downloadId }); // Clean up cancelled download
                     else log(`Failed to cancel download ${downloadId}: ${chrome.runtime.lastError.message}`, "warning");
                 });
             }
             activeDownloads.delete(key); // Remove from tracking
          }
      }
  });
   // Clear all processing flags
   Array.from(activeDownloads.keys()).filter(k => k.endsWith('-processing')).forEach(k => activeDownloads.delete(k));


  isRunning = false; // Set global state to not running
  chrome.storage.local.set({ isRunning });

  if (changed) {
    updateWatchedThreads(); // Save changes if any threads were paused
  }
  log("All active threads paused.", "warning");
  debouncedUpdateUI();
}


async function resumeAllThreads() {
  const now = Date.now();
  // Prevent rapid resume calls
  if (isResuming || (now - lastResumeTime < MIN_RESUME_INTERVAL * 2)) {
    log("Resume all throttled.", "debug");
    return false;
  }
  isResuming = true;
  lastResumeTime = now;
  //log("Resume All command received.", "info");

  try {
    const threadsToResume = watchedThreads.filter(t => !t.active && !t.error && !t.closed);
    const currentActiveCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
    let availableSlots = MAX_CONCURRENT_THREADS - currentActiveCount;
    let resumedCount = 0;

    if (threadsToResume.length === 0) {
      log("Resume All: No paused, non-error, non-closed threads to resume.", "info");
      isRunning = currentActiveCount > 0; // Update running state if needed
      chrome.storage.local.set({ isRunning });
      return false;
    }

    log(`Attempting to resume up to ${availableSlots} threads initially...`, "info");
    isRunning = true; // Set global running state
    chrome.storage.local.set({ isRunning });

    for (const thread of threadsToResume) {
        if (availableSlots <= 0) {
            log(`Resume All: Reached max concurrent threads (${MAX_CONCURRENT_THREADS}). Remaining threads kept paused.`, "info");
            break; // Stop resuming if limit reached
        }
        log(`Resuming thread "${thread.title}" (${thread.id})`, "info");
        thread.active = true;
        thread.error = false; // Clear error state on resume attempt
        resumedCount++;
        availableSlots--;
    }

    if (resumedCount > 0) {
      updateWatchedThreads(); // Save activated threads state
      log(`Resumed ${resumedCount} threads. Triggering sync and processing...`, "info");
      // Call the sync/process function to check state and let manageThreads handle scheduling
      await resumeActiveThreads();
    } else {
        log("Resume All: No threads were actually resumed (limit reached or none eligible).", "info");
    }

    debouncedUpdateUI();
    return resumedCount > 0; // Return true if any thread was actually activated

  } finally {
    isResuming = false; // Release the flag
  }
}


function toggleThread(threadId) {
  const thread = watchedThreads.find(t => t.id === threadId);
  if (!thread) {
    log(`ToggleThread: Thread ${threadId} not found.`, "error");
    return;
  }

  // Do not allow toggling a closed thread. This is now handled by the "Re-open" button.
  if (thread.closed) {
      //log(`Toggle attempted on closed thread "${thread.title}" (${threadId}). Use 'Re-open' instead.`, "warning");
      return;
  }

  if (thread.active) {
    // --- Deactivate ---
    log(`Pausing thread "${thread.title}" (${threadId})`, "info");
    thread.active = false;
    threadProgressTimers.delete(thread.id); // Stop stuck timer

    // Cancel associated active downloads
    activeDownloads.forEach((downloadId, key) => {
        if (key.startsWith(`${threadId}-`)) {
            if(key.endsWith('-processing')) {
                activeDownloads.delete(key); // Remove processing flag
            } else if (Number.isInteger(downloadId)) {
                log(`Cancelling download ${downloadId} for paused thread ${threadId}`, "info");
                chrome.downloads.cancel(downloadId, () => {
                     if (!chrome.runtime.lastError) chrome.downloads.erase({ id: downloadId });
                     else log(`Failed to cancel download ${downloadId}: ${chrome.runtime.lastError.message}`, "warning");
                });
                activeDownloads.delete(key); // Remove from tracking
            }
        }
    });
     isRunning = watchedThreads.some(t => t.active && !t.closed); // Re-evaluate isRunning
     chrome.storage.local.set({ isRunning });


  } else {
    // --- Activate ---
     if (thread.error) {
        log(`Retrying errored thread "${thread.title}" (${threadId})`, "info");
        thread.error = false; // Clear error on manual retry/resume
    }

    const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
    if (activeCount < MAX_CONCURRENT_THREADS) {
      log(`Resuming thread "${thread.title}" (${threadId})`, "info");
      thread.active = true;
      isRunning = true; // Ensure global state is running
      chrome.storage.local.set({ isRunning });

      // Trigger sync/processing via manageThreads after state update
       manageThreads(); // Let manageThreads schedule the processing
    } else {
        log(`Cannot activate thread "${thread.title}" (${threadId}): Maximum concurrent threads (${MAX_CONCURRENT_THREADS}) reached.`, "warning");
        // The state change (closed=false, error=false) will be saved by the updateWatchedThreads call below.
    }
  }

  updateWatchedThreads(); // Save the toggled state
  debouncedUpdateUI();
}

function closeThread(threadId) {
  const thread = watchedThreads.find(t => t.id === threadId);
  if (thread) {
    if (thread.closed) { // "Re-open" button was clicked
        log(`Re-opening thread "${thread.title}" (${threadId}).`, "info");
        thread.closed = false;
        thread.error = false; // Also clear error state, like resume does

        const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
        if (activeCount < MAX_CONCURRENT_THREADS) {
            log(`Activating re-opened thread "${thread.title}" (${threadId})`, "info");
            thread.active = true;
            isRunning = true;
            chrome.storage.local.set({ isRunning });
            manageThreads(); // Trigger processing
        } else {
            log(`Thread ${threadId} re-opened but remains paused (max concurrent threads reached).`, "warning");
        }
        updateWatchedThreads();
        debouncedUpdateUI();
    } else { // "Close" button was clicked
        log(`Closing thread "${thread.title}" (${threadId})`, "info");
        const wasActive = thread.active;
        thread.closed = true;
        thread.active = false;
        thread.error = false; // Clear error state when closing
        threadProgressTimers.delete(thread.id); // Remove any stuck timer

        // Cancel associated active downloads
        activeDownloads.forEach((downloadId, key) => {
           if (key.startsWith(`${threadId}-`)) {
               if(key.endsWith('-processing')) {
                   activeDownloads.delete(key); // Remove processing flag
               } else if (Number.isInteger(downloadId)) {
                   log(`Cancelling download ${downloadId} for closed thread ${threadId}`, "info");
                   chrome.downloads.cancel(downloadId, () => {
                        if (!chrome.runtime.lastError) chrome.downloads.erase({ id: downloadId });
                        else log(`Failed to cancel download ${downloadId}: ${chrome.runtime.lastError.message}`, "warning");
                   });
                   activeDownloads.delete(key); // Remove from tracking
               }
           }
        });
        isRunning = watchedThreads.some(t => t.active && !t.closed); // Re-evaluate isRunning
        chrome.storage.local.set({ isRunning });

        updateWatchedThreads(); // Save state
        debouncedUpdateUI();

        // If a slot was freed up, check for new threads
        if (wasActive && isRunning) {
           checkForNewThreads();
        }
    }
  } else {
    log(`CloseThread: Thread ${threadId} not found.`, "error");
  }
}

function removeThread(threadId) {
    log(`Removing thread ${threadId}...`, "info");
    const threadIndex = watchedThreads.findIndex(t => t.id === threadId);

    if (threadIndex !== -1) {
        const thread = watchedThreads[threadIndex];
        log(`Found thread "${thread.title}" (${threadId}) for removal.`, "info");

        // Cancel associated active downloads before removing
        activeDownloads.forEach((downloadId, key) => {
            if (key.startsWith(`${threadId}-`)) {
                if(key.endsWith('-processing')) {
                   activeDownloads.delete(key); // Remove processing flag
                } else if (Number.isInteger(downloadId)) {
                    log(`Cancelling download ${downloadId} for removed thread ${threadId}`, "info");
                    chrome.downloads.cancel(downloadId, () => {
                        if (!chrome.runtime.lastError) chrome.downloads.erase({ id: downloadId });
                        else log(`Failed to cancel download ${downloadId}: ${chrome.runtime.lastError.message}`, "warning");
                    });
                    activeDownloads.delete(key); // Remove from tracking
                }
            }
        });

        // Remove thread from the array
        const wasActive = thread.active;
        watchedThreads.splice(threadIndex, 1);
        threadProgressTimers.delete(threadId); // Clean up timer map

        log(`Thread "${thread.title}" (${threadId}) removed. ${watchedThreads.length} threads remaining.`, "success");
        isRunning = watchedThreads.some(t => t.active && !t.closed); // Re-evaluate isRunning
        chrome.storage.local.set({ isRunning });

        updateWatchedThreads(); // Save the modified list
        debouncedUpdateUI();

        // Check for new threads if an active slot was potentially freed
        if (wasActive && isRunning) {
            checkForNewThreads();
        }
    } else {
        log(`RemoveThread: Thread ${threadId} not found.`, "error");
    }
}


function forgetThreadDownloads(threadId) {
  const thread = watchedThreads.find(t => t.id === threadId);
  if (!thread) {
    log(`ForgetThreadDownloads: Thread ${threadId} not found.`, "error");
    return false;
  }

  log(`Forgetting download history for thread "${thread.title}" (${threadId})...`, "warning");
  const initialSkippedSize = thread.skippedImages?.size || 0;
  thread.skippedImages = new Set(); // Clear the specific thread's skipped set
  thread.downloadedCount = 0;       // Reset its count to 0
  thread.error = false; // Reset error state
  // Should we reset 'closed'? No, keep closed status.
  // Should we reset 'active'? Yes, if we want it to re-scan immediately. Let's keep it as it was.

  let removedCount = 0;
  const remainingDownloads = new Map();
  for (const [path, data] of downloadedImages) {
    if (data.threadId === threadId) {
      removedCount++;
    } else {
      remainingDownloads.set(path, data); // Keep history for other threads
    }
  }

  if (removedCount > 0) {
    downloadedImages = remainingDownloads; // Update the master map
    log(`Removed ${removedCount} entries from master download history for thread ${threadId}.`, "info");
    // Update storage
    chrome.storage.local.set({
      downloadedImages: Array.from(downloadedImages.entries())
    });
  } else {
      log(`No master download history entries found for thread ${threadId}.`, "info");
  }

  // --- Re-apply bans to skipped set ---
  // After clearing, we need to re-add skips based on banned users for this thread.
  // This requires fetching the thread data again. Consider if this is too heavy.
  // Alternative: Keep track of banned-user skips separately?
  // Let's skip the re-fetch for now; the next processThread cycle will re-add them.
  log(`Cleared skipped set for thread ${threadId}. Count reset to 0. Banned user skips will re-apply on next process cycle.`, "info");


  updateWatchedThreads(); // Save the reset thread state (count, skipped set)

  // log(`Finished forgetting downloads for thread "${thread.title}" (${threadId}). Cleared ${initialSkippedSize} skipped entries. Count reset to 0.`, "success"); // Adjusted log message
  debouncedUpdateUI();

  // If the thread is currently active, trigger processing to re-scan it
  if(thread.active){
      manageThreads();
  }

  return true;
}

function removeAllThreads() {
    log("Remove All command received. Removing all threads...", "warning");

    // Cancel all active downloads first
    activeDownloads.forEach((downloadId, key) => {
        if (key.endsWith('-processing')) {
             activeDownloads.delete(key);
        } else if (Number.isInteger(downloadId)) {
            log(`Cancelling download ${downloadId} as part of Remove All.`, "info");
            chrome.downloads.cancel(downloadId, () => {
                if (!chrome.runtime.lastError) chrome.downloads.erase({ id: downloadId });
            });
            activeDownloads.delete(key);
        }
    });

    // Clear all thread-related state
    watchedThreads = [];
    threadProgressTimers.clear();
    isRunning = false;

    log(`All threads removed.`, "success");
    chrome.storage.local.set({ isRunning: false });
    
    // updateWatchedThreads will save the empty array to storage
    updateWatchedThreads();
    debouncedUpdateUI();
}

// --- Function to forget ALL download history ---
function forgetAllDownloads() {
  log(`Forgetting ALL downloaded image history... THIS IS IRREVERSIBLE.`, "warning");
  downloadedImages.clear(); // Clear the master map
  activeDownloads.clear(); // Clear any pending downloads tracked
  downloadLocks.clear(); // Clear any locks
  threadProgressTimers.clear(); // Clear all stuck timers

  watchedThreads.forEach(thread => {
    thread.skippedImages = new Set(); // Clear skipped set for each thread
    thread.downloadedCount = 0;       // Reset count to 0
    thread.error = false; // Clear errors
    // Keep active/closed status as is
    // Re-applying bans is complex here without fetching all threads.
    // Let the next process cycle handle re-adding ban skips.
  });
  log(`Cleared skipped sets for all threads. Banned user skips will re-apply on next process cycle.`, "info");

  // Clear from storage
  chrome.storage.local.remove("downloadedImages", () => {
      if (chrome.runtime.lastError) {
          log(`Error clearing downloadedImages from storage: ${chrome.runtime.lastError.message}`, "error");
      } else {
          log(`Cleared downloadedImages key from local storage.`, "info");
      }
  });

  updateWatchedThreads(); // Save the reset thread states
  log(`All download history cleared. Reset counts/errors for ${watchedThreads.length} threads.`, "success");
  debouncedUpdateUI();

  // Trigger processing for any threads that are still active
  if (isRunning) {
      manageThreads();
  }
}

// --- Manage Banned Usernames ---
function addBannedUsername(username) {
    const usernameLower = username.trim().toLowerCase();
    if (!usernameLower) {
        log("Cannot add empty username to ban list.", "warning");
        return false;
    }
    if (bannedUsernames.has(usernameLower)) {
        log(`Username "${username}" is already banned.`, "info");
        return false;
    }
    bannedUsernames.add(usernameLower);
    chrome.storage.local.set({ bannedUsernames: Array.from(bannedUsernames) });
    //log(`Banned username: "${username}" (stored as "${usernameLower}"). Total bans: ${bannedUsernames.size}`, "success");
    debouncedUpdateUI(); // Update UI with the new list
    return true;
}

function removeBannedUsername(username) {
    const usernameLower = username.trim().toLowerCase();
    if (!bannedUsernames.has(usernameLower)) {
        log(`Username "${username}" not found in ban list.`, "warning");
        return false;
    }
    bannedUsernames.delete(usernameLower);
    chrome.storage.local.set({ bannedUsernames: Array.from(bannedUsernames) });
    //log(`Removed username "${username}" from ban list. Total bans: ${bannedUsernames.size}`, "success");
    debouncedUpdateUI(); // Update UI
    return true;
}
// --- End Manage Banned Usernames ---

// New function to clear all banned usernames
function clearBannedUsernames() {
    log("Clearing all banned usernames...", "warning");
    bannedUsernames.clear();
    chrome.storage.local.set({ bannedUsernames: [] }, () => {
        if (chrome.runtime.lastError) {
            log(`Error clearing bannedUsernames from storage: ${chrome.runtime.lastError.message}`, "error");
            return false;
        }
        log(`Banned usernames list cleared.`, "success");
        debouncedUpdateUI();
        return true;
    });
    return true; // Optimistic return, storage callback is async
}

function cleanupOldDownloads() {
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let removedCount = 0;
    const currentSize = downloadedImages.size;

    for (const [path, data] of downloadedImages) {
        if (data.timestamp < oneWeekAgo) {
        downloadedImages.delete(path);
        removedCount++;
        }
    }
    if (removedCount > 0) {
        log(`Cleaned up ${removedCount} download history entries older than 7 days. Size: ${currentSize} -> ${downloadedImages.size}`, "info");
        chrome.storage.local.set({ downloadedImages: Array.from(downloadedImages.entries()) });
        debouncedUpdateUI(); // Update UI if history size changed
    } else {
        // log("No old download entries found during cleanup.", "debug");
    }
}
// Schedule daily cleanup
setInterval(cleanupOldDownloads, 24 * 60 * 60 * 1000);

// --- MODIFIED Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const messageType = message.type;
  // Use a more concise log for received messages unless debugging verbosely
  // log(`Message received: ${messageType}`, "debug");

  // --- Handle getStatus Asynchronously ---
  if (messageType === "getStatus") {
    // Use a Promise to handle the async chrome.alarms.get call
    new Promise(resolve => chrome.alarms.get("manageThreads", resolve))
      .then(alarm => {
          // This runs after chrome.alarms.get completes (successfully or not)
          const nextTime = alarm?.scheduledTime || null;
          // log(`[getStatus] Sending next alarm time: ${nextTime}`, "debug"); // Optional debug

          // Send the response containing the retrieved alarm time
          sendResponse({
              isRunning: watchedThreads.some(t => t.active && !t.closed),
              watchedThreads: watchedThreads.map(thread => ({
                ...thread,
                // Ensure skippedImages is always present and serialized correctly
                skippedImages: Array.from(thread.skippedImages || new Set()),
                downloadedCount: thread.downloadedCount || 0,
                totalImages: thread.totalImages || 0
              })),
              trackedDownloads: downloadedImages.size,
              watchJobs: watchJobs, // --- NEW: Send watch jobs to UI
              bannedUsernames: Array.from(bannedUsernames), // Include banned list
              nextManageThreads: nextTime, // Send the correctly retrieved time
              maxConcurrentThreads: MAX_CONCURRENT_THREADS // --- NEW: Send current value
          });
      })
      .catch(error => {
           // Handle potential errors during chrome.alarms.get itself
           log(`Error getting alarm status for getStatus: ${error.message}`, "error");
           // Send a response indicating failure or default values
           sendResponse({
              isRunning: watchedThreads.some(t => t.active && !t.closed),
              watchedThreads: watchedThreads.map(thread => ({
                ...thread,
                skippedImages: Array.from(thread.skippedImages || new Set()),
                downloadedCount: thread.downloadedCount || 0,
                totalImages: thread.totalImages || 0
              })),
              trackedDownloads: downloadedImages.size,
              watchJobs: watchJobs, // --- NEW: Send watch jobs to UI
              bannedUsernames: Array.from(bannedUsernames), // Still send current list
              nextManageThreads: null, // Indicate error by sending null
              maxConcurrentThreads: MAX_CONCURRENT_THREADS, // --- NEW: Send current value
              error: "Failed to retrieve alarm status"
           });
      });

    // Crucial: Indicate that sendResponse will be called asynchronously
    return true;
  }
  // --- Other message handlers ---
  else if (messageType === "start") {
    // This message is now split. Adding a thread by ID remains, but search is a "watch job".
    if (message.threadId) {
      addThreadById(message.board, message.threadId).then(() => {
        sendResponse({ success: true });
      });
      return true; // Async
    } else if (message.searchTerm) {
      // This is now "addWatchJob"
      addWatchJob(message.board, message.searchTerm).then(success => {
        sendResponse({ success });
      });
      return true; // Async
    } else {
        log("Start request missing threadId or searchTerm.", "error");
        sendResponse({ success: false, error: "Missing threadId or searchTerm" });
    }
  } else if (messageType === "stop") {
    stopScraping();
    sendResponse({ success: true });
  } else if (messageType === "resumeAll") {
    // resumeAllThreads itself is async and handles the response
    resumeAllThreads().then(resumed => sendResponse({ success: resumed }));
    // Indicate async response
    return true;
  } else if (messageType === "toggleThread") {
    toggleThread(message.threadId);
    // Respond immediately, UI updates happen based on subsequent getStatus calls
    sendResponse({ success: true });
  } else if (messageType === "closeThread") {
    closeThread(message.threadId);
    sendResponse({ success: true });
  } else if (messageType === "removeThread") {
    removeThread(message.threadId);
    sendResponse({ success: true });
  } else if (messageType === "setWindowId") {
    windowId = message.windowId;
    log(`Control window ID set to ${windowId}`, "info");
    sendResponse({ success: true });
     // Trigger an update for the newly identified window
     debouncedUpdateUI();
  } else if (messageType === "forgetAllDownloads") {
    forgetAllDownloads();
    sendResponse({ success: true });
  } else if (messageType === "removeAllThreads") {
    removeAllThreads();
    sendResponse({ success: true });
  } else if (messageType === "forgetThreadDownloads") {
    const success = forgetThreadDownloads(message.threadId);
    sendResponse({ success });
  } else if (messageType === "getSavedPath") { // --- MODIFIED
    sendResponse({ downloadPath: downloadPath });
  } else if (messageType === "updateDownloadPath") { // --- NEW
    if (message.path) {
        downloadPath = message.path;
        chrome.storage.local.set({ downloadPath: downloadPath });
        log(`Download path updated to: ${downloadPath}`, "info");
        sendResponse({ success: true });
    } else {
        sendResponse({ success: false, error: "No path provided" });
    }
  } else if (messageType === "getBannedUsernames") { // New handler
      sendResponse({ success: true, bannedUsernames: Array.from(bannedUsernames) });
  } else if (messageType === "addBannedUsername") { // New handler
      const success = addBannedUsername(message.username);
      sendResponse({ success });
  } else if (messageType === "removeBannedUsername") { // New handler
      const success = removeBannedUsername(message.username);
      sendResponse({ success });
  } else if (messageType === "clearBannedUsernames") { // New handler
      const success = clearBannedUsernames();
      sendResponse({ success });
  } else if (messageType === "addWatchJob") { // --- NEW
      addWatchJob(message.board, message.searchTerm).then(success => sendResponse({ success }));
      return true; // Is async
  } else if (messageType === "removeWatchJob") { // --- NEW
      removeWatchJob(message.id);
      sendResponse({ success: true });
  } else if (messageType === "checkAllWatchJobs") {
      log("Manual 'Check All' triggered.", "info");
      checkForNewThreads().then(() => {
          sendResponse({ success: true });
      });
      return true; // Is async
  } else if (messageType === "syncThreadCounts") {
     // This operation itself might take time but sendResponse is called synchronously at the end
     //log("Manual sync requested. Rebuilding state for all threads...", "info");
     let changesMade = false;
     for (const thread of watchedThreads) {
        // Sync regardless of active state for manual request
        const initialSkippedSize = thread.skippedImages?.size || 0;
        const initialCount = thread.downloadedCount;

        // Rebuild skipped from master list AND bans
        const threadSpecificSkipped = new Set();
        for (const [path, imgData] of downloadedImages) {
            if (imgData.threadId === thread.id) {
                const filename = path.split('/').pop();
                if (filename) threadSpecificSkipped.add(filename);
            }
        }
        // Re-check bans (Requires fetch or cached post list - skipping for now in manual sync)
        // For full accuracy, fetch would be needed here. Assuming existing set + download map is sufficient for manual sync.
        // log(`Manual Sync: Banned user check skipped during manual sync for thread ${thread.id}. Relying on existing skipped set and download history.`, "debug");

         // Merge potentially existing skipped items (safer)
         const originalSkipped = thread.skippedImages || new Set();
         originalSkipped.forEach(item => threadSpecificSkipped.add(item)); // Ensure items only in the thread's list are kept
         thread.skippedImages = threadSpecificSkipped;

        const rebuiltSkippedCount = thread.skippedImages.size;
        // Ensure totalImages is non-negative before capping
        const safeTotalImages = Math.max(0, thread.totalImages || 0);
        const newCount = Math.min(rebuiltSkippedCount, safeTotalImages);

        if (initialCount !== newCount || initialSkippedSize !== rebuiltSkippedCount) {
            log(`Manual Sync: Thread "${thread.title}" (${thread.id}) count ${initialCount}->${newCount}, skipped ${initialSkippedSize}->${rebuiltSkippedCount} (Total: ${thread.totalImages})`, "info");
            thread.downloadedCount = newCount;
            changesMade = true;
        }
     }
     if (changesMade) {
        updateWatchedThreads(); // Save potentially changed counts/sets
        debouncedUpdateUI();
     } else {
        log("Manual Sync: No count discrepancies found.", "info");
     }
     // Send response after sync logic finishes
     sendResponse({ success: true });
  } 
  // --- NEW: Handle updates for Max Concurrent Threads ---
  else if (messageType === "updateMaxThreads") {
      const newMax = parseInt(message.value, 10);
      // Add validation for the new value
      if (!isNaN(newMax) && newMax > 0 && newMax <= 20) { // Capped at 20 for sanity
          MAX_CONCURRENT_THREADS = newMax;
          chrome.storage.local.set({ maxConcurrentThreads: newMax });
          log(`Max concurrent threads updated to ${newMax}`, "info");
          sendResponse({ success: true });
      } else {
          log(`Invalid value for max concurrent threads: ${message.value}`, "warning");
          sendResponse({ success: false, error: "Invalid value. Must be a number between 1 and 20." });
      }
  }
  else {
      // Handle unknown message types
      log(`Received unknown message type: ${messageType}`, "warning");
      sendResponse({success: false, error: "Unknown message type"});
  }

  // Determine if we need to return true based on which message types *might* be async
  // 'getStatus', 'start' (if delayed), and 'resumeAll' are the async ones.
  return ["getStatus", "start", "resumeAll", "addWatchJob", "checkAllWatchJobs", "removeAllThreads"].includes(messageType);
});


// --- MODIFIED Initialization Logic ---

async function initializeState(result) {
    log("Initializing state from storage...", "info");
    isInitialized = false; // Mark as not ready yet

    // --- NEW: Load maxConcurrentThreads from storage ---
    MAX_CONCURRENT_THREADS = result.maxConcurrentThreads || 5; // Default to 5 if not found
    log(`Max concurrent threads set to ${MAX_CONCURRENT_THREADS}`, "info");

    // Load and sanitize watchedThreads
    watchedThreads = result.watchedThreads || [];
    let totalCorrectedCount = 0;
    watchedThreads.forEach(thread => {
        // Basic structure checks and defaults
        thread.id = Number(thread.id); // Ensure ID is number
        thread.closed = thread.closed || false;
        thread.active = thread.active || false;
        thread.error = thread.error || false;
        thread.totalImages = thread.totalImages || 0;
        thread.downloadedCount = thread.downloadedCount || 0;
        thread.board = thread.board || '';
        thread.url = thread.url || '';
        thread.title = thread.title || `Thread ${thread.id}`;
        thread.time = thread.time || 0;

        // Sanitize skippedImages (convert from stored array back to Set)
        if (Array.isArray(thread.skippedImages)) {
            thread.skippedImages = new Set(thread.skippedImages);
        } else if (!(thread.skippedImages instanceof Set)) {
            log(`Invalid skippedImages format for thread ${thread.id}, resetting.`, "warning");
            thread.skippedImages = new Set(); // Reset if not a Set or Array
        }

        // --- Crucial: Sync count with skipped set size and cap ---
        const initialCount = thread.downloadedCount;
        // Ensure totalImages is non-negative before capping
        const safeTotalImages = Math.max(0, thread.totalImages);
        const syncedCount = Math.min(thread.skippedImages.size, safeTotalImages);

        if (initialCount !== syncedCount) {
           log(`Init Sync: Corrected count for thread ${thread.id} from ${initialCount} to ${syncedCount} (Skipped: ${thread.skippedImages.size}, Total: ${safeTotalImages})`, "info");
           thread.downloadedCount = syncedCount;
           totalCorrectedCount++;
        }
    });
    if (totalCorrectedCount > 0) {
        log(`Initialization sync corrected counts for ${totalCorrectedCount} threads.`, "info");
    }

    // --- NEW: Load watch jobs and download path ---
    watchJobs = result.watchJobs || [];
    downloadPath = (result.downloadPath || '4chan_downloads').replace(/^\/+|\/+$/g, '');
    if (result.lastSearchParams) { // --- MIGRATION: For users updating the extension
        log("Migrating legacy 'lastSearchParams' to new 'watchJobs' system.", "info");
        chrome.storage.local.remove('lastSearchParams');
    }

    // Load downloaded images history
    if (result.downloadedImages && Array.isArray(result.downloadedImages)) {
        try {
            downloadedImages = new Map(result.downloadedImages);
             // Ensure data structure is correct
             for(let [key, value] of downloadedImages.entries()) {
                 if(typeof value !== 'object' || typeof value.timestamp !== 'number' || typeof value.threadId !== 'number') {
                     log(`Removing invalid entry from downloadedImages: Key=${key}, Value=${JSON.stringify(value)}`, "warning");
                     downloadedImages.delete(key);
                 }
             }
        } catch (e) {
            log(`Error converting stored downloadedImages to Map, resetting. Error: ${e.message}`, "error");
            downloadedImages = new Map();
            chrome.storage.local.remove("downloadedImages"); // Clear invalid storage data
        }
    } else {
        downloadedImages = new Map(); // Initialize if missing or not an array
    }

    // Load banned usernames
    if (result.bannedUsernames && Array.isArray(result.bannedUsernames)) {
        try {
            // Ensure all are lowercase strings
            bannedUsernames = new Set(result.bannedUsernames.map(u => String(u).toLowerCase()));
            log(`Loaded ${bannedUsernames.size} banned usernames.`, "info");
        } catch(e) {
             log(`Error converting stored bannedUsernames to Set, resetting. Error: ${e.message}`, "error");
             bannedUsernames = new Set();
             chrome.storage.local.remove("bannedUsernames");
        }
    } else {
        bannedUsernames = new Set(); // Initialize if missing or invalid
        log("Initialized empty banned usernames list.", "info");
        // Save the empty list initially if it didn't exist
        chrome.storage.local.set({ bannedUsernames: [] });
    }

    // Load running state
    isRunning = result.isRunning || false;
    // Correct isRunning state based on loaded threads
    const actualRunning = watchedThreads.some(t => t.active && !t.closed);
	if(isRunning !== actualRunning){
        log(`Correcting isRunning state: ${isRunning} -> ${actualRunning}`, "info");
        isRunning = actualRunning;
        chrome.storage.local.set({ isRunning: actualRunning });
    }

    updateWatchedThreads(); // Save potentially sanitized thread state back to storage
    log(`Initialization complete. ${watchedThreads.length} threads loaded. ${downloadedImages.size} downloads tracked. ${bannedUsernames.size} users banned. isRunning: ${isRunning}`, "info");
    isInitialized = true; // Mark as initialized

    // Perform initial cleanup of old downloads
    cleanupOldDownloads(); 
} // <--- The brace should be here, after all the function's logic.

// --- MODIFIED: Load state when the service worker starts, including new setting ---
chrome.storage.local.get(["watchedThreads", "watchJobs", "downloadPath", "lastSearchParams", "downloadedImages", "isRunning", "bannedUsernames", "maxConcurrentThreads"], async (result) => {
    await initializeState(result);
    // After state is loaded and sanitized:
    if (isRunning) {
        log("Service worker restart: isRunning was true, attempting to sync/process active threads.", "info");
        resumeActiveThreads().catch(err => log(`Resume/Sync failed after restart: ${err.message}`, "error"));
    }
    setupAlarms(); // Ensure alarms are (re)established
    debouncedUpdateUI(); // Perform initial UI update
});

// --- Window Close Listener ---
chrome.windows.onRemoved.addListener((closedWindowId) => {
    // Check if the window that closed is the control window we know about
    if (closedWindowId === windowId) {
        log(`Control window ${closedWindowId} closed. Pausing all threads.`, "info");
        // Call the existing function that pauses everything
        stopScraping();
        // Reset the windowId since it's no longer valid
        windowId = null;
        log(`Reset windowId to null.`, "debug"); // Optional debug log
    }
});

// Keep-alive mechanism (less critical with Manifest V3 event-driven model, but can help)
// Consider removing if causing issues. Alarms are the primary method.
// let keepAliveInterval = setInterval(() => {
//     // console.log("Service worker keep-alive ping.", "debug");
//     // Optional: Could perform a lightweight check here, like chrome.alarms.get
//     chrome.alarms.get("manageThreads", ()=>{});
// }, 20 * 1000); // Ping every 20 seconds

log("Background script finished loading.", "info");