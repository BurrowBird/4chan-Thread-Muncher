document.addEventListener("DOMContentLoaded", () => {
  chrome.windows.create({
    url: "control.html",
    type: "normal",
    width: 1050,
    height: 800
  }, () => {
    window.close(); // Close the trigger popup after opening control window
  });
});