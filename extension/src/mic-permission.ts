/**
 * Microphone permission request page.
 *
 * Chrome extensions cannot trigger the native permission prompt from popup or
 * offscreen contexts.  This page is opened in a real browser tab so the prompt
 * appears normally.  Once permission is granted the result is sent back to the
 * extension via chrome.runtime.sendMessage and the tab closes itself.
 */

const statusEl = document.getElementById('status')!;

async function requestMicPermission(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((t) => t.stop());

    statusEl.textContent = 'Microphone access granted! Closing...';
    statusEl.classList.add('granted');

    // Notify the extension that permission was granted.
    chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_RESULT', granted: true });

    setTimeout(() => window.close(), 600);
  } catch (err) {
    const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
    if (denied) {
      statusEl.textContent = 'Permission denied. Please click the lock icon in the address bar to allow microphone access, then refresh this page.';
      statusEl.classList.add('denied');
    } else {
      statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      statusEl.classList.add('denied');
    }
    chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_RESULT', granted: false });
  }
}

requestMicPermission();
