import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(path.join(testDir, '..', 'server.js'), 'utf8');

function routeSource(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing route marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing route boundary: ${endMarker}`);
  return serverSource.slice(start, end);
}

test('login uses one request-scoped Supabase auth client for sign-in and profile lookup', () => {
  const source = routeSource("app.post('/api/auth/login'", '// POST /api/auth/refresh');
  assert.match(source, /const authClient = createRequestAuthClient\(\)/);
  assert.match(source, /authClient\.auth\.signInWithPassword/);
  assert.match(source, /await authClient\s*\n\s*\.from\('profiles'\)/);
  assert.doesNotMatch(source, /supabase\.auth\.signInWithPassword/);
});

test('refresh uses a new request-scoped Supabase auth client', () => {
  const source = routeSource("app.post('/api/auth/refresh'", '// POST /api/auth/register');
  assert.match(source, /const authClient = createRequestAuthClient\(\)/);
  assert.match(source, /authClient\.auth\.refreshSession/);
  assert.doesNotMatch(source, /supabase\.auth\.refreshSession/);
});
