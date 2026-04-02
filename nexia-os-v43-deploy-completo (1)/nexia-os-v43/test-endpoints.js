#!/usr/bin/env node
'use strict';
// NEXIA OS v43 — Test Suite de Endpoints
const BASE_URL  = process.argv[2] || 'http://localhost:8888';
const TENANT_ID = process.argv[3] || 'nexia';
let passed = 0, failed = 0;
async function req(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const headers = { 'Content-Type': 'application/json', 'x-tenant-id': TENANT_ID };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    return { status: res.status, ok: res.ok };
  } catch (err) {
    return { status: 0, ok: false, err: err.message };
  }
}
async function run() {
  console.log('NEXIA OS v43 — Test Suite — Base URL:', BASE_URL);
  const r1 = await req('GET', '/api/observe?action=health');
  if (r1.ok) { console.log('PASS GET /api/observe'); passed++; }
  else { console.log('FAIL GET /api/observe status', r1.status); failed++; }
  console.log('Passou:', passed, 'Falhou:', failed);
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(err => { console.error('ERRO:', err.message); process.exit(2); });