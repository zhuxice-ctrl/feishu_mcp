// run-suite-clean.mjs — full suite under a clean env.
// Strips owner/policy vars that leak from the hosting shell (production service env);
// without this, tests boot servers with inherited GIT_COMMAND_POLICY=soft_owner and no
// OWNER_USER_ID and fail at startup with 'OWNER_USER_ID is required...'.
import { spawnSync } from 'node:child_process';

const STRIP = [
  'GIT_COMMAND_POLICY', 'OWNER_USER_ID', 'OWNER_COMMAND_POLICY', 'OWNER_DEFAULT_DIRS',
  'DIRECTORY_APPROVAL_FALLBACK', 'APPROVAL_STATE_SECRET', 'DEV_ENV_OWNER_SID',
  'DEV_ENV_BROKER_KEY_PATH', 'FEISHU_MCP_MANAGED_LAUNCH',
  // Server-binding / auth vars the production host env leaks into test-spawned
  // servers; tests that need them set them explicitly (PUBLIC_HOST leak masks
  // the NGROK_DOMAIN fallback; leaked PORT=3000 can collide with live services).
  'PUBLIC_HOST', 'NGROK_DOMAIN', 'HOST', 'PORT',
  'MCP_AUTH_TOKEN', 'AUTH_TOKEN', // AUTH_MODE/AUTH_PIN deliberately inherited: config defaults AUTH_MODE to "pin" and needs the pair; the dirty pair is self-consistent
];
for (const key of STRIP) delete process.env[key];

const args = [
  '--test', '--test-reporter=tap', '--test-reporter-destination=suite.log',
  '--test-concurrency=4', ...process.argv.slice(2),
];
const r = spawnSync(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
process.exit(r.status ?? 1);
