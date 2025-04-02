let isRunning = false;
let watchedThreads = [];
let downloadedImages = new Map();
let activeDownloads = new Map();
let downloadLocks = new Map();
let openerTabId = null;
let windowId = null;
let lastSearchParams = { board: '', searchTerm: '', downloadPath: '4chan_downloads' };
let threadProgressTimers = new Map();

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const MAX_CONCURRENT_THREADS = 5;
const DOWNLOAD_TIMEOUT_MS = 9000;
const MAX_DOWNLOADED_IMAGES = 18000;
const STUCK_TIMER = 180000;

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
  console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
  if (windowId) {
    chrome.windows.get(windowId, {}, (win) => {
      if (chrome.runtime.lastError) {
        console.warn(`[${timestamp}] Window ${windowId} not found: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (win) {
        chrome.runtime.sendMessage({ type: "log", message: `[${timestamp}] ${message}`, logType: type }, () => {
          if (chrome.runtime.lastError) {
            console.warn(`[${timestamp}] Message send failed: ${chrome.runtime.lastError.message}`);
          }
        });
      }
    });
  }
}

async function fetchWithRetry(url) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (!isRunning) throw new Error("Process stopped");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      log(`Fetch failed for ${url}: ${error.message}. Retry ${i + 1}/${MAX_RETRIES}`, "warning");
      if (i === MAX_RETRIES - 1) {
        log(`Max retries reached for ${url}, skipping`, "error");
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS));
    }
  }
}

function getFullPath(threadId, username, filename) {
  const sanitizedUsername = username ? username.replace(/[^a-zA-Z0-9]/g, "_") : "Anonymous";
  return `${lastSearchParams.downloadPath}/${threadId}/${sanitizedUsername}/${filename}`;
}

async function downloadImage(url, threadId, username) {
  const filename = url.split('/').pop();
  const thread = watchedThreads.find(t => t.id === threadId);
  if (!thread) {
    log(`Thread ${threadId} not found for ${url}`, "error");
    return { success: false, downloaded: false };
  }

  const fullPath = getFullPath(threadId, username, filename);
  thread.skippedImages = thread.skippedImages || new Set();
  const downloadKey = `${threadId}-${filename}`;

  if (downloadLocks.has(downloadKey)) {
    log(`Download locked for ${filename} in thread ${threadId}, waiting`, "info");
    await downloadLocks.get(downloadKey);
  }
  const lockPromise = new Promise(resolve => setTimeout(resolve, 10000));
  downloadLocks.set(downloadKey, lockPromise);

  try {
    const isAlreadyDownloaded = downloadedImages.has(fullPath);
    if (isAlreadyDownloaded) {
      if (!thread.skippedImages.has(filename)) {
        thread.skippedImages.add(filename);
        thread.downloadedCount = (thread.downloadedCount || 0) + 1;
        chrome.storage.local.set({ watchedThreads });
      }
      return { success: true, downloaded: false };
    }

    if (!thread.active) {
      log(`Download stopped for ${url}: Thread ${threadId} inactive`, "warning");
      return { success: false, downloaded: false };
    }

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const downloadId = await new Promise((resolve) => {
          chrome.downloads.download({
            url,
            filename: fullPath,
            conflictAction: 'uniquify'
          }, resolve);
        });
        if (!downloadId || !Number.isInteger(downloadId)) throw new Error("Download initiation failed or invalid ID");

        activeDownloads.set(downloadKey, downloadId);

        const result = await Promise.race([
          new Promise((resolve, reject) => {
            const listener = (delta) => {
              if (delta.id === downloadId) {
                if (delta.state && delta.state.current === "complete") {
                  chrome.downloads.onChanged.removeListener(listener);
                  resolve(true);
                } else if (delta.state && delta.state.current === "interrupted") {
                  chrome.downloads.onChanged.removeListener(listener);
                  reject(new Error("Download interrupted"));
                }
              }
            };
            chrome.downloads.onChanged.addListener(listener);
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Download timed out")), DOWNLOAD_TIMEOUT_MS))
        ]);

        downloadedImages.set(fullPath, {
          timestamp: Date.now(),
          threadId
        });
        thread.skippedImages.add(filename);
        thread.downloadedCount = (thread.downloadedCount || 0) + 1;

        if (downloadedImages.size > MAX_DOWNLOADED_IMAGES) {
          const oldest = Array.from(downloadedImages.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
          downloadedImages.delete(oldest[0]);
          log(`Removed oldest entry from downloadedImages to maintain size limit`, "info");
        }

        chrome.storage.local.set({
          downloadedImages: Array.from(downloadedImages.entries()),
          watchedThreads
        });
        activeDownloads.delete(downloadKey);
        log(`Downloaded ${filename} to ${fullPath}`, "success");
        debouncedUpdateUI();
        return { success: true, downloaded: true };
      } catch (error) {
        activeDownloads.delete(downloadKey);
        log(`Download failed for ${url}: ${error.message}. Retry ${i + 1}/${MAX_RETRIES}`, "warning");
        if (i === MAX_RETRIES - 1) {
          log(`Max retries reached for ${url}, marking as failed`, "error");
          return { success: false, downloaded: false };
        }
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS));
      }
    }
  } catch (error) {
    log(`Unexpected error in downloadImage for ${url}: ${error.message}`, "error");
    activeDownloads.delete(downloadKey);
    return { success: false, downloaded: false };
  } finally {
    downloadLocks.delete(downloadKey);
  }

  return { success: false, downloaded: false };
}

const handleDownloadCreated = debounce((downloadItem) => {
  try {
    if (!downloadItem || typeof downloadItem.filename !== 'string') {
      console.log(`[${new Date().toLocaleTimeString()}] [WARNING] Invalid downloadItem: ${JSON.stringify(downloadItem)}`);
      return;
    }

    const fullPath = downloadItem.filename.replace(/\\/g, '/');
    const filename = fullPath.split('/').pop() || 'unknown';

    if (filename.match(/ \(\d+\)\./)) {
      const pathParts = fullPath.split('/');
      const threadId = pathParts.length >= 2 ? parseInt(pathParts[pathParts.length - 2]) : null;
      const baseFilename = filename.replace(/ \(\d+\)\./, '.');

      if (threadId && !isNaN(threadId)) {
        const baseFullPath = fullPath.replace(filename, baseFilename);
        const isDownloaded = downloadedImages.has(baseFullPath);

        if (isDownloaded) {
          chrome.downloads.cancel(downloadItem.id, () => {
            if (!chrome.runtime.lastError) {
              const thread = watchedThreads.find(t => t.id === threadId);
              if (thread && !thread.skippedImages.has(baseFilename)) {
                thread.skippedImages.add(baseFilename);
                thread.downloadedCount = (thread.downloadedCount || 0) + 1;
                chrome.storage.local.set({ watchedThreads });
              }
              debouncedUpdateUI();
            }
          });
        }
      }
    }
  } catch (error) {
    console.log(`[${new Date().toLocaleTimeString()}] [ERROR] Error in onCreated listener: ${error.message}`);
  }
}, 100);

chrome.downloads.onCreated.addListener(handleDownloadCreated);

let updateQueue = [];
const debouncedUpdateUI = debounce(() => {
  if (updateQueue.length > 0) {
    updateUI();
    updateQueue = [];
  }
}, 500);

function updateUI() {
  if (windowId) {
    chrome.windows.get(windowId, {}, (win) => {
      if (chrome.runtime.lastError) {
        console.warn(`Window ${windowId} not found: ${chrome.runtime.lastError.message}`);
        windowId = null;
        return;
      }
      if (win) {
        chrome.runtime.sendMessage({
          type: "updateStatus",
          isRunning,
          watchedThreads: watchedThreads.map(thread => ({
            ...thread,
            downloadedCount: thread.downloadedCount || 0,
            totalImages: thread.totalImages || 0
          })),
          trackedDownloads: downloadedImages.size
        });
      }
    });
  }
}

async function processThread(thread) {
  const threadUrl = thread.url;
  try {
    const data = await fetchWithRetry(threadUrl);
    thread.error = false;

    const imageCount = data.posts.filter(post => post.tim && post.ext).length;
    if (imageCount > 0) {
      thread.totalImages = imageCount;
    } else if (!thread.totalImages) {
      thread.totalImages = 0;
    }

    thread.downloadedCount = thread.downloadedCount || 0;
    thread.skippedImages = thread.skippedImages || new Set();
    chrome.storage.local.set({ watchedThreads });
    debouncedUpdateUI();

    log(`Found ${thread.totalImages} images in thread: "${thread.title}" (${thread.id})`, "info");
    for (const post of data.posts) {
      if (!thread.active) {
        log(`Stopping thread "${thread.title}" (${thread.id}) processing: thread.active=${thread.active}`, "warning");
        break;
      }
      if (post.tim && post.ext) {
        const imageUrl = `https://i.4cdn.org/${thread.board}/${post.tim}${post.ext}`;
        const result = await downloadImage(imageUrl, thread.id, post.name);
        if (result.success && result.downloaded) {
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS));
        }
      }
    }
    log(`Reached the end of thread: "${thread.title}" (${thread.id})`, "info");
  } catch (error) {
    thread.error = true;
    thread.active = false;
    log(`Error processing thread "${thread.title}" (${thread.id}): ${error.message}. Thread paused.`, "error");
    chrome.storage.local.set({ watchedThreads });
    debouncedUpdateUI();
    await checkForNewThreads();
  }
}

function keepThreadsAlive() {
  setInterval(async () => {
    if (!isRunning || watchedThreads.filter(t => t.active && !t.closed && !t.error).length === 0) return;
    const activeThreads = watchedThreads.filter(t => t.active && !t.closed && !t.error);
    for (const thread of activeThreads) {
      if (!activeDownloads.has(`${thread.id}-processing`)) {
        activeDownloads.set(`${thread.id}-processing`, true);
        try {
          await processThread(thread);
        } catch (error) {
          log(`Thread ${thread.id} failed in keepThreadsAlive: ${error.message}`, "error");
        } finally {
          activeDownloads.delete(`${thread.id}-processing`);
        }
      }
    }
    if (!watchedThreads.some(t => t.active && !t.closed)) {
      isRunning = false;
      chrome.storage.local.set({ isRunning });
    }
  }, 60000);
  checkForNewThreads();
}

keepThreadsAlive();

function monitorThreadProgress() {
  setInterval(async () => {
    if (!isRunning) return;
    for (const thread of watchedThreads) {
      if (thread.active && !thread.closed && !thread.error) {
        const downloaded = thread.downloadedCount || 0;
        const total = thread.totalImages || 0;
        const key = thread.id;

        const isStuck = downloaded >= 0 && downloaded === total;

        if (isStuck) {
          if (!threadProgressTimers.has(key)) {
            threadProgressTimers.set(key, Date.now());
          } else {
            const startTime = threadProgressTimers.get(key);
            if (Date.now() - startTime >= STUCK_TIMER) {
              thread.active = false;
              log(`Thread "${thread.title}" (${thread.id}) stalled at ${downloaded}/${total}, pausing`, "info");
              chrome.storage.local.set({ watchedThreads });
              debouncedUpdateUI();

              await new Promise(resolve => setTimeout(resolve, 500));

              thread.active = true;
              log(`Thread "${thread.title}" (${thread.id}) resuming to check for new images`, "info");
              const oldTotal = thread.totalImages || 0;

              try {
                const data = await fetchWithRetry(thread.url);
                const newImageCount = data.posts.filter(post => post.tim && post.ext).length;
                thread.totalImages = newImageCount;
                log(`Thread "${thread.title}" (${thread.id}) refreshed, now ${thread.downloadedCount}/${thread.totalImages}`, "info");

                if (newImageCount > oldTotal) {
                  log(`Thread "${thread.title}" (${thread.id}) has new images (${oldTotal} -> ${newImageCount}), keeping active`, "info");
                  threadProgressTimers.delete(key);
                  await processThread(thread);
                } else {
                  log(`Thread "${thread.title}" (${thread.id}) no new images (${oldTotal} = ${newImageCount}), closing`, "info");
                  thread.closed = true;
                  thread.active = false;
                  threadProgressTimers.delete(key);
                  await checkForNewThreads();
                }
              } catch (error) {
                log(`Failed to refresh thread "${thread.title}" (${thread.id}): ${error.message}, closing`, "error");
                thread.closed = true;
                thread.active = false;
                thread.error = true;
                threadProgressTimers.delete(key);
                await checkForNewThreads();
              }

              chrome.storage.local.set({ watchedThreads });
              debouncedUpdateUI();
            }
          }
        } else if (downloaded > total && total > 0) {
          const inactiveKey = `${thread.id}-inactive`;
          if (!threadProgressTimers.has(inactiveKey)) {
            threadProgressTimers.set(inactiveKey, Date.now());
          } else {
            const startTime = threadProgressTimers.get(inactiveKey);
            if (Date.now() - startTime >= 2000) {
              thread.downloadedCount = total;
              //Disabled Log: log(`Corrected thread "${thread.title}" (${thread.id}) downloaded count to ${total}`, "info");
              chrome.storage.local.set({ watchedThreads });
              debouncedUpdateUI();
              threadProgressTimers.delete(inactiveKey);
            }
          }
        } else {
          threadProgressTimers.delete(key);
          threadProgressTimers.delete(`${thread.id}-inactive`);
        }
      }
    }
  }, 5000);
}

monitorThreadProgress();

// New function to resume active threads on startup
async function resumeActiveThreads() {
  if (!isRunning) return;
  const activeThreads = watchedThreads.filter(t => t.active && !t.closed && !t.error);
  if (activeThreads.length === 0) {
    log("No active threads to resume on startup", "info");
    return;
  }

  log(`Resuming ${activeThreads.length} active threads after restart`, "info");
  for (const thread of activeThreads) {
    try {
      await processThread(thread);
    } catch (error) {
      log(`Failed to resume thread "${thread.title}" (${thread.id}): ${error.message}`, "error");
      thread.error = true;
      thread.active = false;
    }
  }
  chrome.storage.local.set({ watchedThreads });
  debouncedUpdateUI();
}

chrome.runtime.onStartup.addListener(() => {
  log("Background script restarted after suspension", "info");
  if (isRunning) {
    resumeActiveThreads().catch(err => log(`Resume failed: ${err.message}`, "error"));
  }
  keepThreadsAlive();
  monitorThreadProgress();
  debouncedUpdateUI();
});

async function checkForNewThreads() {
  const activeThreadCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
  if (activeThreadCount < MAX_CONCURRENT_THREADS && lastSearchParams.board && lastSearchParams.searchTerm) {
    await searchAndWatchThreads(lastSearchParams.board, lastSearchParams.searchTerm);
  } else {
    log(`checkForNewThreads skipped: active=${activeThreadCount}, board=${lastSearchParams.board}, searchTerm=${lastSearchParams.searchTerm}`, "info");
  }
}

async function directoryExists(threadId) {
  const results = await new Promise(resolve => {
    chrome.downloads.search({ filenameRegex: `^${lastSearchParams.downloadPath}/${threadId}/.*` }, results => {
      resolve(results);
    });
  });
  return results.some(download => download.state === "complete");
}

async function searchAndWatchThreads(board, searchTerm) {
  if (!isRunning) {
    log(`searchAndWatchThreads skipped: isRunning is false`, "info");
    return;
  }
  const catalogUrl = `https://a.4cdn.org/${board}/catalog.json`;
  const regex = new RegExp(searchTerm, 'i');
  const sevenDaysAgo = Date.now() / 1000 - (7 * 24 * 60 * 60);
  log(`Searching catalog for board ${board} with term ${searchTerm}`, "info");

  lastSearchParams.board = board;
  lastSearchParams.searchTerm = searchTerm;
  chrome.storage.local.set({ lastSearchParams });

  try {
    const catalog = await fetchWithRetry(catalogUrl);
    let newThreads = [];
    for (const page of catalog) {
      for (const thread of page.threads) {
        if (thread.time < sevenDaysAgo) {
          continue;
        }
        const matchesSubject = thread.sub && regex.test(thread.sub);
        const matchesText = thread.com && regex.test(thread.com);
        if (matchesSubject || matchesText) {
          const threadId = thread.no;
          const folderExists = await directoryExists(threadId);
          if (folderExists) {
            continue;
          }
          const newThread = {
            url: `https://a.4cdn.org/${board}/thread/${thread.no}.json`,
            title: thread.sub || `Thread ${thread.no}`,
            board,
            id: thread.no,
            time: thread.time,
            active: true,
            downloadedCount: 0,
            totalImages: 0,
            error: false,
            closed: false,
            skippedImages: new Set()
          };
          if (!watchedThreads.some(t => t.id === newThread.id)) {
            newThreads.push(newThread);
          }
        }
      }
    }
    newThreads.sort((a, b) => b.time - a.time);

    const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
    const availableSlots = MAX_CONCURRENT_THREADS - activeCount;
    const threadsToAdd = newThreads.slice(0, availableSlots);

    if (threadsToAdd.length > 0) {
      log(`searchAndWatchThreads: Adding ${threadsToAdd.length} threads to watchedThreads`, "info");
      watchedThreads = watchedThreads.concat(threadsToAdd);
      chrome.storage.local.set({ watchedThreads });
      log(`Added ${threadsToAdd.length} new threads: ${threadsToAdd.map(t => `${t.title} (${t.id})`).join(", ")}`, "success");
      debouncedUpdateUI();
      await Promise.all(threadsToAdd.map(processThread));
    } else {
      log("No new matching threads found.", "info");
    }
  } catch (error) {
    log(`Error searching catalog: ${error.message}`, "error");
  }
}

async function addThreadById(board, threadId) {
  log(`addThreadById: Attempting to add thread ${threadId} on board ${board}`, "info");
  lastSearchParams.board = board;
  chrome.storage.local.set({ lastSearchParams });

  const folderExists = await directoryExists(threadId);
  if (threadId && folderExists) {
    log(`Thread ID ${threadId} not added (already in directory)`, "info");
    return;
  }

  const threadUrl = `https://a.4cdn.org/${board}/thread/${threadId}.json`;
  try {
    const data = await fetchWithRetry(threadUrl);
    const thread = {
      url: threadUrl,
      title: data.posts[0].sub || `Thread ${threadId}`,
      board,
      id: parseInt(threadId),
      time: data.posts[0].time,
      active: true,
      downloadedCount: 0,
      totalImages: 0,
      error: false,
      closed: false,
      skippedImages: new Set()
    };

    if (data.closed === 1 || data.archived === 1) {
      log(`Thread "${thread.title}" (${threadId}) is ${data.closed === 1 ? "closed" : "archived"} on 4chan, marking as closed`, "info");
      thread.closed = true;
      thread.active = false;
    }

    if (!watchedThreads.some(t => t.id === thread.id)) {
      const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
      if (activeCount < MAX_CONCURRENT_THREADS || thread.closed) {
        log(`addThreadById: Adding thread ${threadId} to watchedThreads${thread.closed ? " as closed" : ""}`, "info");
        watchedThreads.push(thread);
        chrome.storage.local.set({ watchedThreads });
        log(`Added thread "${thread.title}" (${threadId}) to watch list${thread.closed ? " (closed)" : ""}`, "info");
        debouncedUpdateUI();
        if (!thread.closed) {
          await processThread(thread);
        }
      } else {
        log(`Cannot add thread ${threadId}: Maximum of ${MAX_CONCURRENT_THREADS} active threads reached`, "warning");
      }
    } else {
      log(`Thread "${thread.title}" (${threadId}) already in watch list`, "warning");
    }
  } catch (error) {
    log(`Error adding thread ${threadId}: ${error.message}`, "error");
  }
}

function startScraping(board, searchTerm, threadId, tabId, downloadPath) {
  //Disabled Log: log(`startScraping: board=${board}, searchTerm=${searchTerm}, threadId=${threadId}, tabId=${tabId}, downloadPath=${downloadPath}`, "info");
  isRunning = true;
  openerTabId = tabId;
  lastSearchParams.downloadPath = downloadPath || "4chan_downloads";
  chrome.storage.local.set({ lastSearchParams, isRunning });
  const startPromise = threadId ? addThreadById(board, threadId) : searchAndWatchThreads(board, searchTerm);
  startPromise.then(() => {
    debouncedUpdateUI();
  }).catch(error => {
    log(`startScraping failed: ${error.message}`, "error");
    isRunning = watchedThreads.some(t => t.active && !t.closed);
    chrome.storage.local.set({ isRunning });
    debouncedUpdateUI();
  });
}

function stopScraping() {
  log("stopScraping: Pausing all threads", "info");
  watchedThreads.forEach(thread => {
    if (!thread.closed) {
      thread.active = false;
    }
  });
  chrome.storage.local.set({ watchedThreads });
  activeDownloads.forEach((downloadId, key) => {
    if (Number.isInteger(downloadId)) {
      chrome.downloads.cancel(downloadId, () => {
        if (chrome.runtime.lastError) {
          log(`Failed to cancel download ${downloadId}: ${chrome.runtime.lastError.message}`, "warning");
        } else {
          log(`Canceled download ${downloadId}`, "info");
        }
      });
    } else {
      log(`Invalid downloadId in activeDownloads: ${downloadId} for key ${key}`, "error");
    }
    activeDownloads.delete(key);
  });
  activeDownloads.clear();
  isRunning = watchedThreads.some(t => t.active && !t.closed);
  chrome.storage.local.set({ isRunning });
  log("All threads paused and downloads canceled.", "warning");
  debouncedUpdateUI();
}

async function resumeAllThreads() {
  let resumedCount = 0;
  const activeThreads = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;

  if (watchedThreads.some(t => !t.active && !t.error && !t.closed)) {
    isRunning = true;
    chrome.storage.local.set({ isRunning });
  }

  for (const thread of watchedThreads) {
    if (!thread.active && !thread.error && !thread.closed) {
      if (activeThreads + resumedCount < MAX_CONCURRENT_THREADS) {
        thread.active = true;
        resumedCount++;
        log(`Resuming thread "${thread.title}" (${thread.id})`, "info");
        try {
          await processThread(thread);
        } catch (error) {
          log(`Failed to resume thread "${thread.title}" (${thread.id}): ${error.message}`, "error");
          thread.active = false;
          thread.error = true;
        }
      } else {
        log(`Thread "${thread.title}" (${thread.id}) queued due to concurrency limit (${activeThreads + resumedCount}/${MAX_CONCURRENT_THREADS})`, "info");
      }
    }
  }

  if (resumedCount > 0) {
    log(`Resumed ${resumedCount} threads.`, "info");
    chrome.storage.local.set({ watchedThreads });
  } else {
    //Disabled Log: log("No paused threads to resume.", "warning");
    isRunning = watchedThreads.some(t => t.active && !t.closed);
    chrome.storage.local.set({ isRunning });
  }

  if (watchedThreads.some(t => !t.active && !t.error && !t.closed)) {
    await checkForNewThreads();
  }

  debouncedUpdateUI();
  return resumedCount > 0;
}

function toggleThread(threadId) {
  const thread = watchedThreads.find(t => t.id === threadId);
  if (!thread) {
    log(`Thread ${threadId} not found in watchedThreads`, "error");
    return;
  }

  if (thread.active) {
    thread.active = false;
    activeDownloads.forEach((downloadId, key) => {
      if (key.startsWith(`${threadId}-`)) {
        if (Number.isInteger(downloadId)) {
          chrome.downloads.cancel(downloadId, () => {
            if (chrome.runtime.lastError) {
              log(`Failed to cancel download ${downloadId} for thread ${threadId}: ${chrome.runtime.lastError.message}`, "warning");
            } else {
              log(`Canceled download ${downloadId} for thread ${threadId}`, "info");
            }
          });
        } else {
          log(`Invalid downloadId in activeDownloads: ${downloadId} for key ${key}`, "error");
        }
        activeDownloads.delete(key);
      }
    });
  } else {
    const activeCount = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;
    if (activeCount >= MAX_CONCURRENT_THREADS) {
      log(`Cannot resume thread ${threadId}: limit reached (${activeCount}/${MAX_CONCURRENT_THREADS})`, "warning");
      return;
    }
    thread.active = true;
    thread.error = false;
    //Disabled Log: log(`Thread "${thread.title}" (${threadId}) resumed`, "info");
    if (thread.closed) {
      thread.closed = false;
      log(`Thread "${thread.title}" (${threadId}) reopened`, "info");
    }
    isRunning = true;
    processThread(thread).then(() => {
      debouncedUpdateUI();
    }).catch(error => {
      log(`Failed to process thread "${thread.title}" (${threadId}): ${error.message}`, "error");
      thread.active = false;
      thread.error = true;
      chrome.storage.local.set({ watchedThreads });
      debouncedUpdateUI();
    });
  }
  chrome.storage.local.set({ watchedThreads, isRunning });
  debouncedUpdateUI();
}

function closeThread(threadId) {
  const thread = watchedThreads.find(t => t.id === threadId);
  if (thread) {
    const activeCountBefore = watchedThreads.filter(t => t.active && !t.error && !t.closed).length;

    activeDownloads.forEach((downloadId, key) => {
      if (key.startsWith(`${threadId}-`)) {
        if (Number.isInteger(downloadId)) {
          chrome.downloads.cancel(downloadId, () => {
            if (chrome.runtime.lastError) {
              log(`Failed to cancel download ${downloadId} for thread ${threadId}: ${chrome.runtime.lastError.message}`, "warning");
            }
          });
        }
        activeDownloads.delete(key);
      }
    });

    thread.closed = true;
    thread.active = false;
    log(`Thread "${thread.title}" (${threadId}) closed and removed from active quota.`, "info");
    chrome.storage.local.set({ watchedThreads });

    if (activeCountBefore === 1 && thread.active) {
      log(`Last active thread "${thread.title}" (${threadId}) closed, checking for new threads.`, "info");
      checkForNewThreads();
    }

    debouncedUpdateUI();
  } else {
    log(`Thread ${threadId} not found in watchedThreads`, "error");
  }
}

function removeThread(threadId) {
  const thread = watchedThreads.find(t => t.id === threadId);
  if (thread) {
    activeDownloads.forEach((downloadId, key) => {
      if (key.startsWith(`${threadId}-`)) {
        if (Number.isInteger(downloadId)) {
          chrome.downloads.cancel(downloadId, () => {
            if (chrome.runtime.lastError) {
              log(`Failed to cancel download ${downloadId} for thread ${threadId}: ${chrome.runtime.lastError.message}`, "warning");
            }
          });
        }
        activeDownloads.delete(key);
      }
    });
    thread.closed = true;
    watchedThreads = watchedThreads.filter(t => t.id !== threadId);
    log(`Thread "${thread.title}" (${threadId}) closed and removed. ${watchedThreads.length} threads remaining.`, "info");
    chrome.storage.local.set({ watchedThreads });
    checkForNewThreads();
    debouncedUpdateUI();
  } else {
    log(`Thread ${threadId} not found in watchedThreads`, "error");
  }
}

function forgetThreadDownloads(threadId) {
  const thread = watchedThreads.find(t => t.id === threadId);
  if (!thread) {
    log(`Thread ${threadId} not found for forgetting downloads`, "error");
    return false;
  }

  thread.skippedImages.clear();
  if (!thread.closed) {
    thread.downloadedCount = 0;
  }

  let removedCount = 0;
  for (const [path, data] of downloadedImages) {
    if (data.threadId === threadId) {
      downloadedImages.delete(path);
      removedCount++;
    }
  }

  chrome.storage.local.set({ 
    watchedThreads,
    downloadedImages: Array.from(downloadedImages.entries())
  });
  
  log(`Forgot downloads for thread "${thread.title}" (${threadId}): cleared ${removedCount} downloaded images`, "info");
  debouncedUpdateUI();
  return true;
}

function forgetDownloadedImages() {
  watchedThreads.forEach(thread => {
    thread.skippedImages.clear();
    if (!thread.closed) {
      thread.downloadedCount = 0;
    }
  });
  chrome.storage.local.set({ watchedThreads });
  log(`Cleared skipped images for all threads. Reset downloadedCount for non-closed threads only. downloadedImages size: ${downloadedImages.size}`, "info");
  debouncedUpdateUI();
}

function cleanupOldDownloads() {
  const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const [path, data] of downloadedImages) {
    if (data.timestamp < oneWeekAgo) {
      downloadedImages.delete(path);
      removed++;
    }
  }
  if (removed > 0) {
    chrome.storage.local.set({ downloadedImages: Array.from(downloadedImages.entries()) });
    log(`Cleaned up ${removed} old download entries`, "info");
  }
}
setInterval(cleanupOldDownloads, 24 * 60 * 60 * 1000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "start") {
    startScraping(message.board, message.searchTerm, message.threadId, sender.tab?.id, message.downloadPath);
    sendResponse({ success: true });
  } else if (message.type === "stop") {
    stopScraping();
    sendResponse({ success: true });
  } else if (message.type === "resumeAll") {
    resumeAllThreads().then(success => sendResponse({ success }));
  } else if (message.type === "getStatus") {
    sendResponse({ isRunning, watchedThreads });
  } else if (message.type === "toggleThread") {
    toggleThread(message.threadId);
    sendResponse({ watchedThreads });
  } else if (message.type === "closeThread") {
    closeThread(message.threadId);
    sendResponse({ watchedThreads });
  } else if (message.type === "removeThread") {
    removeThread(message.threadId);
    sendResponse({ watchedThreads });
  } else if (message.type === "setWindowId") {
    windowId = message.windowId;
    sendResponse({ success: true });
  } else if (message.type === "forgetDownloaded") {
    forgetDownloadedImages();
    sendResponse({ success: true });
  } else if (message.type === "forgetThreadDownloads") {
    const success = forgetThreadDownloads(message.threadId);
    sendResponse({ success });
  } else if (message.type === "getLastSearchParams") {
    sendResponse(lastSearchParams);
  }
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === openerTabId) {
    log(`Tab ${tabId} removed, stopping scraping`, "info");
    openerTabId = null;
  }
});

chrome.windows.onRemoved.addListener((closedWindowId) => {
  if (closedWindowId === windowId) {
    log(`Window ${closedWindowId} removed, stopping scraping`, "info");
    stopScraping();
    windowId = null;
  }
});

chrome.storage.local.get(["watchedThreads", "lastSearchParams", "downloadedImages", "isRunning"], async (result) => {
  watchedThreads = result.watchedThreads || [];
  lastSearchParams = result.lastSearchParams || { board: '', searchTerm: '', downloadPath: '4chan_downloads' };
  isRunning = result.isRunning || false;

  if (result.downloadedImages) {
    if (Array.isArray(result.downloadedImages)) {
      if (result.downloadedImages.length > 0 && Array.isArray(result.downloadedImages[0])) {
        downloadedImages = new Map(result.downloadedImages);
      } else {
        downloadedImages = new Map();
      }
    }
  }

  log(`Initializing from storage: ${watchedThreads.length} threads loaded`, "info");

  let closedCount = 0;
  for (const thread of watchedThreads) {
    if (thread.closed === undefined) {
      thread.closed = false;
    }
    if (thread.skippedImages === undefined || thread.skippedImages === null) {
      thread.skippedImages = new Set();
    } else if (Array.isArray(thread.skippedImages)) {
      thread.skippedImages = new Set(thread.skippedImages);
    } else if (thread.skippedImages instanceof Set) {
      // Already a Set, no conversion needed
    } else if (typeof thread.skippedImages === 'object' && thread.skippedImages !== null) {
      thread.skippedImages = new Set(Object.values(thread.skippedImages));
    } else {
      thread.skippedImages = new Set();
    }

    log(`Loaded thread ${thread.id} (${thread.title}) from storage, active=${thread.active}, closed=${thread.closed}`, "info");
    if (thread.closed) {
      closedCount++;
    }
  }

  chrome.storage.local.set({ watchedThreads });
  log(`Startup: Setting watchedThreads with ${watchedThreads.length} threads`, "info");
  log(`Startup complete, watchedThreads: ${JSON.stringify(watchedThreads.map(t => ({ id: t.id, title: t.title, closed: t.closed, active: t.active })))}`, "info");

  if (isRunning) {
    log("Resuming active threads after restart", "info");
    await resumeActiveThreads();
  }

  debouncedUpdateUI();
});