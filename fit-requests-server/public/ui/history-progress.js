let refreshing = false;
async function refreshHistoryPanel() {
 const panel = document.querySelector("#history-sync");
 if (refreshing || !panel) return;
 refreshing = true;
 try {
  const response = await fetch("/app/analytics/history",{cache:"no-store"});
  if (!response.ok) return;
  const page = new DOMParser().parseFromString(await response.text(),"text/html");
  const updated = page.querySelector("#history-sync");
  if (updated && !panel.contains(document.activeElement) &&
      !panel.querySelector("input:checked")) panel.replaceWith(updated);
 } catch {
  // A failed status read does not change the server job.
 } finally {
  refreshing = false;
 }
}
document.addEventListener("click",event => {
 if (event.target.id !== "history-progress-refresh") return;
 event.preventDefault();
 event.target.blur();
 void refreshHistoryPanel();
});
setInterval(() => {if (!document.hidden) void refreshHistoryPanel();},5000);
