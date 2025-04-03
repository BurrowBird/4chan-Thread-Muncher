document.addEventListener("DOMContentLoaded", () => {
  const searchTermInput = document.getElementById("searchTerm");
  const threadIdInput = document.getElementById("threadId");
  const boardInput = document.getElementById("board");
  const downloadPathInput = document.getElementById("downloadPath");
  const startBtn = document.getElementById("startBtn");
  const pauseAllBtn = document.getElementById("pauseAllBtn");
  const resumeAllBtn = document.getElementById("resumeAllBtn");
  const modeToggleBtn = document.getElementById("modeToggle");
  const logDiv = document.getElementById("log");
  const timerDiv = document.getElementById("timer");
  const threadCountSpan = document.getElementById("thread-count");
  const threadsDiv = document.getElementById("threads");

  let refreshInterval = null;
  let darkMode = localStorage.getItem("darkMode") === null ? true : localStorage.getItem("darkMode") === "true";

  if (darkMode) {
    document.body.classList.add("dark-mode");
    modeToggleBtn.textContent = "Light Mode";
  } else {
    document.body.classList.remove("dark-mode");
    modeToggleBtn.textContent = "Dark Mode";
  }

  localStorage.setItem("darkMode", darkMode);

  chrome.windows.getCurrent((window) => {
    chrome.runtime.sendMessage({ type: "setWindowId", windowId: window.id });
  });
  
  function appendLog(message, type) {
    const p = document.createElement("p");
    p.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
    p.className = `log-entry ${type}`;
    logDiv.insertBefore(p, logDiv.firstChild);
    logDiv.scrollTop = 0;
  }

  function updateTimer(nextRefresh, activeCount, maxCount) {
    if (refreshInterval) clearInterval(refreshInterval);

    threadCountSpan.textContent = `${activeCount} of ${maxCount} Active Threads`;

    if (!nextRefresh) {
      timerDiv.querySelector("span:first-child").textContent = "Next refresh: Not running";
      return;
    }

    refreshInterval = setInterval(() => {
      const timeLeft = nextRefresh - Date.now();
      if (timeLeft > 0) {
        const minutes = Math.floor(timeLeft / 60000);
        const seconds = Math.floor((timeLeft % 60000) / 1000);
        timerDiv.querySelector("span:first-child").textContent = `Next refresh: ${minutes}m ${seconds}s`;
      } else {
        timerDiv.querySelector("span:first-child").textContent = "Next refresh: Updating...";
      }
    }, 1000);
  }

  function formatDate(timestamp) {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }

  function renderThreads(threads) {
    const sortedThreads = threads.sort((a, b) => b.time - a.time);
    const activeThreads = sortedThreads.filter(t => t.active && !t.closed);
    const inactiveThreads = sortedThreads.filter(t => !t.active || t.closed);

    const existingThreads = new Map(
      Array.from(threadsDiv.children)
        .filter(div => div.classList.contains("thread"))
        .map(div => [parseInt(div.querySelector(".thread-details span:nth-child(2)").textContent.match(/\d+/)[0]), div])
    );

    threadsDiv.innerHTML = '';

    activeThreads.forEach(thread => {
      renderThread(thread, existingThreads);
    });

    if (activeThreads.length > 0 && inactiveThreads.length > 0) {
      const separator = document.createElement("hr");
      separator.className = "thread-separator";
      threadsDiv.appendChild(separator);
    }

    inactiveThreads.forEach(thread => {
      renderThread(thread, existingThreads);
    });

    existingThreads.forEach((div, id) => {
      if (!sortedThreads.some(t => t.id === id)) div.remove();
    });
  }

  function renderThread(thread, existingThreads) {
    const threadId = thread.id;
    const existingDiv = existingThreads.get(threadId);
    const isClosed = thread.closed;

    if (existingDiv) {
      const countSpan = existingDiv.querySelector(".thread-count-active, .thread-count-paused, .thread-count-error, .thread-count-closed");
      countSpan.textContent = `(${thread.downloadedCount || 0} of ${thread.totalImages || 0})`;
      countSpan.className = thread.active ? "thread-count-active" : thread.error ? "thread-count-error" : isClosed ? "thread-count-closed" : "thread-count-paused";
      const statusSpan = existingDiv.querySelector(".thread-details span:nth-child(2)");
      statusSpan.textContent = `${thread.title} (${thread.id})`;
      statusSpan.className = isClosed ? "thread-closed" : thread.error ? "error" : thread.active ? "info" : "warning";
      const toggleBtn = existingDiv.querySelector(".toggleBtn");
      toggleBtn.textContent = thread.active ? "Pause" : thread.error ? "Retry" : "Resume";
      const closeBtn = existingDiv.querySelector(".closeBtn");
      closeBtn.disabled = isClosed;
      const statusElement = existingDiv.querySelector(".thread-status");
      if (isClosed && !statusElement) {
        const newStatus = document.createElement("span");
        newStatus.className = "thread-status";
        newStatus.textContent = "Closed";
        existingDiv.querySelector(".thread-details").appendChild(newStatus);
      } else if (!isClosed && statusElement) {
        statusElement.remove();
      }
      threadsDiv.appendChild(existingDiv);
    } else {
      const div = document.createElement("div");
      div.className = "thread";
      div.innerHTML = `
        <div class="thread-details">
          <span class="${thread.active ? 'thread-count-active' : thread.error ? 'thread-count-error' : isClosed ? 'thread-count-closed' : 'thread-count-paused'}">(${thread.downloadedCount || 0} of ${thread.totalImages || 0})</span>
          <span class="${isClosed ? 'thread-closed' : thread.error ? 'error' : thread.active ? 'info' : 'warning'}">${thread.title} (${thread.id})</span>
          <span class="thread-creation">${formatDate(thread.time)}</span>
          ${isClosed ? '<span class="thread-status">Closed</span>' : ''}
        </div>
        <div class="thread-buttons">
          <button class="toggleBtn">${thread.active ? "Pause" : thread.error ? "Retry" : "Resume"}</button>
          <button class="closeBtn" ${isClosed ? 'disabled' : ''}>Close</button>
          <button class="removeBtn">Remove</button>
          <button class="forgetBtn">Forget</button>
        </div>
      `;
      attachButtonListeners(div, thread);
      threadsDiv.appendChild(div);
    }
  }

  function attachButtonListeners(div, thread) {
    const toggleBtn = div.querySelector(".toggleBtn");
    const closeBtn = div.querySelector(".closeBtn");
    const removeBtn = div.querySelector(".removeBtn");
    const forgetBtn = div.querySelector(".forgetBtn");

    toggleBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "toggleThread", threadId: thread.id });
      chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
        if (status) updateUI(status);
      });
    });

    closeBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "closeThread", threadId: thread.id });
      chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
        if (status) updateUI(status);
      });
    });

    removeBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "removeThread", threadId: thread.id });
      chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
        if (status) updateUI(status);
      });
    });

    forgetBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "forgetThreadDownloads", threadId: thread.id }, (response) => {
        if (response.success) {
          appendLog(`Forgot downloads for thread "${thread.title}" (${thread.id})`, "info");
        }
      });
      chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
        if (status) updateUI(status);
      });
    });
  }

  function updateUI(status) {
    startBtn.textContent = "Add Threads";
    const hasActiveThreads = status.watchedThreads.some(t => t.active);
    pauseAllBtn.disabled = !hasActiveThreads;

    const hasPausedThreads = status.watchedThreads.some(t => !t.active && !t.error && !t.closed);
    resumeAllBtn.disabled = !hasPausedThreads;

    const activeCount = status.watchedThreads.filter(t => t.active && !t.closed).length;
    const maxCount = 5;
    threadCountSpan.textContent = `${activeCount} of ${maxCount} Active Threads`;

    renderThreads(status.watchedThreads);
  }

  setInterval(() => {
    chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
      if (status) updateUI(status);
    });
  }, 5000);

  window.addEventListener('focus', () => {
    chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
      if (status) {
        updateUI(status);
        if (status.isRunning) {
          chrome.runtime.sendMessage({ type: "resumeAll" }, (response) => {
            if (response.success) {
              appendLog("Window refocused, resumed and synced all active threads", "info");
              // Force a recount and sync
              chrome.runtime.sendMessage({ type: "syncThreadCounts" });
            }
          });
        }
      }
    });
  });

  chrome.runtime.sendMessage({ type: "getLastSearchParams" }, (params) => {
    if (params) {
      boardInput.value = params.board || '';
      searchTermInput.value = params.searchTerm || '';
      downloadPathInput.value = params.downloadPath || '4chan_downloads';
    }
  });

  chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
    if (status) updateUI(status);
  });

  startBtn.addEventListener("click", async () => {
    const searchTerm = searchTermInput.value.trim();
    const threadId = threadIdInput.value.trim();
    const board = boardInput.value.trim();
    const downloadPath = downloadPathInput.value.trim() || "4chan_downloads";
    if (board && (searchTerm || threadId)) {
      await chrome.runtime.sendMessage({ type: "start", searchTerm, threadId, board, downloadPath });
      chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
        if (status) updateUI(status);
      });
    } else {
      appendLog("Please enter a board and either a search term or thread ID.", "error");
    }
  });

  pauseAllBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "stop" });
    chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
      if (status) updateUI(status);
    });
  });

  resumeAllBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "resumeAll" }, (response) => {
      if (response.success) {
        appendLog("Resumed all paused threads.", "info");
      }
    });
    chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
      if (status) updateUI(status);
    });
  });

  modeToggleBtn.addEventListener("click", () => {
    darkMode = !darkMode;
    localStorage.setItem("darkMode", darkMode);

    if (darkMode) {
      document.body.classList.add("dark-mode");
      modeToggleBtn.textContent = "Light Mode";
      appendLog("Switched to dark mode", "info");
    } else {
      document.body.classList.remove("dark-mode");
      modeToggleBtn.textContent = "Dark Mode";
      appendLog("Switched to light mode", "info");
    }
  });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "log") {
    appendLog(message.message, message.logType);
    sendResponse({ success: true });
  } else if (message.type === "updateStatus") {
    updateUI(message);
    sendResponse({ success: true });
  }
  return true; // Indicates that sendResponse will be called asynchronously
});
});