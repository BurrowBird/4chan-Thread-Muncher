document.addEventListener("DOMContentLoaded", () => {
  // Input Elements
  const searchTermInput = document.getElementById("searchTerm");
  const threadIdInput = document.getElementById("threadId");
  const boardInput = document.getElementById("board");
  const downloadPathInput = document.getElementById("downloadPath");
  const banUsernameInput = document.getElementById("banUsernameInput");

  // Button Elements
  const clearBanListBtn = document.getElementById("clearBanListBtn");
  const startBtn = document.getElementById("startBtn");
  const pauseAllBtn = document.getElementById("pauseAllBtn");
  const resumeAllBtn = document.getElementById("resumeAllBtn");
  const modeToggleBtn = document.getElementById("modeToggle");
  const forgetAllBtn = document.getElementById("forgetAllBtn");
  const syncCountsBtn = document.getElementById("syncCountsBtn");
  const addBanBtn = document.getElementById("addBanBtn");

  // Display Elements
  const logDiv = document.getElementById("log");
  const threadCountSpan = document.getElementById("thread-count");
  const threadsDiv = document.getElementById("threads");
  const countdownSpan = document.getElementById("countdown-timer");
  const bannedUsersList = document.getElementById("banned-users-list");
  const banManagementDiv = document.getElementById("ban-management");
  const banToggle = document.getElementById("ban-toggle");

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
  applyDarkMode();

  // Get and set window ID for background script communication
  chrome.windows.getCurrent((window) => {
    if (window && window.id) {
        currentWindowId = window.id;
        chrome.runtime.sendMessage({ type: "setWindowId", windowId: window.id }, () => {
            if (chrome.runtime.lastError) {
                console.error("Failed to set window ID:", chrome.runtime.lastError.message);
            } else {
                requestStatusUpdate();
            }
        });
    } else {
        console.error("Could not get current window ID.");
    }
  });

  // Add event listener for Clear List button
  clearBanListBtn.addEventListener("click", () => {
    if (confirm("Are you sure you want to clear the entire banned usernames list?")) {
        clearBanListBtn.disabled = true;
        chrome.runtime.sendMessage({ type: "clearBannedUsernames" }, (response) => {
            if (response?.success) {
                appendLog("Banned usernames list cleared.", "success");
            } else {
                appendLog("Failed to clear banned usernames list.", "error");
            }
            requestStatusUpdate();
            clearBanListBtn.disabled = false;
        });
    }
  });

  // Apply Ban Section Collapsed State on Load
  let isBanSectionCollapsed = localStorage.getItem("banSectionCollapsed") === "true";
  function applyBanSectionState() {
      if (isBanSectionCollapsed) {
          banManagementDiv.classList.add("collapsed");
      } else {
          banManagementDiv.classList.remove("collapsed");
      }
  }
  applyBanSectionState();

  // Fetch last used parameters from storage
  chrome.runtime.sendMessage({ type: "getLastSearchParams" }, (params) => {
    if (params) {
      boardInput.value = params.board || '';
      searchTermInput.value = params.searchTerm || '';
      downloadPathInput.value = params.downloadPath || '4chan_downloads';
    }
  });

  // Render banned usernames with clickable removal
  function renderBannedUsernames(usernames) {
      if (!bannedUsersList) return;

      bannedUsersList.innerHTML = ''; // Clear current list

      if (!usernames || usernames.length === 0) {
          return; // CSS handles empty state via :empty::before
      }

      const sortedUsernames = [...usernames].sort((a, b) => a.localeCompare(b));
      const fragment = document.createDocumentFragment();

      sortedUsernames.forEach(username => {
          const span = document.createElement('span');
          span.className = 'banned-user-item';
          span.textContent = username;
          span.title = 'Click to remove'; // Tooltip for clarity
          span.addEventListener('click', () => {
              span.style.opacity = '0.5'; // Visual feedback during removal
              chrome.runtime.sendMessage({ type: "removeBannedUsername", username: username }, (response) => {
                  if (response?.success) {
                      //appendLog(`Removed ban for "${username}"`, "success");
                  } else {
                      appendLog(`Failed to remove ban for "${username}"`, "error");
                      span.style.opacity = '1'; // Restore on failure
                  }
                  requestStatusUpdate(); // Refresh the list
              });
          });
          fragment.appendChild(span);
      });

      bannedUsersList.appendChild(fragment);
  }

  // --- Logging ---
  function appendLog(message, type = "info") {
      if (!logDiv) return;

      const p = document.createElement("p");
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
      chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
          if (chrome.runtime.lastError) {
              appendLog("Failed to get status from background. It might be restarting.", "error");
              setButtonsDisabled(true);
          } else if (status) {
              updateUI(status);
              setButtonsDisabled(false);
          } else {
              appendLog("Received empty status from background.", "warning");
              setButtonsDisabled(true);
          }
      });
  }

  function updateTimer(nextRefreshTimestamp, activeCount, maxCount) {
      if (refreshInterval) clearInterval(refreshInterval);

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
              if (refreshInterval) clearInterval(refreshInterval);
          }
      }

      updateCountdown();
      refreshInterval = setInterval(updateCountdown, 1000);
  }

  function formatDate(timestamp) {
      if (!timestamp) return "N/A";
      try {
          const date = new Date(timestamp * 1000);
          return date.toLocaleString(undefined, {
              year: '2-digit', month: 'numeric', day: 'numeric',
              hour: 'numeric', minute: '2-digit'
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
      const sortedThreads = threads.sort((a, b) => {
          const activeA = a.active && !a.closed && !a.error;
          const activeB = b.active && !b.closed && !b.error;
          if (activeA !== activeB) {
              return activeA ? -1 : 1;
          }
          return (b.time || 0) - (a.time || 0);
      });

      const fragment = document.createDocumentFragment();
      let firstInactiveRendered = false;

      sortedThreads.forEach(thread => {
          const isActive = thread.active && !thread.closed && !thread.error;
          if (!isActive && !firstInactiveRendered && fragment.hasChildNodes()) {
              const separator = document.createElement("hr");
              separator.className = "thread-separator";
              fragment.appendChild(separator);
              firstInactiveRendered = true;
          }
          const threadDiv = renderThread(thread);
          fragment.appendChild(threadDiv);
      });

      threadsDiv.innerHTML = '';
      threadsDiv.appendChild(fragment);
  }

  function renderThread(thread) {
      const threadId = thread.id;
      const isClosed = thread.closed;
      const isActive = thread.active && !isClosed && !thread.error;
      const isPaused = !thread.active && !isClosed && !thread.error;
      const isError = thread.error;

      let countClass = 'thread-count-paused';
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
          toggleButtonText = "Resume";
      }

      const div = document.createElement("div");
      div.className = "thread";
      div.dataset.threadId = threadId;

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

      attachButtonListeners(div, thread);
      return div;
  }

  function attachButtonListeners(div, thread) {
      const toggleBtn = div.querySelector(".toggleBtn");
      const closeBtn = div.querySelector(".closeBtn");
      const removeBtn = div.querySelector(".removeBtn");
      const forgetBtn = div.querySelector(".forgetBtn");

      toggleBtn?.addEventListener("click", () => {
          toggleBtn.disabled = true;
          chrome.runtime.sendMessage({ type: "toggleThread", threadId: thread.id }, () => {
              requestStatusUpdate();
          });
      });

      closeBtn?.addEventListener("click", () => {
          if (closeBtn.disabled) return;
          closeBtn.disabled = true;
          chrome.runtime.sendMessage({ type: "closeThread", threadId: thread.id }, () => {
              requestStatusUpdate();
          });
      });

      removeBtn?.addEventListener("click", () => {
          removeBtn.disabled = true;
          chrome.runtime.sendMessage({ type: "removeThread", threadId: thread.id }, () => {
              requestStatusUpdate();
          });
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
                  requestStatusUpdate();
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
      addBanBtn.disabled = disabled;
      threadsDiv.querySelectorAll('.thread-buttons button').forEach(btn => btn.disabled = disabled);
      bannedUsersList.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
  }

  function updateUI(status) {
      if (!status || !status.watchedThreads) {
          console.warn("updateUI called with invalid status object:", status);
          renderThreads([]);
          renderBannedUsernames([]);
          threadCountSpan.textContent = `Status Unavailable`;
          countdownSpan.textContent = `Next: ---`;
          setButtonsDisabled(true);
          return;
      }

      setButtonsDisabled(false);

      const activeThreads = status.watchedThreads.filter(t => t.active && !t.closed && !t.error);
      const pausedThreads = status.watchedThreads.filter(t => !t.active && !t.closed && !t.error);

      startBtn.textContent = "Add/Search Threads";
      pauseAllBtn.disabled = activeThreads.length === 0;
      resumeAllBtn.disabled = pausedThreads.length === 0;

      const activeCount = activeThreads.length;
      const maxCount = 5;
      updateTimer(status.nextManageThreads, activeCount, maxCount);

      renderThreads(status.watchedThreads);
      renderBannedUsernames(status.bannedUsernames || []);
  }

  // --- Event Listeners ---

  setInterval(requestStatusUpdate, 5000);

  window.addEventListener('focus', () => {
      requestStatusUpdate();
  });

  startBtn.addEventListener("click", () => {
      const searchTerm = searchTermInput.value.trim();
      const threadId = threadIdInput.value.trim();
      const board = boardInput.value.trim();
      const downloadPath = downloadPathInput.value.trim() || "4chan_downloads";

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
      if (!/^[a-z0-9]+$/i.test(board)) {
          appendLog("Invalid board format (should be alphanumeric, e.g., 'wg', 'g', 'pol').", "error");
          boardInput.focus();
          return;
      }
      if (threadId && !/^\d+$/.test(threadId)) {
          appendLog("Invalid Thread ID format (should be numeric).", "error");
          threadIdInput.focus();
          return;
      }

      startBtn.disabled = true;
      startBtn.textContent = "Starting...";
      chrome.runtime.sendMessage({ type: "start", searchTerm, threadId, board, downloadPath }, (response) => {
          if (response?.success) {
          } else {
              appendLog(`Start request failed: ${response?.error || 'Unknown error'}`, "error");
          }
          requestStatusUpdate();
      });
  });

  pauseAllBtn.addEventListener("click", () => {
      pauseAllBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "stop" }, () => {
          requestStatusUpdate();
      });
  });

  resumeAllBtn.addEventListener("click", () => {
      resumeAllBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "resumeAll" }, (response) => {
          if (response?.success) {
          } else {
          }
          requestStatusUpdate();
      });
  });

  modeToggleBtn.addEventListener("click", () => {
      darkMode = !darkMode;
      localStorage.setItem("darkMode", darkMode);
      applyDarkMode();
  });

  forgetAllBtn.addEventListener("click", () => {
      if (confirm("WARNING:\nThis will erase ALL tracked download history from this extension's storage and reset download counts for ALL threads.\n\nThis CANNOT be undone.\n\nAre you sure?")) {
          if (confirm("SECOND WARNING:\nReally erase ALL download history?")) {
              appendLog("Sending Forget All History request...", "warning");
              forgetAllBtn.disabled = true;
              chrome.runtime.sendMessage({ type: "forgetAllDownloads" }, () => {
                  requestStatusUpdate();
              });
          }
      }
  });

  syncCountsBtn.addEventListener("click", () => {
      syncCountsBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "syncThreadCounts" }, () => {
          requestStatusUpdate();
      });
  });

  addBanBtn.addEventListener("click", () => {
      const usernameToBan = banUsernameInput.value.trim();
      if (!usernameToBan) {
          appendLog("Please enter a username to ban.", "warning");
          banUsernameInput.focus();
          return;
      }
      addBanBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "addBannedUsername", username: usernameToBan }, (response) => {
          if (response?.success) {
              banUsernameInput.value = '';
          } else {
              appendLog(`Failed to add ban for "${usernameToBan}". Maybe already banned?`, "warning");
          }
          requestStatusUpdate();
          addBanBtn.disabled = false;
      });
  });

  banUsernameInput.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') {
          addBanBtn.click();
      }
  });

  banToggle.addEventListener("click", () => {
      isBanSectionCollapsed = !isBanSectionCollapsed;
      localStorage.setItem("banSectionCollapsed", isBanSectionCollapsed);
      applyBanSectionState();
  });

  // --- Background Message Handling ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "log") {
          if (!sender.tab) {
              appendLog(message.message, message.logType || "info");
          }
          sendResponse({ success: true });
      } else if (message.type === "updateStatus") {
          updateUI(message);
          sendResponse({ success: true });
      } else {
          sendResponse({ success: false, error: "Unhandled message type" });
      }
      return false;
  });
});