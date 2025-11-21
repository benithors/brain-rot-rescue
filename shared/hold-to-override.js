/**
 * Shared hold-to-override handler for focus and overlay UIs.
 * Handles progress animation, pointer capture, cancel/finalize flow, and error reset.
 *
 * @param {HTMLElement} button - The button element to bind.
 * @param {Object} options
 * @param {number} options.durationMs - Required hold duration in milliseconds.
 * @param {Function} options.onComplete - Async callback invoked after the hold completes.
 * @param {string} [options.progressVar='--hold-progress'] - CSS custom property to update [0-1].
 * @param {HTMLElement|null} [options.labelEl] - Element whose text reflects progress; defaults to [data-role="hold-label"].
 * @param {string} [options.completedLabel='Releasing…'] - Label shown once progress hits 100%.
 * @param {Function} [options.formatLabel] - Receives {progress, remainingMs} and returns text while holding.
 * @param {Function} [options.onFinalize] - Called right before awaiting onComplete (for status updates).
 * @param {Function} [options.onCancel] - Called when the gesture is cancelled.
 * @param {Function} [options.onError] - Called with an Error if onComplete throws; handler should surface UI state.
 * @returns {Function|undefined} cleanup - Call to remove listeners and reset state.
 */
export function attachHoldToOverride(button, options = {}) {
  if (!button || typeof options.onComplete !== 'function') return;

  const {
    durationMs = 5000,
    onComplete,
    progressVar = '--hold-progress',
    labelEl = button.querySelector('[data-role="hold-label"]'),
    completedLabel = 'Releasing…',
    formatLabel,
    onFinalize,
    onCancel,
    onError
  } = options;

  const defaultLabel = labelEl?.textContent ?? '';
  let rafId = null;
  let startTs = 0;
  let pointerId = null;
  let active = false;
  let completed = false;

  const setLabel = (text) => {
    if (labelEl) labelEl.textContent = text;
  };

  const updateProgress = (progress) => {
    button.style.setProperty(progressVar, String(progress));
    if (!labelEl) return;
    if (progress <= 0) {
      setLabel(defaultLabel);
      return;
    }
    if (progress >= 1) {
      setLabel(completedLabel);
      return;
    }
    const remainingMs = Math.max(0, durationMs - progress * durationMs);
    const nextLabel = typeof formatLabel === 'function'
      ? formatLabel({ progress, remainingMs })
      : `Keep holding… ${Math.ceil(remainingMs / 1000)}s`;
    setLabel(nextLabel);
  };

  const releasePointer = () => {
    if (pointerId === null) return;
    try {
      button.releasePointerCapture(pointerId);
    } catch (error) {
      // ignore
    }
    pointerId = null;
  };

  const cancel = () => {
    if (!active || completed) {
      releasePointer();
      return;
    }
    active = false;
    startTs = 0;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    releasePointer();
    updateProgress(0);
    if (typeof onCancel === 'function') onCancel();
  };

  const step = (timestamp) => {
    if (!startTs) startTs = timestamp;
    const elapsed = timestamp - startTs;
    const progress = Math.min(elapsed / durationMs, 1);
    updateProgress(progress);
    if (progress >= 1) {
      finalize();
      return;
    }
    rafId = requestAnimationFrame(step);
  };

  const start = (event) => {
    if (button.disabled || completed) return;
    active = true;
    startTs = 0;
    if (event?.pointerId != null) {
      pointerId = event.pointerId;
      try {
        button.setPointerCapture(pointerId);
      } catch (error) {
        // ignore
      }
    }
    rafId = requestAnimationFrame(step);
  };

  const finalize = async () => {
    if (completed) return;
    completed = true;
    active = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    releasePointer();
    updateProgress(1);
    button.disabled = true;
    if (typeof onFinalize === 'function') {
      try {
        onFinalize();
      } catch (error) {
        // onFinalize is best-effort; keep going
      }
    }
    try {
      await onComplete();
    } catch (error) {
      completed = false;
      button.disabled = false;
      updateProgress(0);
      if (typeof onError === 'function') onError(error);
    }
  };

  const handlePointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    start(event);
  };

  const handlePointerUp = () => cancel();
  const handlePointerLeave = () => cancel();
  const handlePointerCancel = () => cancel();
  const handleKeyDown = (event) => {
    if (event.code === 'Space' || event.code === 'Enter') {
      event.preventDefault();
      start();
    }
  };
  const handleKeyUp = () => cancel();
  const handleWindowBlur = () => cancel();

  button.addEventListener('pointerdown', handlePointerDown);
  button.addEventListener('pointerup', handlePointerUp);
  button.addEventListener('pointerleave', handlePointerLeave);
  button.addEventListener('pointercancel', handlePointerCancel);
  button.addEventListener('keydown', handleKeyDown);
  button.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleWindowBlur);

  return () => {
    cancel();
    button.removeEventListener('pointerdown', handlePointerDown);
    button.removeEventListener('pointerup', handlePointerUp);
    button.removeEventListener('pointerleave', handlePointerLeave);
    button.removeEventListener('pointercancel', handlePointerCancel);
    button.removeEventListener('keydown', handleKeyDown);
    button.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('blur', handleWindowBlur);
  };
}
