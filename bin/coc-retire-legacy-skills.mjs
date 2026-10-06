#!/usr/bin/env node
// A prior emission receipt establishes ownership; current installed files do not.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || '.');
const receiptPath = path.resolve(process.argv[3] || path.join(root, '.codex/legacy-skills-receipt.json'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const safeFile = (relative) => {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current) || fs.lstatSync(current).isSymbolicLink()) return false;
  }
  return fs.statSync(current).isFile();
};
try {
  if (!fs.existsSync(receiptPath)) {
    console.log('Legacy skills preserved: no prior generator receipt; review ownership before retirement.');
  } else {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.generator !== 'emit-cli-artifacts.mjs' || !/^[a-f0-9]{40}$/.test(receipt.source_commit || '') ||
        !receipt.files || Array.isArray(receipt.files) || typeof receipt.files !== 'object') {
      throw new Error('invalid prior generator receipt');
    }
    const entries = Object.entries(receipt.files);
    for (const [relative, hash] of entries) {
      if (!/^\.codex\/skills\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(relative) ||
          relative.split('/').some(p => p === '.' || p === '..') || !/^[a-f0-9]{64}$/.test(hash)) {
        throw new Error('invalid legacy receipt path or digest');
      }
    }
    // Prior generator ownership never overrides the destination's current veto.
    // The delivered lock is the existing bounded target-owned projection; a
    // consumer must not fetch the owner's full distribution manifest for this.
    let ownership;
    let isOwnedBy;
    try {
      const modulePath = '.claude/bin/coc-delivery-lock.mjs';
      if (!safeFile(modulePath)) throw new Error('delivery-lock reader is missing or symlinked');
      const reader = await import(pathToFileURL(path.join(root, modulePath)));
      const read = reader.readDeliveryLock(root);
      if (read.state !== 'ok') throw new Error(`delivery lock is ${read.state}`);
      ownership = read.lock.consumer_owned;
      isOwnedBy = reader.isOwnedBy;
      // These documented consumer preservation carriers have no shared typed
      // parser. Their presence cannot be treated as an empty preserve set.
      for (const rel of ['.claude/sync-preserve.yaml', '.claude/sync-preserve.local.yaml']) {
        try {
          fs.lstatSync(path.join(root, rel));
          throw new Error(`${rel} requires ownership review; automatic retirement preserves all paths`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      console.log(`Legacy skills preserved: current ownership not verified (${error.message}).`);
      process.exit(0);
    }
    let retired = 0;
    for (const [relative, expected] of entries) {
      if (isOwnedBy(relative, ownership)) {
        console.log(`Legacy skill preserved: ${relative} (current consumer-owned deletion veto)`);
        continue;
      }
      const replacement = relative.replace(/^\.codex\/skills\//, '.agents/skills/');
      const tracked = git('ls-files', '--', relative).trim() === relative;
      const clean = git('status', '--porcelain', '--untracked-files=all', '--', relative).trim() === '';
      const equal = safeFile(relative) && crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex') === expected;
      if (!tracked || !clean || !equal || !safeFile(replacement) || !fs.statSync(path.join(root, replacement)).size) {
        console.log(`Legacy skill preserved: ${relative} (ownership bytes, clean tracked state or replacement not verified)`);
        continue;
      }
      git('rm', '--', relative);
      console.log(`Legacy generated file retired: ${relative}`);
      retired++;
    }
    console.log(`Legacy retirement receipt ${receipt.source_commit}: ${retired}/${entries.length} files retired; unlisted files preserved.`);
  }
} catch (error) {
  console.error(`Legacy skill retirement refused: ${error.message}`);
  process.exitCode = 1;
}
