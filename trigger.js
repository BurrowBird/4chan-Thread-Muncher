document.addEventListener("DOMContentLoaded", () => {
  chrome.windows.create({
    url: "control.html",
    type: "normal",
    width: 850,
    height: 760
  }, () => {
    window.close(); // Close the trigger popup after opening control window
  });
});