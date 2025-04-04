document.addEventListener("DOMContentLoaded", () => {
  // Input Elements
  const searchTermInput = document.getElementById("searchTerm");
  const threadIdInput = document.getElementById("threadId");
  const boardInput = document.getElementById("board");
  const downloadPathInput = document.getElementById("downloadPath");

  // Button Elements
  const startBtn = document.getElementById("startBtn");
  const pauseAllBtn = document.getElementById("pauseAllBtn");
  const resumeAllBtn = document.getElementById("resumeAllBtn");
  const modeToggleBtn = document.getElementById("modeToggle");
  const forgetAllBtn = document.getElementById("forgetAllBtn"); // Get the new button
  const syncCountsBtn = document.getElementById("syncCountsBtn"); // Get sync button

  // Display Elements
  const logDiv = document.getElementById("log");
  const threadCountSpan = document.getElementById("thread-count");
  const threadsDiv = document.getElementById("threads");
  const countdownSpan = document.getElementById("countdown-timer");

  // State Variables
  let refreshInterval = null;
  let darkMode = localStorage.getItem("darkMode") === null ? true : localStorage.getItem("darkMode") === "true";
  let currentWindowId = null;

  // --- Initialization ---

  // Apply Dark Mode on Load
  function applyDarkMode() {
      if (darkMode) {
          document.body.classList.add("dark-mode");
          modeToggleBtn.textContent = "Light Mode";
      } else {
          document.body.classList.remove("dark-mode");
          modeToggleBtn.textContent = "Dark Mode";
      }
  }
  applyDarkMode(); // Apply on initial load

  // Get and set window ID for background script communication
  chrome.windows.getCurrent((window) => {
    if (window && window.id) {
        currentWindowId = window.id;
        chrome.runtime.sendMessage({ type: "setWindowId", windowId: window.id }, () => {
            if (chrome.runtime.lastError) {
                console.error("Failed to set window ID:", chrome.runtime.lastError.message);
            } else {
                 // Request initial status after setting ID
                requestStatusUpdate();
            }
        });
    } else {
        console.error("Could not get current window ID.");
    }
  });

  // Fetch last used parameters from storage
  chrome.runtime.sendMessage({ type: "getLastSearchParams" }, (params) => {
    if (params) {
      boardInput.value = params.board || '';
      searchTermInput.value = params.searchTerm || '';
      downloadPathInput.value = params.downloadPath || '4chan_downloads';
    }
  });

  // --- Logging ---
function appendLog(message, type = "info") {
    if (!logDiv) return;

    const p = document.createElement("p");
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Use the raw 'message' received directly
    p.textContent = `${timestamp} - ${message}`;
    p.className = `log-entry ${type}`;

    logDiv.insertBefore(p, logDiv.firstChild);

    const isNearTop = logDiv.scrollTop <= 50;
    if (isNearTop) {
      logDiv.scrollTop = 0;
    }

    const maxLogEntries = 200;
    if (logDiv.children.length > maxLogEntries) {
      logDiv.removeChild(logDiv.lastChild);
    }
}

  // --- UI Updates ---

  function requestStatusUpdate() {
       // console.log("Requesting status update...");
      chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
          if (chrome.runtime.lastError) {
              // console.warn("Error requesting status:", chrome.runtime.lastError.message);
              // Handle potential disconnect (e.g., background script crashed)
              appendLog("Failed to get status from background. It might be restarting.", "error");
              // Optionally disable buttons here
              setButtonsDisabled(true); // Disable all major action buttons
          } else if (status) {
              // console.log("Status received:", status);
              updateUI(status);
              setButtonsDisabled(false); // Re-enable buttons on successful status get
          } else {
              appendLog("Received empty status from background.", "warning");
              setButtonsDisabled(true);
          }
      });
  }


  function updateTimer(nextRefreshTimestamp, activeCount, maxCount) {
    if (refreshInterval) clearInterval(refreshInterval);

    // Update active thread count display
    threadCountSpan.textContent = `${activeCount} / ${maxCount} Active`;

    if (!nextRefreshTimestamp) {
      countdownSpan.textContent = "Next Update: ---";
      return;
    }

    function updateCountdown() {
        const now = Date.now();
        const timeLeftMs = nextRefreshTimestamp - now;

        if (timeLeftMs > 0) {
            const seconds = Math.max(0, Math.floor(timeLeftMs / 1000));
            countdownSpan.textContent = `Next Update: ${seconds}s`;
        } else {
            countdownSpan.textContent = "Next Update: Now";
            // Avoid negative counts, clear interval once expired
             if (refreshInterval) clearInterval(refreshInterval);
        }
    }

    updateCountdown(); // Initial call
    refreshInterval = setInterval(updateCountdown, 1000); // Update every second
  }

  function formatDate(timestamp) {
    if (!timestamp) return "N/A";
    try {
        const date = new Date(timestamp * 1000);
        // Use a simpler, locale-aware format
        return date.toLocaleString(undefined, { // Use browser's default locale
            year: '2-digit', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: '2-digit' // Removed seconds for brevity
        });
    } catch (e) {
        console.error("Error formatting date:", e);
        return "Invalid Date";
    }
  }

  function renderThreads(threads) {
    if (!threads) {
        threadsDiv.innerHTML = '<div>No threads to display.</div>';
        return;
    }
    // Sort threads: Active first (by time desc), then Inactive (by time desc)
    const sortedThreads = threads.sort((a, b) => {
        // Primary sort: active status (active first)
        const activeA = a.active && !a.closed && !a.error;
        const activeB = b.active && !b.closed && !b.error;
        if (activeA !== activeB) {
            return activeA ? -1 : 1;
        }
        // Secondary sort: time (newest first)
        return (b.time || 0) - (a.time || 0);
    });

    // Use a DocumentFragment for efficiency
    const fragment = document.createDocumentFragment();
    let firstInactiveRendered = false;

    sortedThreads.forEach(thread => {
        const isActive = thread.active && !thread.closed && !thread.error;
        // Add separator before the first inactive thread if active ones exist
        if (!isActive && !firstInactiveRendered && fragment.hasChildNodes()) {
             const separator = document.createElement("hr");
             separator.className = "thread-separator";
             fragment.appendChild(separator);
             firstInactiveRendered = true;
        }
        const threadDiv = renderThread(thread);
        fragment.appendChild(threadDiv);
    });

    // Clear existing threads and append the new fragment
    threadsDiv.innerHTML = '';
    threadsDiv.appendChild(fragment);
  }

  function renderThread(thread) {
    const threadId = thread.id;
    const isClosed = thread.closed;
    const isActive = thread.active && !isClosed && !thread.error;
    const isPaused = !thread.active && !isClosed && !thread.error;
    const isError = thread.error;

    // Determine status classes
    let countClass = 'thread-count-paused'; // Default to paused/inactive style
    let titleClass = 'thread-title-paused';
    let toggleButtonText = "Resume";

    if (isActive) {
        countClass = 'thread-count-active';
        titleClass = 'thread-title-active';
        toggleButtonText = "Pause";
    } else if (isError) {
        countClass = 'thread-count-error';
        titleClass = 'thread-title-error';
        toggleButtonText = "Retry";
    } else if (isClosed) {
        countClass = 'thread-count-closed';
        titleClass = 'thread-title-closed';
        toggleButtonText = "Resume"; // Can still try to resume if manually closed? Or disable? Let's allow resume.
    } // isPaused uses default "Resume" text


    const div = document.createElement("div");
    div.className = "thread";
    div.dataset.threadId = threadId; // Store ID for easier access

    div.innerHTML = `
      <div class="thread-details">
        <span class="thread-count ${countClass}">(${thread.downloadedCount || 0} / ${thread.totalImages || '?'})</span>
        <span class="thread-title ${titleClass}">${thread.title} (${thread.id})</span>
        <span class="thread-creation">Created: ${formatDate(thread.time)}</span>
      </div>
      <div class="thread-buttons">
        <button class="toggleBtn">${toggleButtonText}</button>
        <button class="closeBtn" ${isClosed ? 'disabled' : ''}>Close</button>
        <button class="forgetBtn">Forget History</button>
        <button class="removeBtn danger-button">Remove</button>
      </div>
    `;

    // Attach listeners directly after creating the element
    attachButtonListeners(div, thread);

    return div;
  }

  function attachButtonListeners(div, thread) {
    const toggleBtn = div.querySelector(".toggleBtn");
    const closeBtn = div.querySelector(".closeBtn");
    const removeBtn = div.querySelector(".removeBtn");
    const forgetBtn = div.querySelector(".forgetBtn");

    toggleBtn?.addEventListener("click", () => {
      toggleBtn.disabled = true; // Prevent double clicks
      chrome.runtime.sendMessage({ type: "toggleThread", threadId: thread.id }, () => {
           requestStatusUpdate(); // Refresh UI after action
           // toggleBtn.disabled = false; // Re-enable after update usually handles this
      });
    });

    closeBtn?.addEventListener("click", () => {
       if(closeBtn.disabled) return;
       closeBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "closeThread", threadId: thread.id }, () => {
           requestStatusUpdate();
      });
    });

    removeBtn?.addEventListener("click", () => {
             removeBtn.disabled = true;
            chrome.runtime.sendMessage({ type: "removeThread", threadId: thread.id }, () => {
                requestStatusUpdate();
        })
    });

    forgetBtn?.addEventListener("click", () => {
       if (confirm(`Forget download history for thread "${thread.title}" (${thread.id})? This will reset its downloaded count and allow re-downloading.`)) {
            forgetBtn.disabled = true;
           chrome.runtime.sendMessage({ type: "forgetThreadDownloads", threadId: thread.id }, (response) => {
               if (response.success) {
                   appendLog(`Forgot downloads for thread ${thread.id}`, "info");
               } else {
                   appendLog(`Failed to forget downloads for thread ${thread.id}`, "error");
               }
               requestStatusUpdate(); // Refresh UI
               // forgetBtn.disabled = false; // Re-enable after update
           });
       }
    });
  }

  function setButtonsDisabled(disabled) {
        startBtn.disabled = disabled;
        pauseAllBtn.disabled = disabled;
        resumeAllBtn.disabled = disabled;
        forgetAllBtn.disabled = disabled;
        syncCountsBtn.disabled = disabled;
        // Also disable individual thread buttons if background is disconnected?
        threadsDiv.querySelectorAll('.thread-buttons button').forEach(btn => btn.disabled = disabled);
  }


  function updateUI(status) {
    if (!status || !status.watchedThreads) {
        console.warn("updateUI called with invalid status object:", status);
        renderThreads([]); // Render empty state
        threadCountSpan.textContent = `Status Unavailable`;
        countdownSpan.textContent = `Next: ---`;
        setButtonsDisabled(true); // Disable buttons if status is bad
        return;
    }
    // console.log("Updating UI with status:", status);

    // Enable general buttons initially, then disable based on state
    setButtonsDisabled(false);

    const activeThreads = status.watchedThreads.filter(t => t.active && !t.closed && !t.error);
    const pausedThreads = status.watchedThreads.filter(t => !t.active && !t.closed && !t.error);

    startBtn.textContent = "Add/Search Threads"; // Reset button text
    pauseAllBtn.disabled = activeThreads.length === 0; // Disable if no active threads
    resumeAllBtn.disabled = pausedThreads.length === 0; // Disable if no resumable threads

    const activeCount = activeThreads.length;
    const maxCount = 5; // MAX_CONCURRENT_THREADS from background
    updateTimer(status.nextManageThreads, activeCount, maxCount);

    renderThreads(status.watchedThreads);
  }

  // --- Event Listeners ---

  // Regular status polling
  setInterval(requestStatusUpdate, 5000); // Poll every 5 seconds

  // Update status on window focus
  window.addEventListener('focus', () => {
      //appendLog("Window focused, requesting status update.", "debug");
      requestStatusUpdate();
      // Optional: Trigger resume on focus? Background does this now.
      // chrome.runtime.sendMessage({ type: "resumeAll" });
  });

  // Start Button
  startBtn.addEventListener("click", () => {
    const searchTerm = searchTermInput.value.trim();
    const threadId = threadIdInput.value.trim();
    const board = boardInput.value.trim();
    const downloadPath = downloadPathInput.value.trim() || "4chan_downloads"; // Default path

    if (!board) {
        appendLog("Board input is required.", "error");
        boardInput.focus();
        return;
    }
     if (!searchTerm && !threadId) {
        appendLog("Either Search Term or Thread ID is required.", "error");
        searchTermInput.focus();
        return;
    }
     // Basic board validation (alphanumeric) - Adjust as needed for 4chan board names
     if (!/^[a-z0-9]+$/i.test(board)) {
        appendLog("Invalid board format (should be alphanumeric, e.g., 'wg', 'g', 'pol').", "error");
        boardInput.focus();
        return;
     }
      // Basic thread ID validation (numeric)
      if (threadId && !/^\d+$/.test(threadId)) {
        appendLog("Invalid Thread ID format (should be numeric).", "error");
        threadIdInput.focus();
        return;
      }


    //appendLog(`Sending start request: Board=${board}, Term=${searchTerm || 'N/A'}, ID=${threadId || 'N/A'}`, "info");
    startBtn.disabled = true; // Disable during request
    startBtn.textContent = "Starting...";
    chrome.runtime.sendMessage({ type: "start", searchTerm, threadId, board, downloadPath }, (response) => {
        if (response?.success) {
             //appendLog("Start request sent successfully.", "success");
             // Clear inputs after successful start? Optional.
             // searchTermInput.value = '';
             // threadIdInput.value = '';
        } else {
             appendLog(`Start request failed: ${response?.error || 'Unknown error'}`, "error");
        }
        requestStatusUpdate(); // Refresh UI regardless of success
        // Button text/state will be updated by updateUI
    });
  });

  // Pause All Button
  pauseAllBtn.addEventListener("click", () => {
     pauseAllBtn.disabled = true;
     appendLog("Sending pause all request...", "info");
    chrome.runtime.sendMessage({ type: "stop" }, () => {
         requestStatusUpdate();
    });
  });

  // Resume All Button
  resumeAllBtn.addEventListener("click", () => {
      resumeAllBtn.disabled = true;
      //appendLog("Sending resume all request...", "info");
    chrome.runtime.sendMessage({ type: "resumeAll" }, (response) => {
        if (response?.success) {
           // appendLog("Resume request sent, threads activating.", "info"); // Background logs success/details
        } else {
            //appendLog("Resume request potentially failed or no threads to resume.", "warning");
        }
        requestStatusUpdate();
    });
  });

  // Dark Mode Toggle
  modeToggleBtn.addEventListener("click", () => {
    darkMode = !darkMode;
    localStorage.setItem("darkMode", darkMode); // Save preference
    applyDarkMode(); // Apply change
    //appendLog(`Switched to ${darkMode ? 'dark' : 'light'} mode`, "info");
  });

  // Forget All Button
  forgetAllBtn.addEventListener("click", () => {
    if (confirm("WARNING:\nThis will erase ALL tracked download history from this extension's storage and reset download counts for ALL threads.\n\nThis CANNOT be undone.\n\nAre you sure?")) {
      if (confirm("SECOND WARNING:\nReally erase ALL download history?")) {
        appendLog("Sending Forget All History request...", "warning");
        forgetAllBtn.disabled = true;
        chrome.runtime.sendMessage({ type: "forgetAllDownloads" }, () => {
          appendLog("Forget All History request sent.", "success");
          requestStatusUpdate(); // Refresh status immediately
        });
      } else {
        //appendLog("Forget all action cancelled.", "info");
      }
    } else {
      //appendLog("Forget all action cancelled.", "info");
    }
  });

   // Sync Counts Button
   syncCountsBtn.addEventListener("click", () => {
       syncCountsBtn.disabled = true;
       //appendLog("Sending manual sync request...", "info");
       chrome.runtime.sendMessage({ type: "syncThreadCounts" }, () => {
           //appendLog("Manual sync request sent.", "info");
           requestStatusUpdate(); // Refresh UI after sync attempt
       });
   });


  // --- Background Message Handling ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // console.log("Message received in control script:", message);
    if (message.type === "log") {
      // Check if the log originated from the background script (no sender.tab)
      if (!sender.tab) {
         appendLog(message.message, message.logType || "info");
      }
      sendResponse({ success: true }); // Acknowledge log message
    } else if (message.type === "updateStatus") {
      // Make sure the update is for this window before processing
      // (Background sends to all potential control windows, only the correct one should update its UI)
      // No direct check needed if background uses windowId target, but good practice.
      // if (windowId && message.windowId === windowId) { // Requires background to send windowId
          updateUI(message);
      // }
      sendResponse({ success: true });
    } else {
        // console.log("Unhandled message type in control:", message.type);
        // Send default response for unhandled types?
        sendResponse({ success: false, error: "Unhandled message type" });
    }
    // Return true only if sendResponse might be called asynchronously (currently not needed here)
    return false;
  });

  // Initial status request when DOM is ready (after setting window ID)
  // Moved initial request to after setWindowId callback for reliability

}); // End DOMContentLoaded