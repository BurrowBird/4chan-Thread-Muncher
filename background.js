console.log("Content script loaded.");
// No messaging needed unless explicitly required

let isRunning = false;
let watchedThreads = [];
let downloadedImages = new Map(); // Map<fullPath: string, { timestamp: number, threadId: number }>
let bannedUsernames = new Set(); // Set<string> - stores lowercase usernames
let activeDownloads = new Map(); // Map<downloadKey: string, downloadId: number | boolean> - boolean used for 'processing' state
let downloadLocks = new Map(); // Map<downloadKey: string, Promise<void>>
let openerTabId = null;
let windowId = null;
let lastSearchParams = { board: '', searchTerm: '', downloadPath: '4chan_downloads' };
let threadProgressTimers = new Map(); // Map<threadId: number, timestamp: number>
let isResuming = false;
let lastResumeTime = 0;
let lastLogMessage = null;
let isInitialized = false;

const RATE_LIMIT_MS = 1500;
const MAX_CONCURRENT_THREADS = 5;
const STUCK_TIMER = 5 * 60 * 1000; // 5 minutes
const MANAGE_THREADS_INTERVAL = 1; // 1 minute

const MAX_DOWNLOADED_IMAGES = 18000; // Limit history size
const MIN_RESUME_INTERVAL = 1000;
const MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 15000;

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
        return; // Don't reset windowId here, it might reappear
      }
      if (win) {
        chrome.runtime.sendMessage({ type: "log", message: message, logType: type }, () => {
          if (chrome.runtime.lastError) {
            // Suppress common errors
          }
        });
      }
    });
  }
}

async function fetchWithRetry(url) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (!isRunning && !isInitialized) throw new Error("Process stopped during fetch");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      return await response.json();
    } catch (error) {
      log(`Fetch failed for ${url}: ${error.message}. Retry ${i + 1}/${MAX_RETRIES}`, "warning");
      if (i === MAX_RETRIES - 1) {
        log(`Max retries reached for ${url}, giving up fetch`, "error");
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS * (i + 1)));
    }
  }
  throw new Error(`Fetch failed for ${url} after ${MAX_RETRIES} retries.`);
}

function getFullPath(threadId, username, filename) {
  const sanitizedUsername = username ? username.replace(/[^a-zA-Z0-9_.-]/g, "_") : "Anonymous";
  const sanitizedFilename = filename ? filename.replace(/[^a-zA-Z0-9_.-]/g, "_") : "unknown_file";
  const cleanDownloadPath = lastSearchParams.downloadPath.replace(/^\/+|\/+$/g, '');
  return `${cleanDownloadPath}/${threadId}/${sanitizedUsername}/${sanitizedFilename}`;
}

async function downloadImage(url, threadId, username) {
    const filename = url.split('/').pop();
    const thread = watchedThreads.find(t => t.id === threadId);
    if (!thread) {
        log(`Thread ${threadId} not found for ${url}`, "error");
        return { success: false, downloaded: false };
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
        return { success: true, downloaded: false };
    }

    const fullPath = getFullPath(threadId, username, filename);
    const downloadKey = `${threadId}-${filename}`;

    if (downloadLocks.has(downloadKey)) {
        await downloadLocks.get(downloadKey);
    }
    let resolveLock;
    const lockPromise = new Promise(resolve => { resolveLock = resolve; });
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
            return { success: true, downloaded: false };
        }

        if (!thread.active) {
            return { success: false, downloaded: false };
        }

        for (let i = 0; i < MAX_RETRIES; i++) {
            if (!isRunning || !watchedThreads.find(t => t.id === threadId)?.active) {
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
                            reject(new Error(`Download initiation failed: ${chrome.runtime.lastError?.message || 'Unknown error'}`));
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
                            chrome.downloads.cancel(downloadId, () => { chrome.downloads.erase({ id: downloadId }); });
                        }
                        reject(new Error("Download timed out"));
                    }, DOWNLOAD_TIMEOUT_MS);

                    listener = (delta) => {
                        if (delta.id === downloadId) {
                            if (delta.state && delta.state.current === "complete") {
                                clearTimeout(timeoutId);
                                chrome.downloads.onChanged.removeListener(listener);
                                activeDownloads.delete(downloadKey);
                                resolve(true);
                            } else if (delta.state && delta.state.current === "interrupted") {
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
                    if (!isRunning || !watchedThreads.find(t => t.id === threadId)?.active) {
                        log(`Stopping retries for ${filename} as thread ${threadId} or process became inactive during wait`, "warning");
                        throw new Error("Thread or process inactive during retry wait");
                    }
                }
            }
        }
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
  try {
    if (!downloadItem || typeof downloadItem.filename !== 'string' || !downloadItem.id) {
      log(`Invalid downloadItem in onCreated listener: ${JSON.stringify(downloadItem)}`, "warning");
      return;
    }

    const fullPath = downloadItem.filename.replace(/\\/g, '/');
    const pathParts = fullPath.split('/');
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
  updateUI();
  updateQueue = [];
}, 600);

function updateUI() {
  if (windowId) {
    chrome.windows.get(windowId, {}, (win) => {
      if (chrome.runtime.lastError || !win) {
        return;
      }
      chrome.runtime.sendMessage({
        type: "updateStatus",
        isRunning: watchedThreads.some(t => t.active && !t.closed),
        watchedThreads: watchedThreads.map(thread => ({
          ...thread,
          skippedImages: Array.from(thread.skippedImages || new Set()),
          downloadedCount: thread.downloadedCount || 0,
          totalImages: thread.totalImages || 0
        })),
        trackedDownloads: downloadedImages.size,
        bannedUsernames: Array.from(bannedUsernames),
        nextManageThreads: chrome.alarms.get("manageThreads")?.scheduledTime || null
      }, () => {
        if (chrome.runtime.lastError && !chrome.runtime.lastError.message.includes("Receiving end does not exist")) {
          log(`UI update message failed: ${chrome.runtime.lastError.message}`, "warning");
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
    log("Persisting watched thread changes to storage.", "debug");
  }

  const storableThreads = watchedThreads.map(thread => ({
    ...thread,
    skippedImages: Array.from(thread.skippedImages || new Set())
  }));

  chrome.storage.local.set({ watchedThreads: storableThreads }, () => {
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
    const data = await fetchWithRetry(threadUrl);
    if (!data || !Array.isArray(data.posts) || data.posts.length === 0) {
      throw new Error("Invalid or empty API response received");
    }

    if (data.posts[0].closed === 1 || data.posts[0].archived === 1) {
      log(`Thread "${thread.title}" (${thread.id}) is marked ${data.posts[0].closed ? 'closed' : 'archived'} on 4chan. Closing locally.`, "info");
      thread.closed = true;
      thread.active = false;
      thread.error = false;
      threadProgressTimers.delete(thread.id);
      updateWatchedThreads();
      debouncedUpdateUI();
      activeDownloads.delete(`${thread.id}-processing`);
      await checkForNewThreads();
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

    if (thread.downloadedCount < thread.totalImages) {
      threadProgressTimers.delete(thread.id);
    } else if (thread.totalImages > 0) {
      if (!threadProgressTimers.has(thread.id)) {
        log(`Thread "${thread.title}" (${thread.id}) appears complete (${thread.downloadedCount}/${thread.totalImages}). Starting potential close timer.`, "info");
        threadProgressTimers.set(thread.id, Date.now());
      }
    } else {
      threadProgressTimers.delete(thread.id);
    }

    updateWatchedThreads();
    debouncedUpdateUI();

    if (thread.downloadedCount < thread.totalImages) {
      let downloadedInRun = 0;
      for (const post of imagePosts) {
        if (!thread.active || !isRunning) {
          log(`Stopping image processing loop for thread "${thread.title}" (${thread.id}): Thread/Process inactive.`, "warning");
          break;
        }

        const imageUrl = `https://i.4cdn.org/${thread.board}/${post.tim}${post.ext}`;
        const filename = `${post.tim}${post.ext}`;

        if (!thread.skippedImages.has(filename)) {
          const result = await downloadImage(imageUrl, thread.id, post.name);
          if (result.success && result.downloaded) {
            downloadedInRun++;
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS / 3));
          }
        }
        if (!thread.active || !isRunning) break;
      }
      log(`processThread: Finished processing run for thread "${thread.title}" (${thread.id}). ${downloadedInRun} new images downloaded. Current state: ${thread.downloadedCount}/${thread.totalImages}`, "info");

      if (thread.active && thread.downloadedCount >= thread.totalImages && thread.totalImages > 0) {
        threadProgressTimers.set(thread.id, Date.now());
      }
    } else if (thread.totalImages > 0) {
      // No new images, timer already handled above
    } else {
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

  const processCandidates = watchedThreads.filter(t => t.active && !t.error && !t.closed);
  const finishedCandidates = watchedThreads.filter(t => !t.active && !t.closed && !t.error && t.downloadedCount >= t.totalImages && t.totalImages > 0);
  const stuckCandidates = watchedThreads.filter(t => t.active && !t.error && !t.closed && threadProgressTimers.has(t.id));

  log(`manageThreads: Processing ${processCandidates.length} active, checking ${stuckCandidates.length} potentially stuck.`, "debug");

  // Check potentially stuck/finished threads
  const now = Date.now();
  for (const thread of [...stuckCandidates, ...finishedCandidates]) {
    const timerStartTime = threadProgressTimers.get(thread.id);
    if (timerStartTime && (now - timerStartTime >= STUCK_TIMER)) {
      log(`Thread "${thread.title}" (${thread.id}) timer expired. Checking for new images...`, "info");
      try {
        const data = await fetchWithRetry(thread.url);
        const newImageCount = data.posts.filter(post => post.tim && post.ext).length;

        if (data.posts[0].closed === 1 || data.posts[0].archived === 1) {
          log(`Thread "${thread.title}" (${thread.id}) timer check: Thread now ${data.posts[0].closed ? 'closed' : 'archived'} on 4chan. Closing locally.`, "info");
          thread.closed = true;
          thread.active = false;
          thread.error = false;
          threadProgressTimers.delete(thread.id);
        } else if (newImageCount > thread.totalImages) {
          log(`Thread "${thread.title}" (${thread.id}) timer check: Found new images (${thread.totalImages} -> ${newImageCount}). Re-activating processing.`, "info");
          thread.totalImages = newImageCount;
          thread.active = true;
          thread.error = false;
          threadProgressTimers.delete(thread.id);
        } else {
          log(`Thread "${thread.title}" (${thread.id}) timer check: No new images found. Closing thread locally.`, "info");
          thread.closed = true;
          thread.active = false;
          threadProgressTimers.delete(thread.id);
        }
      } catch (error) {
        log(`Failed to re-check thread "${thread.title}" (${thread.id}) state during timer check: ${error.message}. Closing thread.`, "error");
        thread.closed = true;
        thread.active = false;
        thread.error = true;
        threadProgressTimers.delete(thread.id);
      }
      updateWatchedThreads();
      debouncedUpdateUI();
      await checkForNewThreads();
    }
  }

  // Process active threads
  const activeProcessingCount = Array.from(activeDownloads.keys()).filter(k => k.endsWith('-processing')).length;
  const availableSlots = MAX_CONCURRENT_THREADS - activeProcessingCount;

  if (availableSlots <= 0) {
    return;
  }

  const threadsToProcess = processCandidates
    .filter(t => !activeDownloads.has(`${t.id}-processing`))
    .filter(t => t.downloadedCount < t.totalImages || t.totalImages === 0 || (t.downloadedCount >= t.totalImages && t.totalImages > 0))
    .slice(0, availableSlots);

  if (threadsToProcess.length > 0) {
    await Promise.all(threadsToProcess.map(thread => processThread(thread).catch(err => {
      log(`Unhandled error during manageThreads processThread call for ${thread.id}: ${err.message}`, "error");
    })));
  }

  const currentActiveCount = watchedThreads.filter(t => t.active && !t.closed && !t.error).length;
  if (currentActiveCount < MAX_CONCURRENT_THREADS && isRunning) {
    await checkForNewThreads();
  }

  isRunning = watchedThreads.some(t => t.active && !t.closed);
  chrome.storage.local.set({ isRunning });

  debouncedUpdateUI();
}

function setupAlarms() {
  log("Setting up 'manageThreads' alarm.", "info");
  chrome.alarms.create("manageThreads", {
    delayInMinutes: 0.1,
    periodInMinutes: MANAGE_THREADS_INTERVAL
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "manageThreads") {
    manageThreads().catch(error => {
      log(`Error during scheduled manageThreads execution: ${error.message}`, "error");
    });
  }
});

async function resumeActiveThreads() {
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
    if (!thread.active || thread.closed || thread.error) continue;

    log(`Syncing state for thread "${thread.title}" (${thread.id})...`, "debug");
    try {
      const data = await fetchWithRetry(thread.url);
      if (!data || !Array.isArray(data.posts)) throw new Error("Invalid API response during resume sync");

      if (data.posts[0].closed === 1 || data.posts[0].archived === 1) {
        log(`Thread "${thread.title}" (${thread.id}) resume check: Thread now ${data.posts[0].closed ? 'closed' : 'archived'}. Closing locally.`, "info");
        CANthread.closed = true;
        thread.active = false;
        thread.error = false;
        threadProgressTimers.delete(thread.id);
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
        log(`Synced state for thread "${thread.title}" (${thread.id}): Count ${oldCount} -> ${thread.downloadedCount}, Skipped Set Size ${initialSkippedSize} -> ${rebuiltSkippedCount}, Total Images: ${thread.totalImages}`, "info");
      }

      thread.error = false;
      updateWatchedThreads();

      if (thread.downloadedCount >= thread.totalImages && thread.totalImages > 0) {
        if (!threadProgressTimers.has(thread.id)) {
          threadProgressTimers.set(thread.id, Date.now());
        }
      } else {
        threadProgressTimers.delete(thread.id);
      }

    } catch (error) {
      log(`Failed to sync state for thread "${thread.title}" (${thread.id}) on resume: ${error.message}`, "error");
      thread.error = true;
      thread.active = false;
      updateWatchedThreads();
    }
  }
  log(`syncAndProcessActiveThreads: Finished state sync.`, "info");
  debouncedUpdateUI();
  manageThreads();
}

chrome.runtime.onStartup.addListener(() => {
  log("Service worker started (onStartup event).", "info");
  chrome.storage.local.get(["watchedThreads", "lastSearchParams", "downloadedImages", "isRunning", "bannedUsernames"], async (result) => {
    await initializeState(result);
    if (isRunning) {
      log("onStartup: isRunning was true, attempting to sync/process active threads.", "info");
      resumeActiveThreads().catch(err => log(`Resume/Sync failed after startup: ${err.message}`, "error"));
    }
    setupAlarms();
    debouncedUpdateUI();
  });
});

chrome.runtime.onInstalled.addListener(details => {
  log(`Extension ${details.reason}. Initializing...`, "info");
  setupAlarms();
});

async function directoryExists(threadId) {
  const cleanDownloadPath = lastSearchParams.downloadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexPattern = `^${cleanDownloadPath}/${threadId}/.*`;

  try {
    const results = await new Promise((resolve) => {
      chrome.downloads.search({ filenameRegex: regexPattern, limit: 1, state: "complete" }, resolve);
    });
    return results && results.length > 0;
  } catch (error) {
    log(`Error searching downloads for thread ${threadId} directory check: ${error.message}`, "error");
    return false;
  }
}

async function checkForNewThreads() {
  if (!isRunning || !isInitialized) {
    return;
  }
  if (!lastSearchParams.board || !lastSearchParams.searchTerm) {
    log("checkForNewThreads: Skipping, board or search term missing.", "info");
    return;
  }

  const activeThreadCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
  const availableSlots = MAX_CONCURRENT_THREADS - activeThreadCount;

  if (availableSlots <= 0) {
    return;
  }

  await searchAndWatchThreads(lastSearchParams.board, lastSearchParams.searchTerm, availableSlots);
}

async function searchAndWatchThreads(board, searchTerm, limit = MAX_CONCURRENT_THREADS) {
  if (!isRunning) return;

  const catalogUrl = `https://a.4cdn.org/${board}/catalog.json`;
  let regex;
  try {
    regex = new RegExp(searchTerm, 'i');
  } catch (e) {
    log(`Invalid regex pattern: "${searchTerm}". Error: ${e.message}`, "error");
    return;
  }

  const sevenDaysAgo = Date.now() / 1000 - (7 * 24 * 60 * 60);

  lastSearchParams.board = board;
  lastSearchParams.searchTerm = searchTerm;
  chrome.storage.local.set({ lastSearchParams });

  try {
    const catalog = await fetchWithRetry(catalogUrl);
    if (!Array.isArray(catalog)) {
      throw new Error("Catalog response was not an array");
    }

    let potentialNewThreads = [];
    for (const page of catalog) {
      if (!page || !Array.isArray(page.threads)) continue;

      for (const threadData of page.threads) {
        if (!threadData || !threadData.no || typeof threadData.no !== 'number') continue;

        if (threadData.time < sevenDaysAgo) {
          continue;
        }

        if (watchedThreads.some(t => t.id === threadData.no)) {
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

          const newThread = {
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
          };
          potentialNewThreads.push(newThread);
        }
      }
    }

    potentialNewThreads.sort((a, b) => b.time - a.time);
    const threadsToAdd = potentialNewThreads.slice(0, limit);

    if (threadsToAdd.length > 0) {
      log(`Found ${threadsToAdd.length} new matching threads. Adding to watch list.`, "success");
      threadsToAdd.forEach(t => {
        t.active = true;
        watchedThreads.push(t);
        log(`Added: "${t.title}" (${t.id})`, "info");
      });
      updateWatchedThreads();
      debouncedUpdateUI();
      manageThreads();
    }
  } catch (error) {
    log(`Error searching catalog for /${board}/ with term "${searchTerm}": ${error.message}`, "error");
  }
}

async function addThreadById(board, threadIdStr) {
  const threadId = parseInt(threadIdStr);
  if (isNaN(threadId)) {
    log(`Invalid Thread ID provided: ${threadIdStr}`, "error");
    return;
  }

  log(`Attempting to add thread ${threadId} from board /${board}/ by ID...`, "info");

  lastSearchParams.board = board;
  chrome.storage.local.set({ lastSearchParams });

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
    const data = await fetchWithRetry(threadUrl);
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

function startScraping(board, searchTerm, threadId, tabId, downloadPath) {
  isRunning = true;
  openerTabId = tabId;
  lastSearchParams.downloadPath = downloadPath || "4chan_downloads";

  chrome.storage.local.set({ isRunning, lastSearchParams });

  let startPromise;
  if (threadId) {
    startPromise = addThreadById(board, threadId);
  } else if (searchTerm) {
    const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
    const limit = Math.max(0, MAX_CONCURRENT_THREADS - activeCount);
    startPromise = searchAndWatchThreads(board, searchTerm, limit);
  } else {
    log("Start command failed: Neither search term nor thread ID provided.", "error");
    isRunning = watchedThreads.some(t => t.active && !t.closed);
    chrome.storage.local.set({ isRunning });
    debouncedUpdateUI();
    return;
  }

  startPromise.then(() => {
    isRunning = watchedThreads.some(t => t.active && !t.closed);
    chrome.storage.local.set({ isRunning });
    debouncedUpdateUI();
  }).catch(error => {
    log(`Error during initial start operation: ${error.message}`, "error");
    isRunning = watchedThreads.some(t => t.active && !t.closed);
    chrome.storage.local.set({ isRunning });
    debouncedUpdateUI();
  });
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
            if (!chrome.runtime.lastError) chrome.downloads.erase({ id: downloadId });
          });
        }
        activeDownloads.delete(key);
      }
    }
  });
  Array.from(activeDownloads.keys()).filter(k => k.endsWith('-processing')).forEach(k => activeDownloads.delete(k));

  isRunning = false;
  chrome.storage.local.set({ isRunning });

  if (changed) {
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
      isRunning = currentActiveCount > 0;
      chrome.storage.local.set({ isRunning });
      return false;
    }

    log(`Attempting to resume up to ${availableSlots} threads initially...`, "info");
    isRunning = true;
    chrome.storage.local.set({ isRunning });

    for (const thread of threadsToResume) {
      if (availableSlots <= 0) {
        log(`Resume All: Reached max concurrent threads (${MAX_CONCURRENT_THREADS}). Remaining threads kept paused.`, "info");
        break;
      }
      log(`Resuming thread "${thread.title}" (${thread.id})`, "info");
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

  if (thread.active) {
    log(`Pausing thread "${thread.title}" (${threadId})`, "info");
    thread.active = false;
    threadProgressTimers.delete(thread.id);

    activeDownloads.forEach((downloadId, key) => {
      if (key.startsWith(`${threadId}-`)) {
        if (key.endsWith('-processing')) {
          activeDownloads.delete(key);
        } else if (Number.isInteger(downloadId)) {
          log(`Cancelling download ${downloadId} for paused thread ${threadId}`, "info");
          chrome.downloads.cancel(downloadId, () => {
            if (!chrome.runtime.lastError) chrome.downloads.erase({ id: downloadId });
          });
          activeDownloads.delete(key);
        }
      }
    });
    isRunning = watchedThreads.some(t => t.active && !t.closed);
    chrome.storage.local.set({ isRunning });

  } else {
    if (thread.closed) {
      log(`Cannot activate thread "${thread.title}" (${threadId}) because it is marked as closed.`, "warning");
      return;
    }
    if (thread.error) {
      log(`Retrying errored thread "${thread.title}" (${threadId})`, "info");
      thread.error = false;
    }

    const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
    if (activeCount >= MAX_CONCURRENT_THREADS) {
      log(`Cannot activate thread "${thread.title}" (${threadId}): Maximum concurrent threads (${MAX_CONCURRENT_THREADS}) reached.`, "warning");
      return;
    }

    log(`Resuming thread "${thread.title}" (${threadId})`, "info");
    thread.active = true;
    thread.error = false;
    isRunning = true;
    chrome.storage.local.set({ isRunning });
    updateWatchedThreads();
    manageThreads();
  }
  updateWatchedThreads();
  debouncedUpdateUI();
}

function closeThread(threadId) {
  const thread = watchedThreads.find(t => t.id === threadId);
  if (thread) {
    log(`Closing thread "${thread.title}" (${threadId})`, "info");
    const wasActive = thread.active;
    thread.closed = true;
    thread.active = false;
    thread.error = false;
    threadProgressTimers.delete(thread.id);

    activeDownloads.forEach((downloadId, key) => {
      if (key.startsWith(`${threadId}-`)) {
        if (key.endsWith('-processing')) {
          activeDownloads.delete(key);
        } else if (Number.isInteger(downloadId)) {
          log(`Cancelling download ${downloadId} for closed thread ${threadId}`, "info");
          chrome.downloads.cancel(downloadId, () => {
            if (!chrome.runtime.lastError) chrome.downloads.erase({ id: downloadId });
          });
          activeDownloads.delete(key);
        }
      }
    });
    isRunning = watchedThreads.some(t => t.active && !t.closed);
    chrome.storage.local.set({ isRunning });

    updateWatchedThreads();
    debouncedUpdateUI();

    if (wasActive && isRunning) {
      checkForNewThreads();
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
            if (!chrome.runtime.lastError) chrome.downloads.erase({ id: downloadId });
          });
          activeDownloads.delete(key);
        }
      }
    });

    const wasActive = thread.active;
    watchedThreads.splice(threadIndex, 1);
    threadProgressTimers.delete(threadId);

    log(`Thread "${thread.title}" (${threadId}) removed. ${watchedThreads.length} threads remaining.`, "success");
    isRunning = watchedThreads.some(t => t.active && !t.closed);
    chrome.storage.local.set({ isRunning });

    updateWatchedThreads();
    debouncedUpdateUI();

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

  activeDownloads.forEach((_, key) => {
    if (key.startsWith(`${threadId}-`)) activeDownloads.delete(key);
  });
  downloadLocks.forEach((_, key) => {
    if (key.startsWith(`${threadId}-`)) downloadLocks.delete(key);
  });

  log(`Forgetting download history for thread "${thread.title}" (${threadId})...`, "warning");
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
  }

  log(`Cleared skipped set for thread ${threadId}. Count reset to 0. Banned user skips will re-apply on next process cycle.`, "info");
  updateWatchedThreads();

  debouncedUpdateUI();

  if (thread.active) {
    manageThreads();
  }

  return true;
}

function forgetAllDownloads() {
  log(`Forgetting ALL downloaded image history... THIS IS IRREVERSIBLE.`, "warning");
  downloadedImages.clear();
  activeDownloads.clear();
  downloadLocks.clear();
  threadProgressTimers.clear();

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

  if (isRunning) {
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
  chrome.storage.local.set({ bannedUsernames: Array.from(bannedUsernames) });
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
  chrome.storage.local.set({ bannedUsernames: Array.from(bannedUsernames) });
  debouncedUpdateUI();
  return true;
}

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
    chrome.storage.local.set({ downloadedImages: Array.from(downloadedImages.entries()) });
    debouncedUpdateUI();
  }
}
setInterval(cleanupOldDownloads, 24 * 60 * 60 * 1000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const messageType = message.type;

  if (messageType === "getStatus") {
    new Promise(resolve => chrome.alarms.get("manageThreads", resolve))
      .then(alarm => {
        sendResponse({
          isRunning: watchedThreads.some(t => t.active && !t.closed),
          watchedThreads: watchedThreads.map(thread => ({
            ...thread,
            skippedImages: Array.from(thread.skippedImages || new Set()),
            downloadedCount: thread.downloadedCount || 0,
            totalImages: thread.totalImages || 0
          })),
          trackedDownloads: downloadedImages.size,
          bannedUsernames: Array.from(bannedUsernames),
          nextManageThreads: alarm?.scheduledTime || null
        });
      })
      .catch(error => {
        log(`Error getting alarm status for getStatus: ${error.message}`, "error");
        sendResponse({
          isRunning: watchedThreads.some(t => t.active && !t.closed),
          watchedThreads: watchedThreads.map(thread => ({
            ...thread,
            skippedImages: Array.from(thread.skippedImages || new Set()),
            downloadedCount: thread.downloadedCount || 0,
            totalImages: thread.totalImages || 0
          })),
          trackedDownloads: downloadedImages.size,
          bannedUsernames: Array.from(bannedUsernames),
          nextManageThreads: null,
          error: "Failed to retrieve alarm status"
        });
      });
    return true;
  } else if (messageType === "start") {
    if (!isInitialized) {
      log("Start request received before initialization, delaying...", "info");
      const initCheckInterval = setInterval(() => {
        if (isInitialized) {
          clearInterval(initCheckInterval);
          log("Initialization complete, proceeding with start request.", "info");
          startScraping(message.board, message.searchTerm, message.threadId, sender.tab?.id, message.downloadPath);
          sendResponse({ success: true });
        }
      }, 200);
      setTimeout(() => {
        if (!isInitialized) {
          clearInterval(initCheckInterval);
          log("Initialization timeout waiting for start request.", "error");
          sendResponse({ success: false, error: "Initialization timeout" });
        }
      }, 5000);
      return true;
    } else {
      startScraping(message.board, message.searchTerm, message.threadId, sender.tab?.id, message.downloadPath);
      sendResponse({ success: true });
    }
  } else if (messageType === "stop") {
    stopScraping();
    sendResponse({ success: true });
  } else if (messageType === "resumeAll") {
    resumeAllThreads().then(resumed => sendResponse({ success: resumed }));
    return true;
  } else if (messageType === "toggleThread") {
    toggleThread(message.threadId);
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
    debouncedUpdateUI();
  } else if (messageType === "forgetAllDownloads") {
    forgetAllDownloads();
    sendResponse({ success: true });
  } else if (messageType === "forgetThreadDownloads") {
    const success = forgetThreadDownloads(message.threadId);
    sendResponse({ success });
  } else if (messageType === "getLastSearchParams") {
    sendResponse(lastSearchParams);
  } else if (messageType === "getBannedUsernames") {
    sendResponse({ success: true, bannedUsernames: Array.from(bannedUsernames) });
  } else if (messageType === "addBannedUsername") {
    const success = addBannedUsername(message.username);
    sendResponse({ success });
  } else if (messageType === "removeBannedUsername") {
    const success = removeBannedUsername(message.username);
    sendResponse({ success });
  } else if (messageType === "clearBannedUsernames") {
    const success = clearBannedUsernames();
    sendResponse({ success });
  } else if (messageType === "syncThreadCounts") {
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
    sendResponse({ success: true });
  } else {
    log(`Received unknown message type: ${messageType}`, "warning");
    sendResponse({ success: false, error: "Unknown message type" });
  }

  return (messageType === "getStatus" || (messageType === "start" && !isInitialized) || messageType === "resumeAll");
});

async function initializeState(result) {
  log("Initializing state from storage...", "info");
  isInitialized = false;

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
      log(`Invalid skippedImages format for thread ${thread.id}, resetting.`, "warning");
      thread.skippedImages = new Set();
    }

    const initialCount = thread.downloadedCount;
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

  lastSearchParams = result.lastSearchParams || { board: '', searchTerm: '', downloadPath: '4chan_downloads' };
  lastSearchParams.downloadPath = (lastSearchParams.downloadPath || '4chan_downloads').replace(/^\/+|\/+$/g, '');

  if (result.downloadedImages && Array.isArray(result.downloadedImages)) {
    try {
      downloadedImages = new Map(result.downloadedImages);
      for (let [key, value] of downloadedImages.entries()) {
        if (typeof value !== 'object' || typeof value.timestamp !== 'number' || typeof value.threadId !== 'number') {
          log(`Removing invalid entry from downloadedImages: Key=${key}, Value=${JSON.stringify(value)}`, "warning");
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
      log(`Loaded ${bannedUsernames.size} banned usernames.`, "info");
    } catch (e) {
      log(`Error converting stored bannedUsernames to Set, resetting. Error: ${e.message}`, "error");
      bannedUsernames = new Set();
      chrome.storage.local.remove("bannedUsernames");
    }
  } else {
    bannedUsernames = new Set();
    log("Initialized empty banned usernames list.", "info");
    chrome.storage.local.set({ bannedUsernames: [] });
  }

  isRunning = result.isRunning || false;
  const actualRunning = watchedThreads.some(t => t.active && !t.closed);
  if (isRunning !== actualRunning) {
    log(`Correcting isRunning state: ${isRunning} -> ${actualRunning}`, "info");
    isRunning = actualRunning;
    chrome.storage.local.set({ isRunning: actualRunning });
  }

  updateWatchedThreads();
  log(`Initialization complete. ${watchedThreads.length} threads loaded. ${downloadedImages.size} downloads tracked. ${bannedUsernames.size} users banned. isRunning: ${isRunning}`, "info");
  isInitialized = true;

  cleanupOldDownloads();
}

chrome.storage.local.get(["watchedThreads", "lastSearchParams", "downloadedImages", "isRunning", "bannedUsernames"], async (result) => {
  await initializeState(result);
  if (isRunning) {
    log("Service worker restart: isRunning was true, attempting to sync/process active threads.", "info");
    resumeActiveThreads().catch(err => log(`Resume/Sync failed after restart: ${err.message}`, "error"));
  }
  setupAlarms();
  debouncedUpdateUI();
});

chrome.windows.onRemoved.addListener((closedWindowId) => {
  if (closedWindowId === windowId) {
    log(`Control window ${closedWindowId} closed. Pausing all threads.`, "info");
    stopScraping();
    windowId = null;
    log(`Reset windowId to null.`, "debug");
  }
});

log("Background script finished loading.", "info");