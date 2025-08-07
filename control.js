document.addEventListener("DOMContentLoaded", () => {
  // Input Elements
  const searchTermInput = document.getElementById("searchTerm");
  const threadIdInput = document.getElementById("threadId");
  const boardInput = document.getElementById("board");
  const downloadPathInput = document.getElementById("downloadPath");
  const banUsernameInput = document.getElementById("banUsernameInput");
  const maxThreadsInput = document.getElementById("maxThreadsInput"); // --- NEW

  // Button Elements
  const addWatchJobBtn = document.getElementById("addWatchJobBtn");
  const addThreadByIdBtn = document.getElementById("addThreadByIdBtn");
  const clearBanListBtn = document.getElementById("clearBanListBtn");
  const pauseAllBtn = document.getElementById("pauseAllBtn");
  const resumeAllBtn = document.getElementById("resumeAllBtn");
  const modeToggleBtn = document.getElementById("modeToggle");
  const forgetAllBtn = document.getElementById("forgetAllBtn");
  const syncCountsBtn = document.getElementById("syncCountsBtn");
  const addBanBtn = document.getElementById("addBanBtn");

  // Display Elements
  const watchJobsContainer = document.getElementById("watch-jobs-container");
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

  // --- History Dropdown Feature ---
  const BOARD_HISTORY_KEY = 'boardInputHistory';
  const SEARCH_TERM_HISTORY_KEY = 'searchTermInputHistory';
  const MAX_HISTORY_SIZE = 20;

  const boardHistoryDropdown = document.getElementById('boardHistoryDropdown');
  const searchTermHistoryDropdown = document.getElementById('searchTermHistoryDropdown');
  const boardContainer = boardInput.parentElement;
  const searchTermContainer = searchTermInput.parentElement;

  const deleteHistoryItem = (storageKey, value) => {
    chrome.storage.local.get([storageKey], (result) => {
      const history = result[storageKey] || [];
      const newHistory = history.filter(item => item !== value);
      chrome.storage.local.set({ [storageKey]: newHistory });
    });
  };

  const renderHistoryItems = (input, dropdown, storageKey, history) => {
    dropdown.innerHTML = '';
    if (!history || history.length === 0) {
      const emptyItem = document.createElement('div');
      emptyItem.className = 'history-item';
      emptyItem.style.cssText = 'justify-content: center; cursor: default; opacity: 0.7;';
      emptyItem.textContent = 'No history';
      dropdown.appendChild(emptyItem);
      return;
    }

    history.forEach(itemText => {
      const item = document.createElement('div');
      item.className = 'history-item';

      const text = document.createElement('span');
      text.className = 'history-item-text';
      text.textContent = itemText;
      text.title = itemText;
      item.appendChild(text);

      const del = document.createElement('span');
      del.className = 'history-item-delete';
      del.innerHTML = '&times;';
      del.title = 'Remove from history';
      item.appendChild(del);

      item.addEventListener('click', () => {
        input.value = itemText;
        dropdown.style.display = 'none';
      });

      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteHistoryItem(storageKey, itemText);
      });

      dropdown.appendChild(item);
    });
  };

  const setupHistoryDropdown = (input, dropdown, container, storageKey) => {
    const arrow = container.querySelector('.history-arrow');

    chrome.storage.local.get([storageKey], (result) => {
      renderHistoryItems(input, dropdown, storageKey, result[storageKey] || []);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[storageKey]) {
        renderHistoryItems(input, dropdown, storageKey, changes[storageKey].newValue || []);
      }
    });

    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = dropdown.style.display === 'block';
      document.querySelectorAll('.history-dropdown').forEach(d => d.style.display = 'none');
      if (!isVisible) {
        dropdown.style.display = 'block';
      }
    });
  };

  setupHistoryDropdown(boardInput, boardHistoryDropdown, boardContainer, BOARD_HISTORY_KEY);
  setupHistoryDropdown(searchTermInput, searchTermHistoryDropdown, searchTermContainer, SEARCH_TERM_HISTORY_KEY);

  document.addEventListener('click', () => {
    document.querySelectorAll('.history-dropdown').forEach(d => {
      d.style.display = 'none';
    });
  });
  // --- End of History Dropdown Feature ---


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

  // Fetch saved download path from storage
  chrome.runtime.sendMessage({ type: "getSavedPath" }, (response) => {
    if (response && response.downloadPath) {
      downloadPathInput.value = response.downloadPath;
    } else {
      downloadPathInput.value = '4chan_downloads';
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

  // --- NEW: Render Watch Jobs ---
  function renderWatchJobs(jobs) {
      watchJobsContainer.innerHTML = ''; // Clear previous list
      if (!jobs || jobs.length === 0) {
          // CSS :empty pseudo-class will show the message
          return;
      }

      const fragment = document.createDocumentFragment();
      jobs.forEach(job => {
          const jobDiv = document.createElement('div');
          jobDiv.className = 'watch-job-item';
          jobDiv.dataset.jobId = job.id;

          const jobText = document.createElement('span');
          jobText.className = 'watch-job-text';
          jobText.textContent = `Watching: /${job.board}/ for "${job.searchTerm}"`;
          jobDiv.appendChild(jobText);

          const removeBtn = document.createElement('span');
          removeBtn.className = 'watch-job-remove';
          removeBtn.innerHTML = '&times;';
          removeBtn.title = 'Remove this watch job';
          removeBtn.addEventListener('click', () => {
              chrome.runtime.sendMessage({ type: "removeWatchJob", id: job.id }, requestStatusUpdate);
          });
          jobDiv.appendChild(removeBtn);
          fragment.appendChild(jobDiv);
      });
      watchJobsContainer.appendChild(fragment);
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
      addWatchJobBtn.disabled = disabled;
      addThreadByIdBtn.disabled = disabled;
      pauseAllBtn.disabled = disabled;
      resumeAllBtn.disabled = disabled;
      forgetAllBtn.disabled = disabled;
      syncCountsBtn.disabled = disabled;
      addBanBtn.disabled = disabled;
      maxThreadsInput.disabled = disabled; // --- NEW
      threadsDiv.querySelectorAll('.thread-buttons button').forEach(btn => btn.disabled = disabled);
      bannedUsersList.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
  }

  function updateUI(status) {
      if (!status || !status.watchedThreads) {
          console.warn("updateUI called with invalid status object:", status);
          renderThreads([]);
          renderWatchJobs([]);
          renderBannedUsernames([]);
          threadCountSpan.textContent = `Status Unavailable`;
          countdownSpan.textContent = `Next: ---`;
          setButtonsDisabled(true);
          return;
      }

      setButtonsDisabled(false);

      const activeThreads = status.watchedThreads.filter(t => t.active && !t.closed && !t.error);
      const pausedThreads = status.watchedThreads.filter(t => !t.active && !t.closed && !t.error);

      pauseAllBtn.disabled = activeThreads.length === 0;
      resumeAllBtn.disabled = pausedThreads.length === 0;

      const activeCount = activeThreads.length;
      // --- MODIFIED: Use maxConcurrentThreads from status for the display ---
      const maxCount = status.maxConcurrentThreads || 5; 
      updateTimer(status.nextManageThreads, activeCount, maxCount);
      
      // --- NEW: Update the max threads input field ---
      maxThreadsInput.value = maxCount;

      renderThreads(status.watchedThreads);
      renderWatchJobs(status.watchJobs || []);
      renderBannedUsernames(status.bannedUsernames || []);
  }

  // --- Event Listeners ---

  setInterval(requestStatusUpdate, 5000);

  window.addEventListener('focus', () => {
      requestStatusUpdate();
  });

  addWatchJobBtn.addEventListener("click", () => {
      const searchTerm = searchTermInput.value.trim();
      const board = boardInput.value.trim();

      if (!board) {
          appendLog("Board input is required.", "error");
          boardInput.focus();
          return;
      }
      if (!searchTerm) {
          appendLog("Search Term is required to add a watch job.", "error");
          searchTermInput.focus();
          return;
      }

      // --- Save to History ---
      const saveToHistory = (storageKey, value) => {
          if (!value || !value.trim()) return;
          const trimmedValue = value.trim();

          chrome.storage.local.get([storageKey], (result) => {
              let history = result[storageKey] || [];
              history = history.filter(item => item !== trimmedValue); // Remove if exists
              history.unshift(trimmedValue); // Add to front
              history = history.slice(0, MAX_HISTORY_SIZE); // Enforce size limit
              chrome.storage.local.set({ [storageKey]: history });
          });
      };
      
      saveToHistory(BOARD_HISTORY_KEY, board);
      if (searchTerm) {
          saveToHistory(SEARCH_TERM_HISTORY_KEY, searchTerm);
      }
      // --- End Save to History ---

      addWatchJobBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "addWatchJob", board, searchTerm }, (response) => {
          if (response?.success) {
              appendLog(`Watch job for /${board}/ - "${searchTerm}" added.`, "success");
              //searchTermInput.value = ''; // Clear input on success
          } else {
              appendLog(`Failed to add watch job. It may already exist or regex is invalid.`, "error");
          }
          addWatchJobBtn.disabled = false;
          requestStatusUpdate();
      });
  });

  addThreadByIdBtn.addEventListener("click", () => {
      const threadId = threadIdInput.value.trim();
      const board = boardInput.value.trim();
      if (!board || !threadId) {
          appendLog("Board and Thread ID are required.", "error");
          return;
      }
      addThreadByIdBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "start", board, threadId }, (response) => {
          if(response?.success) {
            threadIdInput.value = ''; // Clear on success
          }
          addThreadByIdBtn.disabled = false;
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
  
  // --- NEW: Event listener for the max threads input ---
  maxThreadsInput.addEventListener("change", () => {
      const newValue = parseInt(maxThreadsInput.value, 10);
      if (!isNaN(newValue) && newValue >= 1 && newValue <= 20) {
          maxThreadsInput.disabled = true; // Disable while sending
          chrome.runtime.sendMessage({ type: "updateMaxThreads", value: newValue }, (response) => {
              if (response?.success) {
                  appendLog(`Set max concurrent threads to ${newValue}.`, "success");
              } else {
                  appendLog(`Failed to set max threads: ${response?.error || 'Unknown error'}.`, "error");
              }
              // Refresh the entire status to ensure UI is consistent
              requestStatusUpdate(); 
          });
      } else {
          appendLog("Invalid max threads value. Must be a number between 1 and 20.", "error");
          // Re-fetch status to reset the input to its last valid value
          requestStatusUpdate(); 
      }
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

  // --- NEW: Update download path on change ---
  downloadPathInput.addEventListener("change", () => {
    const newPath = downloadPathInput.value.trim();
    chrome.runtime.sendMessage({ type: "updateDownloadPath", path: newPath });
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