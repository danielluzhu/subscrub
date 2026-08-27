/* Subscrub — service worker: context menu + per-tab badge count. */

const MENU_ID = 'subscrub-block-flair';

function installMenu() {
  // onInstalled and onStartup can both fire around a browser start, so two
  // removeAll->create sequences interleave and the second create collides on
  // the fixed id. The collision is harmless (the menu exists exactly once);
  // read lastError so it never surfaces as an unchecked error.
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Subscrub: filter this commenter's flair",
      contexts: ['all'],
      documentUrlPatterns: ['*://*.reddit.com/*']
    }, () => void chrome.runtime.lastError);
  });
}

chrome.runtime.onInstalled.addListener(installMenu);
chrome.runtime.onStartup.addListener(installMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: 'subscrub:contextBlock' }, () => void chrome.runtime.lastError);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'subscrub:count') return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  const n = Number(msg.filtered) || 0;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff4500' });
});
