/** CU code 6 invalidates this attempt until a new first light or explicit stop. */
export function nextStartPhase(previous, start) {
  if (start === 6) return 'false_start';
  if (start === 1) return 'lights';
  if (start >= 8) return 'idle';
  if (previous === 'false_start') return previous;
  if (start >= 2 && start <= 5) return 'lights';
  if (start === 7 || start === 0) {
    return previous === 'lights' || previous === 'go' ? 'go' : 'idle';
  }
  return previous;
}
