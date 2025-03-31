document.addEventListener("DOMContentLoaded", () => {
  const searchTermInput = document.getElementById("searchTerm");
  const threadIdInput = document.getElementById("threadId");
  const boardInput = document.getElementById("board");
  const downloadPathInput = document.getElementById("downloadPath");
  const startBtn = document.getElementById("startBtn");
  const pauseAllBtn = document.getElementById("pauseAllBtn");
  const resumeAllBtn = document.getElementById("resumeAllBtn");
  const forgetBtn = document.getElementById("forgetBtn");
  const modeToggleBtn = document.getElementById("modeToggle");
  const logDiv = document.getElementById("log");
  const timerDiv = document.getElementById("timer");
  const threadCountSpan = document.getElementById("thread-count");
  const threadsDiv = document.getElementById("threads");

  let refreshInterval = null;
  let darkMode = localStorage.getItem("darkMode") === "true";

  if (darkMode) {
    document.body.classList.add("dark-mode");
    modeToggleBtn.textContent = "Light Mode";
  }

  chrome.windows.getCurrent((window) => {
    chrome.runtime.sendMessage({ type: "setWindowId", windowId: window.id });
  });

  // Call forgetDownloadedImages on startup
  chrome.runtime.sendMessage({ type: "forgetDownloaded" }, (response) => {
    if (response.success) {
      appendLog("Forgot all downloaded images on startup.", "info");
    } else {
      appendLog("Failed to forget downloaded images on startup.", "error");
    }
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
    threadsDiv.innerHTML = "";

    const activeThreads = threads.filter(t => !t.closed);
    const closedThreads = threads.filter(t => t.closed);

    activeThreads.forEach(thread => {
      const div = document.createElement("div");
      div.className = "thread";
      const count = thread.downloadedCount || 0;
      const total = thread.totalImages || 0;

      let countClass = thread.active ? "thread-count-active" : thread.error ? "thread-count-error" : "thread-count-paused";
      let threadStatusClass = thread.error ? "error" : thread.active ? "info" : "warning";

      div.innerHTML = `
        <div class="thread-details">
          <span class="${countClass}">(${count} of ${total})</span>
          <span class="${threadStatusClass}">${thread.title} (${thread.id})</span>
          <span class="thread-creation">${formatDate(thread.time)}</span>
        </div>
        <div class="thread-buttons">
          <button class="toggleBtn">${thread.active ? "Pause" : thread.error ? "Retry" : "Resume"}</button>
          <button class="closeBtn" ${thread.closed ? 'disabled' : ''}>Close</button>
          <button class="removeBtn">Remove</button>
        </div>
      `;

      const toggleBtn = div.querySelector(".toggleBtn");
      const closeBtn = div.querySelector(".closeBtn");
      const removeBtn = div.querySelector(".removeBtn");

      toggleBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "toggleThread", threadId: thread.id }, () => {
          // Force immediate status update after toggle
          chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
            if (status) updateUI(status);
          });
        });
      });
      closeBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "closeThread", threadId: thread.id });
      });
      removeBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "removeThread", threadId: thread.id });
      });

      threadsDiv.appendChild(div);
    });

    if (activeThreads.length > 0 && closedThreads.length > 0) {
      threadsDiv.appendChild(document.createElement("hr"));
    }

    closedThreads.forEach(thread => {
      const div = document.createElement("div");
      div.className = "thread";
      const count = thread.downloadedCount || 0;
      const total = thread.totalImages || 0;

      div.innerHTML = `
        <div class="thread-details">
          <span class="thread-count-closed">(${count} of ${total})</span>
          <span class="thread-closed">${thread.title} (${thread.id})</span>
          <span class="thread-creation">${formatDate(thread.time)}</span>
          <span class="thread-status">Closed</span>
        </div>
        <div class="thread-buttons">
          <button class="toggleBtn">Resume</button>
          <button class="closeBtn" disabled>Close</button>
          <button class="removeBtn">Remove</button>
        </div>
      `;

      const toggleBtn = div.querySelector(".toggleBtn");
      const removeBtn = div.querySelector(".removeBtn");

      toggleBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "toggleThread", threadId: thread.id }, () => {
          chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
            if (status) updateUI(status);
          });
        });
      });
      removeBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "removeThread", threadId: thread.id });
      });

      threadsDiv.appendChild(div);
    });
  }

  function updateUI(status) {
    startBtn.textContent = "Add Threads"; // Always "Add Threads"
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
        // Force re-processing of active threads if they appear stuck
        status.watchedThreads.forEach(thread => {
          if (thread.active && !thread.closed && !thread.error) {
            chrome.runtime.sendMessage({ type: "toggleThread", threadId: thread.id }); // Pause
            setTimeout(() => {
              chrome.runtime.sendMessage({ type: "toggleThread", threadId: thread.id }); // Resume
            }, 100);
          }
        });
      }
    });
  });

  chrome.runtime.sendMessage({ type: "getLastSearchParams" }, (params) => {
    if (params && params.board) {
      boardInput.value = params.board;
    }
    if (params && params.searchTerm) {
      searchTermInput.value = params.searchTerm;
    }
    if (params && params.downloadPath) {
      downloadPathInput.value = params.downloadPath;
    }
  });

  chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
    if (status) updateUI(status);
  });

  startBtn.addEventListener("click", () => {
    const searchTerm = searchTermInput.value.trim();
    const threadId = threadIdInput.value.trim();
    const board = boardInput.value.trim();
    const downloadPath = downloadPathInput.value.trim() || "4chan_downloads";
    if (board && (searchTerm || threadId)) {
      chrome.runtime.sendMessage({ type: "start", searchTerm, threadId, board, downloadPath });
    } else {
      appendLog("Please enter a board and either a search term or thread ID.", "error");
    }
  });

  pauseAllBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "stop" });
  });

  resumeAllBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "resumeAll" }, (response) => {
      if (response.success) {
        appendLog("Resumed all paused threads.", "info");
      }
    });
  });

  forgetBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "forgetDownloaded" }, (response) => {
      if (response.success) {
        appendLog("Forgot all downloaded images.", "info");
      }
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

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "log") {
      appendLog(message.message, message.logType);
    } else if (message.type === "updateStatus") {
      updateUI(message);
    }
  });
});