import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowlistedEnv } from '../../env';

/**
 * A REAL LiteLLM Proxy for contract tests, run locally with its upstream pointed at our fake
 * Anthropic API (fakeAnthropic.ts). Opt-in: only when `ACC_LITELLM_BIN` names a `litellm`
 * executable (e.g. one installed into a throwaway venv). No real upstream, no cost:
 *
 * - bound to 127.0.0.1 on a free port, with a dummy master key;
 * - every model's `api_base` is the fake API, with a dummy upstream key;
 * - the environment is built from a short allowlist (process basics only) plus a temp HOME /
 *   TEMP, `LITELLM_TELEMETRY=False` and `LITELLM_LOCAL_MODEL_COST_MAP=True`, and
 *   HTTPS_PROXY / HTTP_PROXY pointing at a refusing proxy (NO_PROXY for 127.0.0.1), so the
 *   developer's ANTHROPIC_* / *_API_KEY never reach it and any egress attempt is recorded.
 *
 * Findings: docs/snapshot/20261029_litellm-contract.md.
 */

/** Dummy LiteLLM master key (the key our daemon / the CLI present to LiteLLM). */
export const LITELLM_MASTER_KEY = 'sk-acc-litellm-dummy';
/** Dummy key LiteLLM presents to the fake upstream. */
export const UPSTREAM_DUMMY_KEY = 'sk-acc-upstream-dummy';

export interface LiteLlmModel {
  /** LiteLLM model_name (what clients ask for). */
  name: string;
  /** litellm_params.model, e.g. "anthropic/claude-sonnet-4-5". */
  model: string;
  /** Extra litellm_params (e.g. `thinking`), written as JSON values. */
  params?: Record<string, unknown>;
}

export interface LiteLlmOptions {
  bin: string;
  /** The fake Anthropic API (http://127.0.0.1:port). */
  upstream: string;
  models: LiteLlmModel[];
  /** Refusing egress proxy URL. */
  egressProxy: string;
  /** Extra `litellm_settings` lines (YAML, already indented by 2). */
  litellmSettings?: string[];
  /** Extra router_settings lines (YAML, already indented by 2). */
  routerSettings?: string[];
  /**
   * A tiktoken cache directory (CUSTOM_TIKTOKEN_CACHE_DIR). LiteLLM 1.106 counts tokens with
   * cl100k_base but its wheel no longer bundles that file, so offline it would try to download
   * it (blocked here) and every Anthropic chat call fails with HTTP 500.
   */
  tiktokenCacheDir?: string | null;
  /** How long to wait for /health/liveliness (default 120s; the first import is slow). */
  startTimeoutMs?: number;
}

export interface LiteLlmProxy {
  url: string;
  /** stdout + stderr of the proxy (may include local paths: do not commit). */
  output: string[];
  stop(): Promise<void>;
}

/** The `litellm` executable from ACC_LITELLM_BIN when it exists, else null (skip). */
export function locateLiteLlm(env: NodeJS.ProcessEnv = process.env): string | null {
  const bin = env.ACC_LITELLM_BIN?.trim();
  return bin && existsSync(bin) ? bin : null;
}

/** ACC_LITELLM_TIKTOKEN_CACHE: a directory with tiktoken's cached encodings (see options). */
export function liteLlmTiktokenCache(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.ACC_LITELLM_TIKTOKEN_CACHE?.trim();
  return dir && existsSync(dir) ? dir : null;
}

export function liteLlmConfigYaml(
  o: Omit<LiteLlmOptions, 'bin' | 'egressProxy' | 'tiktokenCacheDir'>,
): string {
  const lines = ['model_list:'];
  for (const m of o.models) {
    lines.push(
      `  - model_name: ${JSON.stringify(m.name)}`,
      '    litellm_params:',
      `      model: ${JSON.stringify(m.model)}`,
      `      api_base: ${JSON.stringify(o.upstream)}`,
      `      api_key: ${JSON.stringify(UPSTREAM_DUMMY_KEY)}`,
      ...Object.entries(m.params ?? {}).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`),
    );
  }
  lines.push('litellm_settings:', '  telemetry: false', ...(o.litellmSettings ?? []));
  if (o.routerSettings?.length) lines.push('router_settings:', ...o.routerSettings);
  lines.push('general_settings:', `  master_key: ${JSON.stringify(LITELLM_MASTER_KEY)}`);
  return `${lines.join('\n')}\n`;
}

export async function startLiteLlm(o: LiteLlmOptions): Promise<LiteLlmProxy> {
  const root = mkdtempSync(join(tmpdir(), 'acc-litellm-contract-'));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const config = join(root, 'config.yaml');
  writeFileSync(config, liteLlmConfigYaml(o));
  const port = await freePort();

  const env: Record<string, string> = {
    ...allowlistedEnv(process.env, [
      'PATH',
      'PATHEXT',
      'SYSTEMROOT',
      'SYSTEMDRIVE',
      'WINDIR',
      'COMSPEC',
      'OS',
      'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE',
    ]),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    HTTPS_PROXY: o.egressProxy,
    HTTP_PROXY: o.egressProxy,
    NO_PROXY: '127.0.0.1,localhost',
    LITELLM_TELEMETRY: 'False',
    LITELLM_LOCAL_MODEL_COST_MAP: 'True',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    ...(o.tiktokenCacheDir ? { CUSTOM_TIKTOKEN_CACHE_DIR: o.tiktokenCacheDir } : {}),
  };
  const output: string[] = [];
  const child: ChildProcess = spawn(
    o.bin,
    ['--config', config, '--host', '127.0.0.1', '--port', String(port), '--num_workers', '1'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const collect = (b: Buffer) => output.push(...b.toString('utf8').split(/\r?\n/).filter(Boolean));
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (!exited && child.pid) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // already gone
      }
      for (let i = 0; i < 50 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
    }
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(root, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  const deadline = Date.now() + (o.startTimeoutMs ?? 120_000);
  for (;;) {
    if (exited) {
      await stop();
      throw new Error(`LiteLLM exited during startup:\n${output.slice(-30).join('\n')}`);
    }
    try {
      const res = await fetch(`${url}/health/liveliness`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`LiteLLM did not start in time:\n${output.slice(-30).join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, output, stop };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}
