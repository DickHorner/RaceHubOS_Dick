import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Match the Vite proxy target. Never start the UI while database preparation is running.
export async function waitForBackend(url) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch {
      // Connection refusal is expected until Prisma and migrations have finished.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Backend not ready at ${url} after 5 minutes. Check the backend startup and migration log.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = `http://localhost:${process.env.BACKEND_PORT || 3001}/health`;
  console.log(`Waiting for backend readiness (${url}) before starting the frontend…`);
  try {
    await waitForBackend(url);
    console.log('Backend ready — starting frontend.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
