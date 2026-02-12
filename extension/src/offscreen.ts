chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'PING') {
    return;
  }

  console.log('Offscreen received PING');
  sendResponse({ type: 'PONG' });
});
