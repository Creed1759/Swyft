#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const {
  computeWasmHash,
  detectDrift,
  manifestKeysByContract,
} = require('../packages/contract/scripts/check-address-drift.js');

const root = path.dirname(__dirname); // Swyft root
const contractsPath = path.join(root, 'packages', 'contract', 'contracts');
const wasmDir = path.join(root, 'packages', 'contract', 'target', 'wasm32-unknown-unknown', 'release');
const manifestPath = path.join(root, 'packages', 'contract', 'deployments', 'testnet.json');

const discoveredContracts = fs.existsSync(contractsPath)
  ? fs
      .readdirSync(contractsPath)
      .filter((entry) => {
        const full = path.join(contractsPath, entry);
        return (
          fs.statSync(full).isDirectory() &&
          fs.existsSync(path.join(full, 'Cargo.toml'))
        );
      })
  : [];

const contracts = Array.from(
  new Set([...discoveredContracts, ...Object.keys(manifestKeysByContract)])
).sort();

const checkDrift = process.argv.includes('--check-drift');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

log('Validating Swyft contracts...\n', 'yellow');

let passed = 0;
const failed = [];
const missing = [];
const freshHashes = {};

for (const contract of contracts) {
  process.stdout.write(`Building ${contract}... `);

  const contractPath = path.join(contractsPath, contract);

  if (!fs.existsSync(contractPath)) {
    log(`✗ (missing directory: expected ${contractPath})`, 'red');
    missing.push({ contract, expectedPath: contractPath });
    continue;
  }

  try {
    execSync(`cd "${contractPath}" && cargo build --target wasm32-unknown-unknown --release`, {
      stdio: 'pipe',
      timeout: 60000,
    });
    const manifestKeys = manifestKeysByContract[contract];
    if (checkDrift && manifestKeys) {
      const wasmPath = path.join(wasmDir, `${contract.replace(/-/g, '_')}.wasm`);
      if (!fs.existsSync(wasmPath)) {
        throw new Error(`WASM artifact not found: ${wasmPath}`);
      }
      const freshHash = computeWasmHash(wasmPath);
      for (const manifestKey of manifestKeys) {
        freshHashes[manifestKey] = freshHash;
      }
    }

    log('✓', 'green');
    passed++;
  } catch (e) {
    log(`✗${e instanceof Error ? ` (${e.message})` : ''}`, 'red');
    failed.push({ contract, error: e instanceof Error ? e.message : String(e) });
  }
}

console.log('');
log(`Passed: ${passed}/${contracts.length}`, 'green');
if (missing.length > 0) {
  log(`Missing: ${missing.length}/${contracts.length}`, 'red');
}
if (failed.length > 0) {
  log(`Failed: ${failed.length}/${contracts.length}`, 'red');
}

if (missing.length > 0 || failed.length > 0) {
  if (checkDrift) {
    const unbuilt = [...missing.map((m) => m.contract), ...failed.map((f) => f.contract)];
    log(`\nCannot check drift: unbuilt contracts detected (${unbuilt.join(', ')}).`, 'red');
  }
  process.exit(1);
}

log('\nAll Swyft contracts validated!', 'green');

if (checkDrift) {
  const missingManifestContracts = contracts.filter(
    (contract) => !manifestKeysByContract[contract]
  );
  if (missingManifestContracts.length > 0) {
    log(
      `\nContracts missing from manifestKeysByContract: ${missingManifestContracts.join(', ')}`,
      'red'
    );
    process.exit(1);
  }

  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { contracts: {}, wasmHashes: {} };
  const drifted = detectDrift(manifest, freshHashes);

  if (drifted.length > 0) {
    log(`\nAddress drift or missing WASM hash detected: ${drifted.join(', ')}`, 'red');
    log(
      'These deployed contracts could not be verified against their current WASM hashes. ' +
        'Check the artifacts, redeploy if needed (packages/contract/scripts/deploy-testnet.sh), ' +
        'and commit the updated deployments/testnet.json.',
      'red'
    );
    process.exit(1);
  }

  log('\nNo address drift detected.', 'green');
}
