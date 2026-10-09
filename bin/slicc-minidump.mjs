#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process, { arch, argv, env, platform, stderr, stdout } from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const VERSION = '0.27.0';
const FRAMES = 40;
const builds = {
  'linux-x64': [
    'x86_64-unknown-linux-gnu',
    '0020324c54cc359596e927ee907204f4c8d4da6718765536edcabaa1622122ad',
  ],
  'darwin-arm64': [
    'aarch64-apple-darwin',
    '5fcd4d25a5b0bbdc8faac6f4f81629bc67483c3eb458b86a8304733a7c6a2ca9',
  ],
  'darwin-x64': [
    'x86_64-apple-darwin',
    '801fa500d159fe474260ef1aad80706bed822434aced7fdb21c1b2c7a06afe6f',
  ],
};

async function stackwalk() {
  const build = builds[`${platform}-${arch}`];
  if (!build) throw new Error(`no minidump-stackwalk ${VERSION} build for ${platform}-${arch}`);
  const [target, sha256] = build;
  const dir = join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'slicc-minidump', VERSION);
  const binary = join(dir, `minidump-stackwalk-${target}`, 'minidump-stackwalk');
  const cached = await access(binary).then(
    () => true,
    () => false
  );
  if (cached) return binary;
  const name = `minidump-stackwalk-${target}.tar.xz`;
  const url = `https://github.com/rust-minidump/rust-minidump/releases/download/v${VERSION}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== sha256) throw new Error(`${url}: sha256 ${digest}, expected ${sha256}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), archive);
  await run('tar', ['-xJf', join(dir, name), '-C', dir]);
  return binary;
}

function annotations(dump) {
  const pattern =
    /^\s*(?:simple_annotations|module_list\[\d+\]\.annotation_objects)\["([^"]+)"\] = (.*)$/;
  return dump
    .split('\n')
    .map((line) => line.match(pattern))
    .filter((match) => match && !/^(switch-|variations$)/.test(match[1]))
    .map(([, key, value]) => `  ${key} = ${value}`);
}

function frame({ frame: n, module, module_offset, offset, function: fn, trust }) {
  const where = module ? `${module} + ${module_offset}` : offset;
  const named = fn ? ` ${fn}` : '';
  return `${String(n).padStart(4)}  ${where}${named}  (${trust})`;
}

function report(walked, dump) {
  const { crash_info: crash, crashing_thread: thread, modules, system_info: system } = walked;
  const top = thread?.frames?.[0];
  return [
    `crash: ${crash?.type ?? 'none'} at ${crash?.address ?? '?'}`,
    `faulting: ${top ? frame(top).trim() : 'no crashing thread'}`,
    `instruction: ${crash?.instruction ?? '?'}`,
    `system: ${system?.os} ${system?.os_ver} ${system?.cpu_arch}, ${walked.process_uptime ?? '?'} s up`,
    'annotations:',
    ...annotations(dump),
    `thread ${crash?.crashing_thread} ${thread?.thread_name ?? ''} (${thread?.frame_count ?? 0} frames):`,
    ...(thread?.frames ?? []).slice(0, FRAMES).map(frame),
    'modules:',
    ...modules.map(
      ({ base_addr, end_addr, filename, code_id }) =>
        `  ${base_addr}-${end_addr}  ${filename}  ${code_id ?? ''}`
    ),
    '',
  ].join('\n');
}

async function describe(binary, file) {
  const options = { maxBuffer: 256 * 1024 * 1024 };
  const [json, dump] = await Promise.all([
    run(binary, ['--json', file], options),
    run(binary, ['--dump', file], options),
  ]);
  return report(JSON.parse(json.stdout), dump.stdout);
}

async function main(files) {
  if (files.length === 0) {
    stderr.write('usage: slicc-minidump <file.dmp>...\n');
    return 2;
  }
  const binary = await stackwalk();
  for (const file of files) stdout.write(`== ${file}\n${await describe(binary, file)}\n`);
  return 0;
}

main(argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    stderr.write(`slicc-minidump: ${error.message}\n`);
    process.exitCode = 1;
  }
);
