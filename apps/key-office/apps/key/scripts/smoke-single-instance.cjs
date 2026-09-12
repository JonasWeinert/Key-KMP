const { _electron: electron } = require('playwright-core');
const { spawn } = require('node:child_process');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
(async () => {
  const executablePath = process.env.KEY_ELECTRON_EXECUTABLE;
  if (!executablePath) throw Error('Set KEY_ELECTRON_EXECUTABLE to the packaged Key executable');
  const temp = await mkdtemp(path.join(tmpdir(), 'key-single-instance-'));
  const env = { ...process.env, KEY_USER_DATA: path.join(temp, 'profile'), KEY_WORKSPACE_PARENT: path.join(temp, 'workspaces') };
  const app = await electron.launch({ executablePath, args: [], env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.key);
    const secondary = spawn(executablePath, [], { env, stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { secondary.kill(); reject(Error('Second instance did not exit')); }, 10000);
      secondary.once('exit', code => { clearTimeout(timer); resolve(code); });
      secondary.once('error', error => { clearTimeout(timer); reject(error); });
    });
    if (code !== 0) throw Error(`Second instance exit ${code}`);
    if (!(await page.evaluate(() => window.key.tabs())).tabs.length) throw Error('Original owner is unavailable');
    console.log(JSON.stringify({ ok: true, secondaryExit: code, originalOwnerAlive: true, temp }));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
