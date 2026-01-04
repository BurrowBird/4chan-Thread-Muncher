console.log("Service worker script loaded.");

let threadProgressTimers = new Map();
let isResuming = false;
let keepAliveAlarmName = 'keepAlivePing';
let watchedThreads = [];
let downloadedImages = new Map();
let watchJobs = [];
let bannedUsernames = new Set();
let activeDownloads = new Map();
let downloadLocks = new Map();
let windowId = null;
let lastResumeTime = 0;
let lastLogMessage = null;
let isInitialized = false;
let downloadPath = '4chan_downloads';
let MAX_CONCURRENT_THREADS = 5;
let populateHistory = false;
let hideDownloadIcon = false;
let prependParentName = false;
let isQueueProcessing = false;
let hideClosedThreads = false;

const STUCK_TIMER = 5 * 60 * 1000;
const MANAGE_THREADS_INTERVAL = 1;
const RATE_LIMIT_MS = 1500;
const MAX_DOWNLOADED_IMAGES = 18000;
const MIN_RESUME_INTERVAL = 1000;
const MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 60000;
const requestQueue = [];
const API_REQUEST_INTERVAL = 1100;


// Saves the current state of threadProgressTimers to local storage.
function updateTimersInStorage() {
    const storableTimers = Array.from(threadProgressTimers.entries());
    chrome.storage.local.set({ threadProgressTimers: storableTimers }, () => {
        if (chrome.runtime.lastError) {
            log(`Error saving thread progress timers to storage: ${chrome.runtime.lastError.message}`, "error");
        }
    });
}


// Helper function to determine if any thread is active. This is our new single source of truth.
function isAnyThreadActive() {
    return watchedThreads.some(t => t.active && !t.closed);
}


async function fetchWithRetry(url) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorText = `API fetch failed with status: ${response.status} ${response.statusText}`;
        log(`${errorText} for ${url}`, "warning");
        
        if (response.status === 407) {
           throw new Error("Proxy Authentication Required");
        }
        
        // If we get rate limited (429) or Forbidden (403), wait 5 seconds before retrying
        if (response.status === 429 || response.status === 403) {
             await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      
      const data = await response.json();
      return data; // Success!

    } catch (error) {
      if (i === MAX_RETRIES - 1) {
        log(`Max retries reached for ${url}, giving up fetch`, "error");
        throw error;
      }
      
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS * (i + 1)));
    }
  }
  throw new Error(`API fetch failed permanently for ${url} after ${MAX_RETRIES} retries.`);
}


async function processQueue() {
    if (requestQueue.length === 0) {
        isQueueProcessing = false;
        return;
    }
    isQueueProcessing = true;
    const requestToProcess = requestQueue.shift();
    try {
        await requestToProcess();
    } catch (error) {
        log(`Rate-limited request failed: ${error.message}`, "error");
    }
    setTimeout(processQueue, API_REQUEST_INTERVAL);
}

function scheduleRequest(asyncFunc) {
    return new Promise((resolve, reject) => {
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
    let consoleMessage = message;
    if (typeof message === 'object' && message.isStructured) {
        consoleMessage = message.parts.map(p => p.text).join('');
    }

    if (((consoleMessage.startsWith("checkForNewThreads: Searching") || consoleMessage.startsWith("searchAndWatchThreads: No new")) && lastLogMessage === consoleMessage)) {
        return;
    }
    console.log(`[${timestamp}] [${type.toUpperCase()}] ${consoleMessage}`);
    lastLogMessage = consoleMessage;
    if (windowId) {
        chrome.windows.get(windowId, {}, (win) => {
            if (chrome.runtime.lastError) {
                return;
            }
            if (win) {
                chrome.runtime.sendMessage({
                    type: "log",
                    message: message, // Pass the original object or string
                    logType: type
                }, () => {
                    if (chrome.runtime.lastError) {}
                });
            }
        });
    }
}


function getFullPath(threadId, username, filename) {
    const sanitizedUsername = username ? username.replace(/[^a-zA-Z0-9_.-]/g, "_") : "Anonymous";
    let sanitizedFilename = filename ? filename.replace(/[^a-zA-Z0-9_.-]/g, "_") : "unknown_file";
    const cleanDownloadPath = downloadPath.replace(/^\/+|\/+$/g, '');

    if (prependParentName) {
        sanitizedFilename = `${sanitizedUsername}｜${sanitizedFilename}`;
    }

    return `${cleanDownloadPath}/${threadId}/${sanitizedUsername}/${sanitizedFilename}`;
}

async function downloadImage(url, threadId, username) {
    const filename = url.split('/').pop();
    const thread = watchedThreads.find(t => t.id === threadId);
    if (!thread) {
        log(`Thread ${threadId} not found for ${url}`, "error");
        return {
            success: false,
            downloaded: false
        };
    }
    thread.skippedImages = thread.skippedImages || new Set();
    thread.downloadedCount = thread.downloadedCount || 0;
    thread.totalImages = thread.totalImages || 0;
    const rawUsernameLower = (username || 'Anonymous').toLowerCase();
    if (bannedUsernames.has(rawUsernameLower)) {
        if (!thread.skippedImages.has(filename)) {
            thread.skippedImages.add(filename);
            thread.downloadedCount = Math.min(thread.skippedImages.size, thread.totalImages);
            log(`Skipped image ${filename} for thread ${threadId}: User "${username}" is banned. Count: ${thread.downloadedCount}/${thread.totalImages}`, "info");
            updateWatchedThreads();
            debouncedUpdateUI();
        }
        return {
            success: true,
            downloaded: false
        };
    }
    const fullPath = getFullPath(threadId, username, filename);
    const downloadKey = `${threadId}-${filename}`;
    if (downloadLocks.has(downloadKey)) {
        await downloadLocks.get(downloadKey);
    }
    let resolveLock;
    const lockPromise = new Promise(resolve => {
        resolveLock = resolve;
    });
    downloadLocks.set(downloadKey, lockPromise);
    try {
        const isAlreadyDownloaded = downloadedImages.has(fullPath);
        const isAlreadySkipped = thread.skippedImages.has(filename);
        if (isAlreadyDownloaded || isAlreadySkipped) {
            if (!isAlreadySkipped) {
                thread.skippedImages.add(filename);
                thread.downloadedCount = Math.min(thread.skippedImages.size, thread.totalImages);
                updateWatchedThreads();
            }
            return {
                success: true,
                downloaded: false
            };
        }
        if (!thread.active) {
            return {
                success: false,
                downloaded: false
            };
        }
        for (let i = 0; i < MAX_RETRIES; i++) {
            // CHANGED: Check against the specific thread, not a global flag.
            const currentThreadState = watchedThreads.find(t => t.id === threadId);
            if (!currentThreadState || !currentThreadState.active) {
                throw new Error("Process or thread stopped before download attempt");
            }
            let downloadId = null;
            try {
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
                const downloadResult = await new Promise((resolve, reject) => {
                    let listener = null;
                    const timeoutId = setTimeout(() => {
                        log(`Download timed out for ${filename} (ID: ${downloadId}) after ${DOWNLOAD_TIMEOUT_MS}ms`, "warning");
                        if (listener) chrome.downloads.onChanged.removeListener(listener);
                        activeDownloads.delete(downloadKey);
                        if (downloadId) {
                            chrome.downloads.cancel(downloadId, () => {
                                chrome.downloads.erase({
                                    id: downloadId
                                });
                            });
                        }
                        reject(new Error("Download timed out"));
                    }, DOWNLOAD_TIMEOUT_MS);
                    listener = (delta) => {
                        if (delta.id === downloadId) {
                            const isComplete = delta.state && delta.state.current === "complete";
                            const isInterrupted = delta.state && delta.state.current === "interrupted";
                            if (isComplete) {
                                clearTimeout(timeoutId);
                                chrome.downloads.onChanged.removeListener(listener);
                                activeDownloads.delete(downloadKey);
                                if (!populateHistory) {
                                    chrome.downloads.erase({
                                        id: downloadId
                                    });
                                }
                                resolve(true);
                            } else if (isInterrupted) {
                                clearTimeout(timeoutId);
                                chrome.downloads.onChanged.removeListener(listener);
                                activeDownloads.delete(downloadKey);
                                log(`Download interrupted for ${filename} (ID: ${downloadId}). Reason: ${delta.error?.current || 'Unknown'}`, "warning");
                                chrome.downloads.erase({
                                    id: downloadId
                                });
                                reject(new Error(`Download interrupted: ${delta.error?.current || 'Unknown reason'}`));
                            }
                        }
                    };
                    chrome.downloads.onChanged.addListener(listener);
                });
                if (downloadResult === true) {
                    downloadedImages.set(fullPath, {
                        timestamp: Date.now(),
                        threadId
                    });
                    if (!thread.skippedImages.has(filename)) {
                        thread.skippedImages.add(filename);
                    }
                    thread.downloadedCount = Math.min(thread.skippedImages.size, thread.totalImages);
                    if (downloadedImages.size > MAX_DOWNLOADED_IMAGES) {
                        const oldest = Array.from(downloadedImages.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
                        downloadedImages.delete(oldest[0]);
                    }
                    chrome.storage.local.set({
                        downloadedImages: Array.from(downloadedImages.entries())
                    });
                    updateWatchedThreads();
					log({
						isStructured: true,
						parts: [
							{ text: 'Successfully downloaded ' },
							{ text: filename, style: 'log-filename' },
							{ text: ' to ', style: 'normal' },
							{ text: fullPath, style: 'log-path' },
							{ text: ' for thread ', style: 'normal' },
							{ text: threadId, style: 'log-thread-id' }
						]
					}, "success");
                    debouncedUpdateUI();
                    return {
                        success: true,
                        downloaded: true
                    };
                }
                throw new Error("Download completion promise resolved unexpectedly.");
            } catch (error) {
                activeDownloads.delete(downloadKey);
                if (downloadId) {
                    chrome.downloads.erase({
                        id: downloadId
                    });
                }
                log(`Download attempt ${i + 1}/${MAX_RETRIES} failed for ${url}: ${error.message}`, "warning");
                if (i === MAX_RETRIES - 1) {
                    log(`Max retries reached for ${url}, marking as failed for this run`, "error");
                } else {
                    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS * (i + 1)));
                    const currentThreadStateRetry = watchedThreads.find(t => t.id === threadId);
                    if (!currentThreadStateRetry || !currentThreadStateRetry.active) {
                        throw new Error("Thread or process inactive during retry wait");
                    }
                }
            }
        }
        throw new Error(`Download failed permanently for ${filename} after ${MAX_RETRIES} retries`);
    } catch (error) {
        log(`Failed to download ${filename} for thread ${threadId}: ${error.message}`, "error");
        activeDownloads.delete(downloadKey);
        return {
            success: false,
            downloaded: false
        };
    } finally {
        if (resolveLock) resolveLock();
        downloadLocks.delete(downloadKey);
    }
}

const handleDownloadCreated = debounce((downloadItem) => {
    try {
        if (!downloadItem || typeof downloadItem.filename !== 'string' || !downloadItem.id) {
            log(`Invalid downloadItem in onCreated listener: ${JSON.stringify(downloadItem)}`, "warning");
            return;
        }

        const pathParts = downloadItem.filename.split('/');
        if (pathParts.length < 4) return;
        
        const filename = pathParts[pathParts.length - 1];
        const username = pathParts[pathParts.length - 2];
        const threadIdStr = pathParts[pathParts.length - 3];
        const downloadBasePath = pathParts.slice(0, -3).join('/');
        
        if (!filename || !username || !threadIdStr || isNaN(parseInt(threadIdStr))) return;
        
        const threadId = parseInt(threadIdStr);
        const duplicateMatch = filename.match(/^(.*) \((\d+)\)(\.\w+)$/);
        
        if (duplicateMatch) {
            const baseFilename = duplicateMatch[1] + duplicateMatch[3];
            const baseFullPath = `${downloadBasePath}/${threadId}/${username}/${baseFilename}`;
            const isOriginalDownloaded = downloadedImages.has(baseFullPath);
            
            if (isOriginalDownloaded) {
                log(`Detected duplicate download: ${filename}. Cancelling ID ${downloadItem.id}.`, "info");
                chrome.downloads.cancel(downloadItem.id, () => {
                    if (chrome.runtime.lastError) {
                        log(`Failed to cancel duplicate download ${downloadItem.id} (${filename}): ${chrome.runtime.lastError.message}`, "warning");
                    } else {
                        chrome.downloads.erase({ id: downloadItem.id });
                        const thread = watchedThreads.find(t => t.id === threadId);
                        if (thread) {
                            thread.skippedImages = thread.skippedImages || new Set();
                            if (!thread.skippedImages.has(baseFilename)) {
                                thread.skippedImages.add(baseFilename);
                                thread.downloadedCount = Math.min(thread.skippedImages.size, thread.totalImages);
                                log(`Marked base file ${baseFilename} as skipped for thread ${threadId} due to cancelled duplicate. New count: ${thread.downloadedCount}`, "info");
                                updateWatchedThreads();
                                debouncedUpdateUI();
                            }
                        }
                    }
                });
            }
        }
    } catch (error) {
        log(`Error in downloads.onCreated listener: ${error.message}`, "error");
    }
}, 250);


chrome.downloads.onCreated.addListener(handleDownloadCreated);
let updateQueue = [];
const debouncedUpdateUI = debounce(() => {
    if (updateQueue.length > 0 || true) {
        updateUI();
        updateQueue = [];
    }
}, 600);

function updateUI() {
    if (windowId) {
        chrome.windows.get(windowId, {}, (win) => {
            if (chrome.runtime.lastError || !win) {
                return;
            }
            chrome.alarms.get("manageThreads", (alarm) => {
                const nextTime = alarm?.scheduledTime || null;
                chrome.runtime.sendMessage({
                    type: "updateStatus",
                    isRunning: isAnyThreadActive(), // CHANGED: Use the helper function
                    watchedThreads: watchedThreads.map(thread => ({
                        ...thread,
                        skippedImages: Array.from(thread.skippedImages || new Set()),
                        downloadedCount: thread.downloadedCount || 0,
                        totalImages: thread.totalImages || 0,
                        timerStartTime: threadProgressTimers.get(thread.id) || null
                    })),
                    trackedDownloads: downloadedImages.size,
                    watchJobs: watchJobs,
                    bannedUsernames: Array.from(bannedUsernames),
                    nextManageThreads: nextTime,
                    maxConcurrentThreads: MAX_CONCURRENT_THREADS,
                    populateHistory: populateHistory
                }, () => {
                    if (chrome.runtime.lastError && !chrome.runtime.lastError.message.includes("Receiving end does not exist")) {
                        log(`UI update message failed: ${chrome.runtime.lastError.message}`, "warning");
                    }
                });
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
        return true;
    }
    return false;
}

function updateWatchedThreads() {
    const changed = deduplicateWatchedThreads();
    let corrected = false;
    watchedThreads.forEach(t => {
        const newCount = Math.min(t.skippedImages?.size || 0, t.totalImages || 0);
        if (t.downloadedCount !== newCount) {
            t.downloadedCount = newCount;
            corrected = true;
        }
    });
    if (changed || corrected) {
        //log("Persisting watched thread changes to storage.", "debug");
    }
    const storableThreads = watchedThreads.map(thread => ({
        ...thread,
        skippedImages: Array.from(thread.skippedImages || new Set())
    }));
    chrome.storage.local.set({
        watchedThreads: storableThreads
    }, () => {
        if (chrome.runtime.lastError) {
            log(`Error saving watchedThreads to storage: ${chrome.runtime.lastError.message}`, "error");
        }
        debouncedUpdateUI();
    });
}
async function processThread(thread) {
    if (!thread || !thread.id) {
        log("processThread called with invalid thread object", "error");
        return;
    }
    const threadUrl = thread.url;
    activeDownloads.set(`${thread.id}-processing`, true);
    try {
        const data = await scheduleRequest(() => fetchWithRetry(threadUrl));
        if (!data || !Array.isArray(data.posts) || data.posts.length === 0) {
            throw new Error("Invalid or empty API response received");
        }
		if (data.posts[0].closed === 1 || data.posts[0].archived === 1) {
					log(`Thread "${thread.title}" (${thread.id}) is marked ${data.posts[0].closed ? 'closed' : 'archived'} on 4chan. Closing locally.`, "info");
					thread.closed = true;
					thread.active = false;
					thread.error = false;
					threadProgressTimers.delete(thread.id);
					updateTimersInStorage();
					updateWatchedThreads();
					return;
				}
        thread.error = false;
        const imagePosts = data.posts.filter(post => post.tim && post.ext);
        const currentTotalImages = imagePosts.length;
        if (thread.totalImages !== currentTotalImages) {
            thread.totalImages = currentTotalImages;
        }
        thread.skippedImages = thread.skippedImages || new Set();
        const newCount = Math.min(thread.skippedImages.size, thread.totalImages);
        if (thread.downloadedCount !== newCount) {
            log(`Syncing count for thread "${thread.title}" (${thread.id}): ${thread.downloadedCount} -> ${newCount}`, "info");
            thread.downloadedCount = newCount;
        }
		
        updateWatchedThreads();
        debouncedUpdateUI();
        if (thread.downloadedCount < thread.totalImages) {
            let downloadedInRun = 0;
            const activeThreadCount = Math.max(1, watchedThreads.filter(t => t.active && !t.closed).length);
            const dynamicDelay = Math.min(2000, 200 * activeThreadCount);
            for (const post of imagePosts) {
                if (!thread.active) {
                    break;
                }
                const imageUrl = `https://i.4cdn.org/${thread.board}/${post.tim}${post.ext}`;
                const filename = `${post.tim}${post.ext}`;
                if (!thread.skippedImages.has(filename)) {
					const result = await downloadImage(imageUrl, thread.id, post.name);
					if (result.success && result.downloaded) {
						downloadedInRun++;
						await new Promise(resolve => setTimeout(resolve, dynamicDelay));
					} else if (!result.success) {
						log(`Marking permanently failed image ${filename} as skipped for thread ${thread.id}.`, "warning");
						thread.skippedImages.add(filename);
						thread.downloadedCount = Math.min(thread.skippedImages.size, thread.totalImages);
						updateWatchedThreads(); // Persist the change
						debouncedUpdateUI();
					}
				}
                if (!thread.active) break;
            }
            log(`Finished processing run for thread "${thread.title}" (${thread.id}). ${downloadedInRun} new images downloaded. Current state: ${thread.downloadedCount}/${thread.totalImages}`, "info");
        } else if (thread.totalImages > 0) {} else {
            log(`No images found in thread "${thread.title}" (${thread.id}).`, "info");
        }
	} catch (error) {
			thread.error = true;
			thread.active = false;
			log(`Error processing thread "${thread.title}" (${thread.id}): ${error.message}. Thread paused.`, "error");
			updateWatchedThreads();
			debouncedUpdateUI();
		} finally {
			activeDownloads.delete(`${thread.id}-processing`);
		}
	}


async function manageThreads() {
    if (!windowId) {
        // No UI window is open, so we should not be processing anything.
        return;
    }

    if (!isInitialized) {
        log("manageThreads: Waiting for initialization.", "info");
        return;
    }

    let newTimers = new Map();
    const currentTime = Date.now(); 

    const completeThreads = watchedThreads.filter(thread => 
        !thread.closed && !thread.error && thread.downloadedCount >= thread.totalImages && thread.totalImages > 0
    );

    const seenCompleteIds = new Set();
    for (const thread of completeThreads) {
        if (seenCompleteIds.has(thread.id)) {
            continue; 
        }
        seenCompleteIds.add(thread.id);

        const existingStartTime = threadProgressTimers.get(thread.id);
        if (existingStartTime) {
            newTimers.set(thread.id, existingStartTime);
        } else {
            log(`Thread "${thread.title}" (${thread.id}) appears complete (${thread.downloadedCount}/${thread.totalImages}). Starting potential close timer.`, "info");
            newTimers.set(thread.id, currentTime);
        }
    }

    threadProgressTimers = newTimers;
    updateTimersInStorage();

    const processCandidates = watchedThreads.filter(t => t.active && !t.error && !t.closed);
    const threadsWithTimers = watchedThreads.filter(t => threadProgressTimers.has(t.id));

    log(`Processing ${processCandidates.filter(p => (p.downloadedCount < p.totalImages || p.totalImages === 0)).length} active, monitoring ${threadsWithTimers.length} potentially finished threads.`, "debug");
    const now = Date.now();

    // Check all threads that have a timer to see if they should be closed.
    for (const thread of threadsWithTimers) {
        const timerStartTime = threadProgressTimers.get(thread.id);
        if (timerStartTime && (now - timerStartTime >= STUCK_TIMER)) {
            log(`Thread "${thread.title}" (${thread.id}) timer expired. Checking for new images...`, "info");
            try {
                const data = await scheduleRequest(() => fetchWithRetry(thread.url));
                const newImageCount = data.posts.filter(post => post.tim && post.ext).length;

                // Condition 1: Thread is officially closed/archived by 4chan.
                if (data.posts[0].closed === 1 || data.posts[0].archived === 1) {
                    log(`Thread "${thread.title}" (${thread.id}) timer check: Thread now ${data.posts[0].closed ? 'closed' : 'archived'} on 4chan. Closing locally.`, "info");
                    thread.closed = true;
                    thread.active = false;
                    thread.error = false;
                    threadProgressTimers.delete(thread.id);
					updateTimersInStorage();
                }
                // Condition 2: New images have appeared.
                else if (newImageCount > thread.totalImages) {
                    log(`Thread "${thread.title}" (${thread.id}) timer check: Found new images (${thread.totalImages} -> ${newImageCount}). Processing will resume.`, "info");
                    thread.totalImages = newImageCount;
                    // The timer will be automatically removed on the next manageThreads cycle because the thread is no longer complete.
                }
                // Condition 3: Timer expired, no new images found. Close it.
                else {
                    log({
                        isStructured: true,
                        parts: [
                            { text: 'Thread "' },
                            { text: thread.title, style: 'log-filename' },
                            { text: '" (', style: 'normal' },
                            { text: thread.id, style: 'log-path' },
                            { text: ') timer expired and no new images found. Closing thread locally.', style: 'normal' },
                        ]
                    }, "info");
                    thread.closed = true;
                    thread.active = false;
                    threadProgressTimers.delete(thread.id);
					updateTimersInStorage();
                }
            } catch (error) {
                log(`Failed to re-check thread "${thread.title}" (${thread.id}) state during timer check: ${error.message}. Closing thread.`, "error");
                thread.closed = true;
                thread.active = false;
                thread.error = true; // Keep error state to indicate it closed due to a failure
                threadProgressTimers.delete(thread.id);
				updateTimersInStorage();
            }
            updateWatchedThreads();
            debouncedUpdateUI();
        }
    }

    const activeProcessingCount = Array.from(activeDownloads.keys()).filter(k => k.endsWith('-processing')).length;
    const availableSlots = MAX_CONCURRENT_THREADS - activeProcessingCount;
    if (availableSlots <= 0) {
        return;
    }

    const threadsToProcess = processCandidates
        .filter(t => !activeDownloads.has(`${t.id}-processing`))
        .filter(t => t.downloadedCount < t.totalImages || t.totalImages === 0)
        .slice(0, availableSlots);

    if (threadsToProcess.length > 0) {
        await Promise.all(threadsToProcess.map(thread => processThread(thread).catch(err => {
            log(`Unhandled error during manageThreads processThread call for ${thread.id}: ${err.message}`, "error");
        })));
    }

    const currentActiveCount = watchedThreads.filter(t => t.active && !t.closed && !t.error).length;
    if (watchJobs.length > 0 && currentActiveCount < MAX_CONCURRENT_THREADS) {
        await checkForNewThreads();
    }
    
    // REMOVED: All `isRunning` logic and storage calls.

    if (!isAnyThreadActive() && watchedThreads.length > 0) {
        log("manageThreads: All watched threads are now inactive, paused, closed, or errored.", "info");
    }
    debouncedUpdateUI();
}

function setupAlarms() {
    //log("Setting up 'manageThreads' alarm.", "info");
    chrome.alarms.create("manageThreads", {
        delayInMinutes: 0.1,
        periodInMinutes: MANAGE_THREADS_INTERVAL
    });
}
chrome.alarms.create(keepAliveAlarmName, {
        delayInMinutes: 1, 
        periodInMinutes: 1 
    });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "manageThreads") {
        manageThreads().catch(error => {
            log(`Error during scheduled manageThreads execution: ${error.message}`, "error");
        });
    }

    if (alarm.name === keepAliveAlarmName) {
        //log("Sending network heartbeat to keep proxy session alive...", "debug");
        fetch(chrome.runtime.getURL('dud.txt'), { cache: 'no-store' })
            .then(response => {
                if (!response.ok) throw new Error('Heartbeat failed');
                //log("Network heartbeat successful.", "debug");
            })
            .catch(err => log(`Network heartbeat failed: ${err.message}`, "warning"));

        if (windowId) {
            chrome.runtime.sendMessage({ type: "keepAlive" }, () => {
                if (chrome.runtime.lastError) {}
            });
        }
    }
});


async function resumeActiveThreads() {
    if (!isAnyThreadActive()) {
        log("syncAndProcessActiveThreads: No active threads, skipping", "info");
        return;
    }
    const activeThreads = watchedThreads.filter(t => t.active && !t.closed && !t.error);
    if (activeThreads.length === 0) {
        log("syncAndProcessActiveThreads: No active, non-error, non-closed threads to process.", "info");
        return;
    }
    //log(`syncAndProcessActiveThreads: Checking state for ${activeThreads.length} active threads...`, "info");
    for (const thread of activeThreads) {
        if (!thread.active || thread.closed || thread.error) continue;
        try {
            const data = await scheduleRequest(() => fetchWithRetry(thread.url));
            if (!data || !Array.isArray(data.posts)) throw new Error("Invalid API response during resume sync");
            if (data.posts[0].closed === 1 || data.posts[0].archived === 1) {
                log(`Thread "${thread.title}" (${thread.id}) resume check: Thread now ${data.posts[0].closed ? 'closed' : 'archived'}. Closing locally.`, "info");
                thread.closed = true;
                thread.active = false;
                thread.error = false;
                threadProgressTimers.delete(thread.id);
				updateTimersInStorage();
                updateWatchedThreads();
                continue;
            }
            const newImageCount = data.posts.filter(post => post.tim && post.ext).length;
            thread.totalImages = newImageCount;
            const initialSkippedSize = thread.skippedImages?.size || 0;
            thread.skippedImages = thread.skippedImages || new Set();
            const threadSpecificSkipped = new Set();
            for (const [path, imgData] of downloadedImages) {
                if (imgData.threadId === thread.id) {
                    const filename = path.split('/').pop();
                    if (filename) {
                        threadSpecificSkipped.add(filename);
                    }
                }
            }
            data.posts.forEach(post => {
                if (post.tim && post.ext) {
                    const rawUsernameLower = (post.name || 'Anonymous').toLowerCase();
                    if (bannedUsernames.has(rawUsernameLower)) {
                        const filename = `${post.tim}${post.ext}`;
                        threadSpecificSkipped.add(filename);
                    }
                }
            });
            thread.skippedImages = threadSpecificSkipped;
            const rebuiltSkippedCount = thread.skippedImages.size;
            const oldCount = thread.downloadedCount;
            thread.downloadedCount = Math.min(rebuiltSkippedCount, thread.totalImages);
            if (oldCount !== thread.downloadedCount || initialSkippedSize !== rebuiltSkippedCount) {
                //log(`Synced state for thread "${thread.title}" (${thread.id}): Count ${oldCount} -> ${thread.downloadedCount}, Skipped Set Size ${initialSkippedSize} -> ${rebuiltSkippedCount}, Total Images: ${thread.totalImages}`, "info");
            }
            thread.error = false;
            updateWatchedThreads();
			
        } catch (error) {
            log(`Failed to sync state for thread "${thread.title}" (${thread.id}) on resume: ${error.message}`, "error");
            thread.error = true;
            thread.active = false;
            updateWatchedThreads();
        }
    }
    //log(`syncAndProcessActiveThreads: Finished state sync.`, "info");
    debouncedUpdateUI();
    manageThreads();
}

chrome.runtime.onInstalled.addListener(details => {
    log(`Extension ${details.reason}. Initializing...`, "info");
    setupAlarms();
});
async function directoryExists(threadId) {
    if (populateHistory) {
        const cleanDownloadPath = downloadPath.replace(/^\/+|\/+$/g, '');
        const escapedPath = cleanDownloadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regexPattern = `^${escapedPath}/${threadId}/.*`;
        try {
            const results = await new Promise((resolve) => {
                chrome.downloads.search({
                    filenameRegex: regexPattern,
                    limit: 1,
                    state: "complete"
                }, resolve);
            });
            return results && results.length > 0;
        } catch (error) {
            log(`Error searching Chrome downloads for thread ${threadId}: ${error.message}`, "error");
            return false;
        }
    } else {
        const cleanDownloadPath = downloadPath.replace(/^\/+|\/+$/g, '');
        const searchPrefix = `${cleanDownloadPath}/${threadId}/`;
        for (const path of downloadedImages.keys()) {
            if (path.startsWith(searchPrefix)) {
                return true;
            }
        }
        return false;
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
                        active: false,
                        downloadedCount: 0,
                        totalImages: 0,
                        error: false,
                        closed: false,
                        skippedImages: new Set()
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
    (`Checking for new threads from ${watchJobs.length} watch jobs. Available slots for threads: ${availableSlots}`, "info");
    const shuffledJobs = [...watchJobs].sort(() => 0.5 - Math.random());
    let newThreadsFound = false;
    for (const job of shuffledJobs) {
        if (availableSlots <= 0) break;
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
        manageThreads();
    } else {
        debouncedUpdateUI();
    }
}
async function addThreadById(board, threadIdStr) {
    const threadId = parseInt(threadIdStr);
    if (isNaN(threadId)) {
        log(`Invalid Thread ID provided: ${threadIdStr}`, "error");
        return;
    }
    log(`Attempting to add thread ${threadId} from board /${board}/ by ID...`, "info");
    if (watchedThreads.some(t => t.id === threadId)) {
        log(`Thread ${threadId} is already in the watch list.`, "warning");
        const existing = watchedThreads.find(t => t.id === threadId);
        if (existing && !existing.active) {
            log(`Existing thread ${threadId} is inactive. Use Toggle/Resume to reactivate.`, "info");
        }
        return;
    }
    const folderExists = await directoryExists(threadId);
    if (folderExists) {
        log(`Thread ID ${threadId} not added - download directory seems to exist.`, "warning");
        return;
    }
    const threadUrl = `https://a.4cdn.org/${board}/thread/${threadId}.json`;
    try {
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
            active: false,
            downloadedCount: 0,
            totalImages: 0,
            error: false,
            closed: opPost.closed === 1 || opPost.archived === 1,
            skippedImages: new Set()
        };
        if (thread.closed) {
            log(`Thread "${thread.title}" (${threadId}) is already ${opPost.closed ? 'closed' : 'archived'} on 4chan. Adding as closed.`, "info");
        }
        watchedThreads.push(thread);
        log(`Added thread "${thread.title}" (${threadId}) to watch list ${thread.closed ? '(as closed)' : ''}.`, "success");
        const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
        if (!thread.closed && activeCount < MAX_CONCURRENT_THREADS) {
            thread.active = true;
            log(`Activating new thread ${threadId}.`, "info");
            updateWatchedThreads();
            manageThreads();
        } else if (!thread.closed) {
            log(`Thread ${threadId} added but not activated (max concurrent threads reached).`, "warning");
            updateWatchedThreads();
        } else {
            updateWatchedThreads();
        }
        debouncedUpdateUI();
    } catch (error) {
        log(`Error adding thread ${threadId} by ID from /${board}/: ${error.message}`, "error");
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
    chrome.storage.local.set({
        watchJobs: watchJobs
    });
    log(`Added new watch job: /${board}/ - "${searchTerm}"`, "success");
    await manageThreads();
    return true;
}

function removeWatchJob(jobId) {
    const initialLength = watchJobs.length;
    watchJobs = watchJobs.filter(j => j.id !== jobId);
    if (watchJobs.length < initialLength) {
        chrome.storage.local.set({
            watchJobs: watchJobs
        });
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
            threadProgressTimers.delete(thread.id);
            log(`Paused thread "${thread.title}" (${thread.id})`, "info");
        }
    });
    activeDownloads.forEach((downloadId, key) => {
        if (key.endsWith('-processing')) return;
        const threadIdMatch = key.match(/^(\d+)-/);
        if (threadIdMatch) {
            const threadId = parseInt(threadIdMatch[1]);
            const thread = watchedThreads.find(t => t.id === threadId);
            if (thread && !thread.active) {
                if (Number.isInteger(downloadId)) {
                    log(`Cancelling download ${downloadId} for paused thread ${threadId}`, "info");
                    chrome.downloads.cancel(downloadId, () => {
                        if (!chrome.runtime.lastError) chrome.downloads.erase({
                            id: downloadId
                        });
                        else log(`Failed to cancel download ${downloadId}: ${chrome.runtime.lastError.message}`, "warning");
                    });
                }
                activeDownloads.delete(key);
            }
        }
    });
    Array.from(activeDownloads.keys()).filter(k => k.endsWith('-processing')).forEach(k => activeDownloads.delete(k));
    
    if (changed) {
		updateTimersInStorage();
        updateWatchedThreads();
    }
    log("All active threads paused.", "warning");
    debouncedUpdateUI();
}
async function resumeAllThreads() {
    const now = Date.now();
    if (isResuming || (now - lastResumeTime < MIN_RESUME_INTERVAL * 2)) {
        log("Resume all throttled.", "debug");
        return false;
    }
    isResuming = true;
    lastResumeTime = now;
    try {
        const threadsToResume = watchedThreads.filter(t => !t.active && !t.error && !t.closed);
        const currentActiveCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
        let availableSlots = MAX_CONCURRENT_THREADS - currentActiveCount;
        let resumedCount = 0;
        if (threadsToResume.length === 0) {
            log("Resume All: No paused, non-error, non-closed threads to resume.", "info");
            return false;
        }
        log(`Attempting to resume up to ${availableSlots} threads.`, "info");
        
        // REMOVED: isRunning = true and storage call.

        for (const thread of threadsToResume) {
            if (availableSlots <= 0) {
                log(`Resume All: Reached max concurrent threads (${MAX_CONCURRENT_THREADS}). Remaining threads kept paused.`, "info");
                break;
            }
            //log(`Resuming thread "${thread.title}" (${thread.id})`, "info");
            thread.active = true;
            thread.error = false;
            resumedCount++;
            availableSlots--;
        }
        if (resumedCount > 0) {
            updateWatchedThreads();
            log(`Resumed ${resumedCount} threads. Triggering sync and processing...`, "info");
            await resumeActiveThreads();
        } else {
            log("Resume All: No threads were actually resumed (limit reached or none eligible).", "info");
        }
        debouncedUpdateUI();
        return resumedCount > 0;
    } finally {
        isResuming = false;
    }
}

function toggleThread(threadId) {
    const thread = watchedThreads.find(t => t.id === threadId);
    if (!thread) {
        log(`ToggleThread: Thread ${threadId} not found.`, "error");
        return;
    }
    if (thread.closed) {
        return;
    }
    if (thread.active) {
        log(`Pausing thread "${thread.title}" (${thread.id})`, "info");
        thread.active = false;
        threadProgressTimers.delete(thread.id);
		updateTimersInStorage();
        activeDownloads.forEach((downloadId, key) => {
            if (key.startsWith(`${threadId}-`)) {
                if (key.endsWith('-processing')) {
                    activeDownloads.delete(key);
                } else if (Number.isInteger(downloadId)) {
                    log(`Cancelling download ${downloadId} for paused thread ${threadId}`, "info");
                    chrome.downloads.cancel(downloadId, () => {
                        if (!chrome.runtime.lastError) chrome.downloads.erase({
                            id: downloadId
                        });
                        else log(`Failed to cancel download ${downloadId}: ${chrome.runtime.lastError.message}`, "warning");
                    });
                    activeDownloads.delete(key);
                }
            }
        });
    } else {
        if (thread.error) {
            log(`Retrying errored thread "${thread.title}" (${thread.id})`, "info");
            thread.error = false;
        }
        const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
        if (activeCount < MAX_CONCURRENT_THREADS) {
            //log(`Resuming thread "${thread.title}" (${thread.id})`, "info");
            thread.active = true;
            manageThreads();
        } else {
            log(`Cannot activate thread "${thread.title}" (${thread.id}): Maximum concurrent threads (${MAX_CONCURRENT_THREADS}) reached.`, "warning");
        }
    }
    updateWatchedThreads();
    debouncedUpdateUI();
}

function closeThread(threadId) {
    const thread = watchedThreads.find(t => t.id === threadId);
    if (thread) {
        if (thread.closed) {
            log(`Re-opening thread "${thread.title}" (${thread.id}).`, "info");
            thread.closed = false;
            thread.error = false;
            const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
            if (activeCount < MAX_CONCURRENT_THREADS) {
                log(`Activating re-opened thread "${thread.title}" (${thread.id})`, "info");
                thread.active = true;
                manageThreads();
            } else {
                log(`Thread ${threadId} re-opened but remains paused (max concurrent threads reached).`, "warning");
            }
            updateWatchedThreads();
            debouncedUpdateUI();
        } else {
            log(`Closing thread "${thread.title}" (${thread.id})`, "info");
            const wasActive = thread.active;
            thread.closed = true;
            thread.active = false;
            thread.error = false;
            threadProgressTimers.delete(thread.id);
			updateTimersInStorage();
            activeDownloads.forEach((downloadId, key) => {
                if (key.startsWith(`${threadId}-`)) {
                    if (key.endsWith('-processing')) {
                        activeDownloads.delete(key);
                    } else if (Number.isInteger(downloadId)) {
                        log(`Cancelling download ${downloadId} for closed thread ${threadId}`, "info");
                        chrome.downloads.cancel(downloadId, () => {
                            if (!chrome.runtime.lastError) chrome.downloads.erase({
                                id: downloadId
                            });
                            else log(`Failed to cancel download ${downloadId}: ${chrome.runtime.lastError.message}`, "warning");
                        });
                        activeDownloads.delete(key);
                    }
                }
            });
            updateWatchedThreads();
            debouncedUpdateUI();
            if (wasActive && isAnyThreadActive()) { // CHANGED: Use helper
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
        activeDownloads.forEach((downloadId, key) => {
            if (key.startsWith(`${threadId}-`)) {
                if (key.endsWith('-processing')) {
                    activeDownloads.delete(key);
                } else if (Number.isInteger(downloadId)) {
                    log(`Cancelling download ${downloadId} for removed thread ${threadId}`, "info");
                    chrome.downloads.cancel(downloadId, () => {
                        if (!chrome.runtime.lastError) chrome.downloads.erase({
                            id: downloadId
                        });
                        else log(`Failed to cancel download ${downloadId}: ${chrome.runtime.lastError.message}`, "warning");
                    });
                    activeDownloads.delete(key);
                }
            }
        });
        const wasActive = thread.active;
        watchedThreads.splice(threadIndex, 1);
        threadProgressTimers.delete(threadId);
		updateTimersInStorage();
        log(`Thread "${thread.title}" (${threadId}) removed. ${watchedThreads.length} threads remaining.`, "success");
        updateWatchedThreads();
        debouncedUpdateUI();
        if (wasActive && isAnyThreadActive()) { // CHANGED: Use helper
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
    thread.skippedImages = new Set();
    thread.downloadedCount = 0;
    thread.error = false;
    let removedCount = 0;
    const remainingDownloads = new Map();
    for (const [path, data] of downloadedImages) {
        if (data.threadId === threadId) {
            removedCount++;
        } else {
            remainingDownloads.set(path, data);
        }
    }
    if (removedCount > 0) {
        downloadedImages = remainingDownloads;
        log(`Removed ${removedCount} entries from master download history for thread ${threadId}.`, "info");
        chrome.storage.local.set({
            downloadedImages: Array.from(downloadedImages.entries())
        });
    } else {
        log(`No master download history entries found for thread ${threadId}.`, "info");
    }
    log(`Cleared skipped set for thread ${threadId}. Count reset to 0. Banned user skips will re-apply on next process cycle.`, "info");
    updateWatchedThreads();
    debouncedUpdateUI();
    if (thread.active) {
        manageThreads();
    }
    return true;
}

function removeAllThreads() {
    log("Remove All command received. Removing all threads...", "warning");
    activeDownloads.forEach((downloadId, key) => {
        if (key.endsWith('-processing')) {
            activeDownloads.delete(key);
        } else if (Number.isInteger(downloadId)) {
            log(`Cancelling download ${downloadId} as part of Remove All.`, "info");
            chrome.downloads.cancel(downloadId, () => {
                if (!chrome.runtime.lastError) chrome.downloads.erase({
                    id: downloadId
                });
            });
            activeDownloads.delete(key);
        }
    });
    watchedThreads = [];
    threadProgressTimers.clear();
	updateTimersInStorage();
    log(`All threads removed.`, "success");
    updateWatchedThreads();
    debouncedUpdateUI();
}

function forgetAllDownloads() {
    log(`Forgetting ALL downloaded image history... THIS IS IRREVERSIBLE.`, "warning");
    downloadedImages.clear();
    activeDownloads.clear();
    downloadLocks.clear();
    threadProgressTimers.clear();
	updateTimersInStorage();
    watchedThreads.forEach(thread => {
        thread.skippedImages = new Set();
        thread.downloadedCount = 0;
        thread.error = false;
    });
    log(`Cleared skipped sets for all threads. Banned user skips will re-apply on next process cycle.`, "info");
    chrome.storage.local.remove("downloadedImages", () => {
        if (chrome.runtime.lastError) {
            log(`Error clearing downloadedImages from storage: ${chrome.runtime.lastError.message}`, "error");
        } else {
            log(`Cleared downloadedImages key from local storage.`, "info");
        }
    });
    updateWatchedThreads();
    log(`All download history cleared. Reset counts/errors for ${watchedThreads.length} threads.`, "success");
    debouncedUpdateUI();
    if (isAnyThreadActive()) { // CHANGED: Use helper
        manageThreads();
    }
}

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
    chrome.storage.local.set({
        bannedUsernames: Array.from(bannedUsernames)
    });
    debouncedUpdateUI();
    return true;
}

function removeBannedUsername(username) {
    const usernameLower = username.trim().toLowerCase();
    if (!bannedUsernames.has(usernameLower)) {
        log(`Username "${username}" not found in ban list.`, "warning");
        return false;
    }
    bannedUsernames.delete(usernameLower);
    chrome.storage.local.set({
        bannedUsernames: Array.from(bannedUsernames)
    });
    debouncedUpdateUI();
    return true;
}

function clearBannedUsernames() {
    log("Clearing all banned usernames...", "warning");
    bannedUsernames.clear();
    chrome.storage.local.set({
        bannedUsernames: []
    }, () => {
        if (chrome.runtime.lastError) {
            log(`Error clearing bannedUsernames from storage: ${chrome.runtime.lastError.message}`, "error");
            return false;
        }
        log(`Banned usernames list cleared.`, "success");
        debouncedUpdateUI();
        return true;
    });
    return true;
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
        chrome.storage.local.set({
            downloadedImages: Array.from(downloadedImages.entries())
        });
        debouncedUpdateUI();
    } else {}
}
setInterval(cleanupOldDownloads, 24 * 60 * 60 * 1000);


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const messageType = message.type;
    switch (messageType) {
        case 'getStatus':
    new Promise(resolve => chrome.alarms.get("manageThreads", resolve)).then(alarm => {
        const nextTime = alarm?.scheduledTime || null;
        sendResponse({
            isRunning: isAnyThreadActive(), // CHANGED: Use helper
            watchedThreads: watchedThreads.map(thread => ({
                ...thread,
                skippedImages: Array.from(thread.skippedImages || new Set()),
                downloadedCount: thread.downloadedCount || 0,
                totalImages: thread.totalImages || 0,
                timerStartTime: threadProgressTimers.get(thread.id) || null
            })),
            trackedDownloads: downloadedImages.size,
            watchJobs: watchJobs,
            bannedUsernames: Array.from(bannedUsernames),
            nextManageThreads: nextTime,
            maxConcurrentThreads: MAX_CONCURRENT_THREADS,
            populateHistory: populateHistory,
            hideDownloadIcon: hideDownloadIcon,
            prependParentName: prependParentName,
            hideClosedThreads: hideClosedThreads,
            requestId: message.requestId || 0
        });
    }).catch(error => {
        log(`Error getting alarm status for getStatus: ${error.message}`, "error");
        sendResponse({
            isRunning: isAnyThreadActive(), // CHANGED: Use helper
            watchedThreads: watchedThreads.map(thread => ({
                ...thread,
                skippedImages: Array.from(thread.skippedImages || new Set()),
                downloadedCount: thread.downloadedCount || 0,
                totalImages: thread.totalImages || 0,
                timerStartTime: threadProgressTimers.get(thread.id) || null
            })),
            trackedDownloads: downloadedImages.size,
            watchJobs: watchJobs,
            bannedUsernames: Array.from(bannedUsernames),
            nextManageThreads: null,
            maxConcurrentThreads: MAX_CONCURRENT_THREADS,
            populateHistory: populateHistory,
            hideDownloadIcon: hideDownloadIcon,
            prependParentName: prependParentName,
            hideClosedThreads: hideClosedThreads,
            error: "Failed to retrieve alarm status",
            requestId: message.requestId || 0
        });
    });
    return true;
	
        case 'start':
            if (message.threadId) {
                addThreadById(message.board, message.threadId).then(() => sendResponse({
                    success: true
                }));
                return true;
            } else if (message.searchTerm) {
                addWatchJob(message.board, message.searchTerm).then(success => sendResponse({
                    success
                }));
                return true;
            } else {
                log("Start request missing threadId or searchTerm.", "error");
                sendResponse({
                    success: false,
                    error: "Missing threadId or searchTerm"
                });
            }
            break;
        case 'stop':
            stopScraping();
            sendResponse({
                success: true
            });
            break;
        case 'resumeAll':
            resumeAllThreads().then(resumed => sendResponse({
                success: resumed
            }));
            return true;
        case 'toggleThread':
            toggleThread(message.threadId);
            sendResponse({
                success: true
            });
            break;
        case 'closeThread':
            closeThread(message.threadId);
            sendResponse({
                success: true
            });
            break;
        case 'removeThread':
            removeThread(message.threadId);
            sendResponse({
                success: true
            });
            break;
        case 'setWindowId':
            windowId = message.windowId;
            chrome.storage.session.set({
                controlWindowId: message.windowId
            });
            log(`Control window ID set to ${windowId}`, "info");
            sendResponse({
                success: true
            });
            debouncedUpdateUI();
            break;
        case 'forgetAllDownloads':
            forgetAllDownloads();
            sendResponse({
                success: true
            });
            break;
        case 'removeAllThreads':
            removeAllThreads();
            sendResponse({
                success: true
            });
            break;
        case 'forgetThreadDownloads':
            const success = forgetThreadDownloads(message.threadId);
            sendResponse({
                success
            });
            break;
        case 'getSavedPath':
            sendResponse({
                downloadPath: downloadPath
            });
            break;
        case 'updateDownloadPath':
            if (message.path) {
                downloadPath = message.path;
                chrome.storage.local.set({
                    downloadPath: downloadPath
                });
                log(`Download path updated to: ${downloadPath}`, "info");
                sendResponse({
                    success: true
                });
            } else {
                sendResponse({
                    success: false,
                    error: "No path provided"
                });
            }
            break;
        case 'getBannedUsernames':
            sendResponse({
                success: true,
                bannedUsernames: Array.from(bannedUsernames)
            });
            break;
        case 'addBannedUsername':
            const addSuccess = addBannedUsername(message.username);
            sendResponse({
                success: addSuccess
            });
            break;
        case 'removeBannedUsername':
            const removeSuccess = removeBannedUsername(message.username);
            sendResponse({
                success: removeSuccess
            });
            break;
        case 'clearBannedUsernames':
            const clearSuccess = clearBannedUsernames();
            sendResponse({
                success: clearSuccess
            });
            break;
        case 'addWatchJob':
            // REMOVED: No need to check or set isRunning.
            log("User initiated 'Add Watch Job'.", "info");
            addWatchJob(message.board, message.searchTerm).then(jobSuccess => sendResponse({
                success: jobSuccess
            }));
            return true;
        case 'removeWatchJob':
            removeWatchJob(message.id);
            sendResponse({
                success: true
            });
            break;
        case 'checkAllWatchJobs':
            //log("Manual 'Check All' triggered.", "info");
            // REMOVED: No need to check or set isRunning.
            checkForNewThreads().then(() => sendResponse({
                success: true
            }));
            return true;
        case 'syncThreadCounts':
            let changesMade = false;
            for (const thread of watchedThreads) {
                const initialSkippedSize = thread.skippedImages?.size || 0;
                const initialCount = thread.downloadedCount;
                const threadSpecificSkipped = new Set();
                for (const [path, imgData] of downloadedImages) {
                    if (imgData.threadId === thread.id) {
                        const filename = path.split('/').pop();
                        if (filename) threadSpecificSkipped.add(filename);
                    }
                }
                const originalSkipped = thread.skippedImages || new Set();
                originalSkipped.forEach(item => threadSpecificSkipped.add(item));
                thread.skippedImages = threadSpecificSkipped;
                const rebuiltSkippedCount = thread.skippedImages.size;
                const safeTotalImages = Math.max(0, thread.totalImages || 0);
                const newCount = Math.min(rebuiltSkippedCount, safeTotalImages);
                if (initialCount !== newCount || initialSkippedSize !== rebuiltSkippedCount) {
                    log(`Manual Sync: Thread "${thread.title}" (${thread.id}) count ${initialCount}->${newCount}, skipped ${initialSkippedSize}->${rebuiltSkippedCount} (Total: ${thread.totalImages})`, "info");
                    thread.downloadedCount = newCount;
                    changesMade = true;
                }
            }
            if (changesMade) {
                updateWatchedThreads();
                debouncedUpdateUI();
            } else {
                log("Manual Sync: No count discrepancies found.", "info");
            }
            sendResponse({
                success: true
            });
            break;
        case 'updateMaxThreads':
            const newMax = parseInt(message.value, 10);
            if (!isNaN(newMax) && newMax > 0 && newMax <= 20) {
                MAX_CONCURRENT_THREADS = newMax;
                chrome.storage.local.set({
                    maxConcurrentThreads: newMax
                });
                log(`Max concurrent threads updated to ${newMax}`, "info");
                sendResponse({
                    success: true
                });
            } else {
                log(`Invalid value for max concurrent threads: ${message.value}`, "warning");
                sendResponse({
                    success: false,
                    error: "Invalid value. Must be a number between 1 and 20."
                });
            }
            break;
        case 'updateHistorySetting':
    populateHistory = !!message.value;
    chrome.storage.local.set({
        populateHistory: populateHistory
    });
    //log(`Setting 'Populate Download History' updated to: ${populateHistory}`, "info");
    sendResponse({
        success: true
    });
    break;
		case 'updateHideIconSetting':
    hideDownloadIcon = !!message.value;
    
    chrome.storage.local.set({
        hideDownloadIcon: hideDownloadIcon
    });
    
    chrome.downloads.setShelfEnabled(!hideDownloadIcon);
    //log(`Download shelf ${hideDownloadIcon ? 'disabled' : 'enabled'}`, "info");
    
    // Only trigger dud download if we're enabling the shelf
    if (!hideDownloadIcon) {
        setTimeout(() => {
            // Create a data URL instead of using a file
            const dataUrl = 'data:text/plain;base64,ZHVkCg=='; // "dud" in base64
            chrome.downloads.download({
                url: dataUrl,
                filename: 'temp_shelf_trigger.tmp',
                conflictAction: 'overwrite'
            }, (downloadId) => {
                if (chrome.runtime.lastError) {
                    log(`Failed to start temp download: ${chrome.runtime.lastError.message}`, "warning");
                } else {
                    //log(`Started temp download ${downloadId} to trigger shelf`, "debug");
                    // Immediately cancel and erase this download
                    setTimeout(() => {
                        chrome.downloads.cancel(downloadId, () => {
                            setTimeout(() => {
                                chrome.downloads.erase({ id: downloadId });
                            }, 100);
                        });
                    }, 100);
                }
            });
        }, 500);
    }
    
    //log(`Setting 'Hide Download Icon' updated to: ${hideDownloadIcon}`, "info");
    sendResponse({ success: true });
    break;
case 'updatePrependParentNameSetting':
    prependParentName = !!message.value;
    chrome.storage.local.set({ prependParentName: prependParentName });
    //log(`Setting 'Prepend Parent Name' updated to: ${prependParentName}`, "info");
    sendResponse({ success: true });
    break;
case 'updateHideClosedSetting':
    hideClosedThreads = !!message.value;
    chrome.storage.local.set({ hideClosedThreads: hideClosedThreads });
    sendResponse({ success: true });
    break;
    }
});


async function initializeState(result) {
    log("Initializing state from storage...", "info");

    try {
        const sessionData = await chrome.storage.session.get(['controlWindowId']);
        if (sessionData.controlWindowId) {
            await chrome.windows.get(sessionData.controlWindowId);
            windowId = sessionData.controlWindowId;
            //log(`Restored control window ID ${windowId} from session.`, "info");
        }
    } catch (e) {
        log(`Control window session was present but the window was not found. Clearing session data.`, "warning");
        windowId = null;
        await chrome.storage.session.remove('controlWindowId');
    }

    isInitialized = false;
    MAX_CONCURRENT_THREADS = result.maxConcurrentThreads || 5;
    downloadPath = (result.downloadPath || '4chan_downloads').replace(/^\/+|\/+$/g, '');
    populateHistory = typeof result.populateHistory === 'boolean' ? result.populateHistory : true;
    hideDownloadIcon = !!result.hideDownloadIcon;
    prependParentName = !!result.prependParentName;
    hideClosedThreads = !!result.hideClosedThreads;
    chrome.downloads.setShelfEnabled(!hideDownloadIcon);
    //log(`Max concurrent threads: ${MAX_CONCURRENT_THREADS}, Populate History: ${populateHistory}, Hide DL Icon: ${hideDownloadIcon}, Prepend PName: ${prependParentName}, Hide Closed: ${hideClosedThreads}`);
    watchedThreads = result.watchedThreads || [];
    let totalCorrectedCount = 0;
    watchedThreads.forEach(thread => {
        thread.id = Number(thread.id);
        thread.closed = thread.closed || false;
        thread.active = thread.active || false;
        thread.error = thread.error || false;
        thread.totalImages = thread.totalImages || 0;
        thread.downloadedCount = thread.downloadedCount || 0;
        thread.board = thread.board || '';
        thread.url = thread.url || '';
        thread.title = thread.title || `Thread ${thread.id}`;
        thread.time = thread.time || 0;
        if (Array.isArray(thread.skippedImages)) {
            thread.skippedImages = new Set(thread.skippedImages);
        } else if (!(thread.skippedImages instanceof Set)) {
            thread.skippedImages = new Set();
        }
        const initialCount = thread.downloadedCount;
        const safeTotalImages = Math.max(0, thread.totalImages);
        const syncedCount = Math.min(thread.skippedImages.size, safeTotalImages);
        if (initialCount !== syncedCount) {
            log(`Init Sync: Corrected count for thread ${thread.id} from ${initialCount} to ${syncedCount}`, "info");
            thread.downloadedCount = syncedCount;
            totalCorrectedCount++;
        }
    });
    if (totalCorrectedCount > 0) {
        log(`Initialization sync corrected counts for ${totalCorrectedCount} threads.`, "info");
    }
    watchJobs = result.watchJobs || [];
    if (result.lastSearchParams) {
        log("Migrating legacy 'lastSearchParams' to new 'watchJobs' system.", "info");
        chrome.storage.local.remove('lastSearchParams');
    }
    if (result.downloadedImages && Array.isArray(result.downloadedImages)) {
        try {
            downloadedImages = new Map(result.downloadedImages);
            for (let [key, value] of downloadedImages.entries()) {
                if (typeof value !== 'object' || typeof value.timestamp !== 'number' || typeof value.threadId !== 'number') {
                    downloadedImages.delete(key);
                }
            }
        } catch (e) {
            log(`Error converting stored downloadedImages to Map, resetting. Error: ${e.message}`, "error");
            downloadedImages = new Map();
            chrome.storage.local.remove("downloadedImages");
        }
    } else {
        downloadedImages = new Map();
    }
    if (result.bannedUsernames && Array.isArray(result.bannedUsernames)) {
        try {
            bannedUsernames = new Set(result.bannedUsernames.map(u => String(u).toLowerCase()));
        } catch (e) {
            log(`Error converting stored bannedUsernames to Set, resetting. Error: ${e.message}`, "error");
            bannedUsernames = new Set();
            chrome.storage.local.remove("bannedUsernames");
        }
    } else {
        bannedUsernames = new Set();
        chrome.storage.local.set({
            bannedUsernames: []
        });
    }
    // Load and restore thread progress timers from storage
    if (result.threadProgressTimers && Array.isArray(result.threadProgressTimers)) {
        try {
            threadProgressTimers = new Map(result.threadProgressTimers);
            //log(`Restored ${threadProgressTimers.size} active close timers from storage.`, "info");
        } catch (e) {
            log(`Error converting stored threadProgressTimers to Map, resetting. Error: ${e.message}`, "error");
            threadProgressTimers = new Map();
            chrome.storage.local.remove("threadProgressTimers");
        }
    } else {
        threadProgressTimers = new Map();
    }
	
	
    updateWatchedThreads();
    //log(`Initialization complete. ${watchedThreads.length} threads loaded.`, "info");
    isInitialized = true;
    cleanupOldDownloads();
}

//function above is already closed here, below is more code

chrome.storage.local.get(null, async (result) => {
    await initializeState(result);
    if (isAnyThreadActive()) { 
        log("Active threads found, attempting to sync/process.", "happy");
        resumeActiveThreads().catch(err => log(`Resume/Sync failed after restart: ${err.message}`, "error"));
    }
    setupAlarms();
    debouncedUpdateUI();
});
chrome.windows.onRemoved.addListener((closedWindowId) => {
    chrome.storage.session.get('controlWindowId', (result) => {
        if (result.controlWindowId && result.controlWindowId === closedWindowId) {
            log(`Control window ${closedWindowId} closed. Pausing all threads and resetting Hide DL Icon.`, "info");
            
            if (hideDownloadIcon) {
                hideDownloadIcon = false;
                chrome.storage.local.set({
                    hideDownloadIcon: false
                });
                chrome.downloads.setShelfEnabled(true);
                log(`Hide Download Icon automatically unchecked on window close`, "info");
                
                setTimeout(() => {
                    const dataUrl = 'data:text/plain;base64,ZHVkCg=='; // "dud" in base64
                    chrome.downloads.download({
                        url: dataUrl,
                        filename: 'temp_shelf_restore.tmp',
                        conflictAction: 'overwrite'
                    }, (downloadId) => {
                        if (chrome.runtime.lastError) {
                            log(`Failed to start temp download for shelf restore: ${chrome.runtime.lastError.message}`, "warning");
                        } else {
                            //log(`Started temp download ${downloadId} to restore shelf visibility`, "debug");
                            setTimeout(() => {
                                chrome.downloads.cancel(downloadId, () => {
                                    setTimeout(() => {
                                        chrome.downloads.erase({ id: downloadId });
                                    }, 100);
                                });
                            }, 100);
                        }
                    });
                }, 500);
            }
            
            stopScraping();
            windowId = null;
            chrome.storage.session.remove('controlWindowId');
        }
    });
});
log("Background script finished loading.", "info");