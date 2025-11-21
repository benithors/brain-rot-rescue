/**
 * Generates an ASCII progress bar string for the hold-to-override button.
 * @param {Object} params
 * @param {number} params.progress - Current progress (0 to 1).
 * @param {number} params.remainingMs - Remaining time in milliseconds.
 * @returns {string} - The formatted ASCII string.
 */
export function getAsciiLabel({ progress, remainingMs }) {
    const width = 20;
    const filled = Math.floor(progress * width);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}] ${Math.ceil(remainingMs / 1000)}s`;
}
