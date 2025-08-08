document.addEventListener("DOMContentLoaded", () => {
  // Input Elements
  const searchTermInput = document.getElementById("searchTerm");
  const threadIdInput = document.getElementById("threadId");
  const boardInput = document.getElementById("board");
  const downloadPathInput = document.getElementById("downloadPath");
  const banUsernameInput = document.getElementById("banUsernameInput");
  const maxThreadsInput = document.getElementById("maxThreadsInput");

  // Button Elements
  const addWatchJobBtn = document.getElementById("addWatchJobBtn");
  const addThreadByIdBtn = document.getElementById("addThreadByIdBtn");
  const clearBanListBtn = document.getElementById("clearBanListBtn");
  const pauseAllBtn = document.getElementById("pauseAllBtn");
  const resumeAllBtn = document.getElementById("resumeAllBtn");
  const checkAllBtn = document.getElementById("checkAllBtn");
  const modeToggleBtn = document.getElementById("modeToggle");
  const forgetAllBtn = document.getElementById("forgetAllBtn");
  const removeAllBtn = document.getElementById("removeAllBtn");
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
  const threadElements = new Map(); // Cache for DOM elements: <threadId, element>
  let separatorElement = null; // Cache the separator element

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

/**
   * Adds a new value to a specified history list in chrome.storage.
   * @param {string} storageKey The key for the history array in storage.
   * @param {string} value The value to add to the history.
   */
  const addToHistory = (storageKey, value) => {
    const trimmedValue = value.trim();
    if (!trimmedValue) return; // Do not save empty values

    chrome.storage.local.get([storageKey], (result) => {
      let history = result[storageKey] || [];
      // Remove the value if it already exists to move it to the top
      history = history.filter(item => item !== trimmedValue);
      // Add the new value to the beginning of the array
      history.unshift(trimmedValue);
      // Trim the history to the maximum allowed size
      if (history.length > MAX_HISTORY_SIZE) {
        history = history.slice(0, MAX_HISTORY_SIZE);
      }
      // Save the updated history back to storage
      chrome.storage.local.set({ [storageKey]: history });
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

  chrome.windows.getCurrent((window) => {
    if (window && window.id) {
        currentWindowId = window.id;
        // Send the window ID and wait for the callback before requesting status
        chrome.runtime.sendMessage({ type: "setWindowId", windowId: window.id }, () => {
            if (chrome.runtime.lastError) {
                console.error("Failed to set window ID:", chrome.runtime.lastError.message);
                appendLog("Failed to connect to the background script. Please try reloading.", "error");
            } else {
                // Now that the background script has confirmed our ID, request the initial status.
                requestStatusUpdate();
            }
        });
    } else {
        console.error("Could not get current window ID.");
        appendLog("Could not identify this window. Some features may not work.", "error");
    }
  });

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

  let isBanSectionCollapsed = localStorage.getItem("banSectionCollapsed") === "true";
  function applyBanSectionState() {
      if (isBanSectionCollapsed) {
          banManagementDiv.classList.add("collapsed");
      } else {
          banManagementDiv.classList.remove("collapsed");
      }
  }
  applyBanSectionState();

  chrome.runtime.sendMessage({ type: "getSavedPath" }, (response) => {
    if (response && response.downloadPath) {
      downloadPathInput.value = response.downloadPath;
    } else {
      downloadPathInput.value = '4chan_downloads';
    }
  });

  function renderBannedUsernames(usernames) {
      if (!bannedUsersList) return;
      bannedUsersList.innerHTML = '';
      if (!usernames || usernames.length === 0) {
          return;
      }
      const sortedUsernames = [...usernames].sort((a, b) => a.localeCompare(b));
      const fragment = document.createDocumentFragment();
      sortedUsernames.forEach(username => {
          const span = document.createElement('span');
          span.className = 'banned-user-item';
          span.textContent = username;
          span.title = 'Click to remove';
          span.addEventListener('click', () => {
              span.style.opacity = '0.5';
              chrome.runtime.sendMessage({ type: "removeBannedUsername", username: username }, (response) => {
                  if (!response?.success) {
                      appendLog(`Failed to remove ban for "${username}"`, "error");
                      span.style.opacity = '1';
                  }
                  requestStatusUpdate();
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
      if (logDiv.scrollTop <= 50) {
          logDiv.scrollTop = 0;
      }
      if (logDiv.children.length > 200) {
          logDiv.removeChild(logDiv.lastChild);
      }
  }

  // --- UI Update Logic ---

  /** Globally enables or disables all major buttons and inputs. */
  function setButtonsDisabled(disabled) {
      const elements = [
          addWatchJobBtn, addThreadByIdBtn, pauseAllBtn, resumeAllBtn,
          checkAllBtn, forgetAllBtn, removeAllBtn, syncCountsBtn, addBanBtn,
          clearBanListBtn, maxThreadsInput
      ];
      elements.forEach(el => {
          if (el) el.disabled = disabled;
      });
      threadsDiv.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
  }

  function renderWatchJobs(jobs) {
      watchJobsContainer.innerHTML = '';
      if (!jobs || jobs.length === 0) return;
      const fragment = document.createDocumentFragment();
      jobs.forEach(job => {
          const jobDiv = document.createElement('div');
          jobDiv.className = 'watch-job-item';
          jobDiv.dataset.jobId = job.id;
          jobDiv.innerHTML = `<span class="watch-job-text">Watching: /${job.board}/ for "${job.searchTerm}"</span>`;
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

  function requestStatusUpdate() {
      chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
          if (chrome.runtime.lastError) {
              appendLog("Failed to get status from background. It might be restarting.", "error");
              setButtonsDisabled(true);
              return;
          }
          if (status) {
              updateUI(status);
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
          return new Date(timestamp * 1000).toLocaleString(undefined, {
              year: '2-digit', month: 'numeric', day: 'numeric',
              hour: 'numeric', minute: '2-digit'
          });
      } catch (e) { return "Invalid Date"; }
  }

  function getThreadSortPriority(thread) {
      if (thread.active && !thread.closed && !thread.error) return 0; // Active
      if (!thread.active && !thread.closed && !thread.error) return 1; // Paused
      if (thread.error) return 2; // Error
      if (thread.closed) return 3; // Closed
      return 4; // Failsafe
  }

  /** Renders a new thread element. Used only for creation. */
  function renderThread(thread) {
      const div = document.createElement("div");
      div.className = "thread";
      div.dataset.threadId = thread.id;
      div.innerHTML = `
        <div class="thread-details">
          <span class="thread-count"></span>
          <span class="thread-title"></span>
          <span class="thread-creation"></span>
        </div>
        <div class="thread-buttons">
          <button class="toggleBtn"></button>
          <button class="closeBtn"></button>
          <button class="forgetBtn">Forget History</button>
          <button class="removeBtn danger-button">Remove</button>
        </div>`;
      updateThreadElement(div, thread); // Populate with initial data
      return div;
  }

  /** Updates an existing thread element in-place without rebuilding it. */
  function updateThreadElement(element, thread) {
      const isClosed = thread.closed;
      const isActive = thread.active && !isClosed && !thread.error;
      const isError = thread.error;

      let countClass = 'thread-count-paused', titleClass = 'thread-title-paused', toggleBtnText = "Resume";

      if (isActive) {
          countClass = 'thread-count-active'; titleClass = 'thread-title-active'; toggleBtnText = "Pause";
      } else if (isError) {
          countClass = 'thread-count-error'; titleClass = 'thread-title-error'; toggleBtnText = "Retry";
      } else if (isClosed) {
          countClass = 'thread-count-closed'; titleClass = 'thread-title-closed'; toggleBtnText = "Resume";
      }

      const countSpan = element.querySelector(".thread-count");
      const titleSpan = element.querySelector(".thread-title");
      const creationSpan = element.querySelector(".thread-creation");
      const toggleBtn = element.querySelector(".toggleBtn");
      const closeBtn = element.querySelector(".closeBtn");

      const newCountText = `(${thread.downloadedCount || 0} / ${thread.totalImages || '?'})`;
      if (countSpan.textContent !== newCountText) countSpan.textContent = newCountText;
      if (!countSpan.classList.contains(countClass)) countSpan.className = `thread-count ${countClass}`;
      
      const newTitleText = `${thread.title} (${thread.id})`;
      if (titleSpan.textContent !== newTitleText) titleSpan.textContent = newTitleText;
      if (!titleSpan.classList.contains(titleClass)) titleSpan.className = `thread-title ${titleClass}`;

      const newCreationText = `Created: ${formatDate(thread.time)}`;
      if (creationSpan.textContent !== newCreationText) creationSpan.textContent = newCreationText;
      
      if (toggleBtn.textContent !== toggleBtnText) toggleBtn.textContent = toggleBtnText;
      toggleBtn.disabled = isClosed;
      
      const newCloseBtnText = isClosed ? "Re-open" : "Close";
      if (closeBtn.textContent !== newCloseBtnText) closeBtn.textContent = newCloseBtnText;
  }

  /** Intelligently updates the list of threads in the DOM. */
  function updateThreadsList(threads) {
      if (!threads) {
          threadsDiv.innerHTML = '';
          threadElements.clear();
          return;
      }
      const sortedThreads = threads.sort((a, b) => {
          const pA = getThreadSortPriority(a), pB = getThreadSortPriority(b);
          return pA !== pB ? pA - pB : (b.time || 0) - (a.time || 0);
      });
      const desiredIds = new Set(sortedThreads.map(t => t.id));

      for (const [id, element] of threadElements.entries()) {
          if (!desiredIds.has(id)) {
              element.remove();
              threadElements.delete(id);
          }
      }
      
      sortedThreads.forEach(thread => {
          if (threadElements.has(thread.id)) {
              updateThreadElement(threadElements.get(thread.id), thread);
          } else {
              const newElement = renderThread(thread);
              attachButtonListeners(newElement, thread);
              threadElements.set(thread.id, newElement);
          }
      });
      
      let hasActive = false, hasInactive = false;
      sortedThreads.forEach(thread => {
          getThreadSortPriority(thread) === 0 ? hasActive = true : hasInactive = true;
          threadsDiv.appendChild(threadElements.get(thread.id));
      });
      
      if (hasActive && hasInactive) {
          if (!separatorElement || !separatorElement.parentElement) {
              separatorElement = document.createElement("hr");
              separatorElement.className = "thread-separator";
          }
          const firstInactive = threadElements.get(sortedThreads.find(t => getThreadSortPriority(t) > 0).id);
          threadsDiv.insertBefore(separatorElement, firstInactive);
      } else if (separatorElement) {
          separatorElement.remove();
          separatorElement = null;
      }
  }

  function attachButtonListeners(div, thread) {
      const toggleBtn = div.querySelector(".toggleBtn");
      const closeBtn = div.querySelector(".closeBtn");
      const removeBtn = div.querySelector(".removeBtn");
      const forgetBtn = div.querySelector(".forgetBtn");

      toggleBtn?.addEventListener("click", () => {
          toggleBtn.disabled = true;
          if (toggleBtn.textContent === "Pause") {
              updateThreadElement(div, { ...thread, active: false });
          }
          chrome.runtime.sendMessage({ type: "toggleThread", threadId: thread.id });
      });

      closeBtn?.addEventListener("click", () => {
          if (closeBtn.disabled) return;
          closeBtn.disabled = true;
          if (closeBtn.textContent === "Close") {
              updateThreadElement(div, { ...thread, closed: true, active: false });
          }
          chrome.runtime.sendMessage({ type: "closeThread", threadId: thread.id });
      });

      removeBtn?.addEventListener("click", () => {
          removeBtn.disabled = true;
          div.style.transition = 'opacity 0.3s ease';
          div.style.opacity = '0';
          setTimeout(() => div.remove(), 300);
          threadElements.delete(thread.id);
          chrome.runtime.sendMessage({ type: "removeThread", threadId: thread.id });
      });

      forgetBtn?.addEventListener("click", () => {
          if (confirm(`Forget download history for thread "${thread.title}" (${thread.id})? This will reset its downloaded count and allow re-downloading.`)) {
              forgetBtn.disabled = true;
              const countSpan = div.querySelector('.thread-count');
              const oldText = countSpan.textContent;
              countSpan.textContent = oldText.replace(/\(\d+/, '(0');
              chrome.runtime.sendMessage({ type: "forgetThreadDownloads", threadId: thread.id }, (response) => {
                  if (!response.success) countSpan.textContent = oldText; // Revert on failure
              });
          }
      });
  }

  function updateUI(status) {
      if (!status) {
          setButtonsDisabled(true);
          return;
      }
      setButtonsDisabled(false);
      const activeThreads = status.watchedThreads.filter(t => t.active && !t.closed && !t.error);
      const pausedThreads = status.watchedThreads.filter(t => !t.active && !t.closed && !t.error);
      pauseAllBtn.disabled = activeThreads.length === 0;
      resumeAllBtn.disabled = pausedThreads.length === 0;
      updateTimer(status.nextManageThreads, activeThreads.length, status.maxConcurrentThreads || 5);
      maxThreadsInput.value = status.maxConcurrentThreads || 5;
      updateThreadsList(status.watchedThreads);
      renderWatchJobs(status.watchJobs || []);
      renderBannedUsernames(status.bannedUsernames || []);
  }

  // --- Event Listeners ---
  window.addEventListener('focus', requestStatusUpdate);

  // Other listeners (addWatchJobBtn, etc.) remain the same
	addWatchJobBtn.addEventListener("click", () => {
      const searchTerm = searchTermInput.value.trim();
      const board = boardInput.value.trim();
      if (!board || !searchTerm) {
          appendLog("Board and Search Term are required.", "error");
          return;
      }
	  addToHistory(BOARD_HISTORY_KEY, board);
      addToHistory(SEARCH_TERM_HISTORY_KEY, searchTerm);
	  addWatchJobBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "addWatchJob", board, searchTerm }, (response) => {
          if (!response?.success) {
              appendLog(`Failed to add watch job.`, "error");
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
      addToHistory(BOARD_HISTORY_KEY, board);
      addThreadByIdBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "start", board, threadId }, (response) => {
          if (response?.success) threadIdInput.value = '';
          addThreadByIdBtn.disabled = false;
          requestStatusUpdate();
      });
  });

  pauseAllBtn.addEventListener("click", () => {
      pauseAllBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "stop" }, () => requestStatusUpdate());
  });

  resumeAllBtn.addEventListener("click", () => {
      resumeAllBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "resumeAll" }, () => requestStatusUpdate());
  });
  
  checkAllBtn.addEventListener("click", () => {
      appendLog("Manually checking all watch jobs...", "info");
      checkAllBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "checkAllWatchJobs" }, () => {
          checkAllBtn.disabled = false;
          requestStatusUpdate();
      });
  });

  modeToggleBtn.addEventListener("click", () => {
      darkMode = !darkMode;
      localStorage.setItem("darkMode", darkMode);
      applyDarkMode();
  });

  forgetAllBtn.addEventListener("click", () => {
      if (confirm("WARNING:\nReally erase ALL download history?")) {
          forgetAllBtn.disabled = true;
          chrome.runtime.sendMessage({ type: "forgetAllDownloads" }, () => requestStatusUpdate());
      }
  });

  removeAllBtn.addEventListener("click", () => {
      if (confirm("WARNING:\nReally remove ALL threads?")) {
          removeAllBtn.disabled = true;
          chrome.runtime.sendMessage({ type: "removeAllThreads" }, () => requestStatusUpdate());
      }
  });

  syncCountsBtn.addEventListener("click", () => {
      syncCountsBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "syncThreadCounts" }, () => requestStatusUpdate());
  });

  addBanBtn.addEventListener("click", () => {
      const usernameToBan = banUsernameInput.value.trim();
      if (!usernameToBan) return;
      addBanBtn.disabled = true;
      chrome.runtime.sendMessage({ type: "addBannedUsername", username: usernameToBan }, (response) => {
          if (response?.success) banUsernameInput.value = '';
          else appendLog(`Failed to add ban for "${usernameToBan}".`, "warning");
          requestStatusUpdate();
          addBanBtn.disabled = false;
      });
  });
  
  maxThreadsInput.addEventListener("change", () => {
      const newValue = parseInt(maxThreadsInput.value, 10);
      if (newValue >= 1 && newValue <= 20) {
          chrome.runtime.sendMessage({ type: "updateMaxThreads", value: newValue });
      } else {
          appendLog("Invalid max threads value (must be 1-20).", "error");
          requestStatusUpdate(); 
      }
  });

  banUsernameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addBanBtn.click(); });
  banToggle.addEventListener("click", () => {
      isBanSectionCollapsed = !isBanSectionCollapsed;
      localStorage.setItem("banSectionCollapsed", isBanSectionCollapsed);
      applyBanSectionState();
  });
  downloadPathInput.addEventListener("change", () => {
    chrome.runtime.sendMessage({ type: "updateDownloadPath", path: downloadPathInput.value.trim() });
  });

  // --- Background Message Handling ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "log") {
          if (!sender.tab) appendLog(message.message, message.logType || "info");
      } else if (message.type === "updateStatus") {
          updateUI(message);
      }
      sendResponse(true);
      return true;
  });
});