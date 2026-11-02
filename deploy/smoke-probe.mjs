import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [mode, stateRoot = '/data'] = process.argv.slice(2);
const base = 'http://127.0.0.1:3000';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const request = async (path, status, options = {}) => {
  const result = await fetch(`${base}${path}`, {...options, signal: AbortSignal.timeout(10000)});
  assert.equal(result.status, status, `${options.method ?? 'GET'} ${path}`);
  return result;
};
const health = await (await request('/health', 200)).json();
assert.equal(health.database.ok, true);
assert.ok(health.database.migrationsApplied > 0);
assert.equal(health.storage.ok, true);
assert.ok(process.env.RECUEIL_SMOKE_EXPECTED_VERSION, 'An expected runtime version is required');
assert.equal(health.version, process.env.RECUEIL_SMOKE_EXPECTED_VERSION, 'Runtime version must match the explicitly expected image version');
assert.notEqual(process.getuid(), 0, 'runtime probe must use the image non-root user');
if (mode === 'health') {
  console.log(JSON.stringify({mode, uid:process.getuid(), database:health.database.ok, storage:health.storage.ok}));
} else if (mode === 'seed') {
  const item = await (await request('/api/v1/items', 201, {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({itemType:'article',title:'Disposable container recovery fixture',bibliographic:{title:'Disposable container recovery fixture'}})
  })).json();
  assert.equal(typeof item.id, 'string');
  const pdf = await readFile('/fixture.pdf');
  const upload = async status => {
    const form = new FormData();
    form.append('itemId', item.id); form.append('role', 'primary');
    form.append('file', new Blob([pdf], {type:'application/pdf'}), 'synthetic-fixture.pdf');
    return (await request('/api/v1/documents',status,{method:'POST',body:form})).json();
  };
  const first = await upload(201);
  assert.equal(first.document.sha256, hash(pdf));
  assert.equal(first.document.byteSize, pdf.length);
  const duplicate = await upload(200);
  assert.equal(duplicate.document.id,first.document.id);
  assert.equal(duplicate.created,false); assert.equal(duplicate.blobWritten,false);
  await request('/api/v1/documents',415,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  await request('/api/v1/items',422,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({itemType:'article',titel:'unknown field'})});
  const token = await (await request('/api/v1/tokens',201,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'disposable-container-probe',scopes:['admin:*']})})).json();
  assert.equal(typeof token.secret,'string');
  const state = {itemId:item.id,documentId:first.document.id,sha256:hash(pdf),byteSize:pdf.length};
  await writeFile('/data/.audit-state.json',JSON.stringify(state),{mode:0o600});
  await writeFile('/data/.audit-token.json',JSON.stringify({secret:token.secret}),{mode:0o600});
  console.log(JSON.stringify({mode,uid:process.getuid(),...state,deduplication:true,invalid_upload_415:true,unknown_field_422:true,token_created:true}));
} else if (mode === 'check') {
  const state = JSON.parse(await readFile(`${stateRoot}/.audit-state.json`,'utf8'));
  const {secret} = JSON.parse(await readFile(`${stateRoot}/.audit-token.json`,'utf8'));
  await request('/api/v1/items',401);
  await request('/api/v1/items',401,{headers:{authorization:'Bearer intentionally-invalid-probe-token'}});
  const headers = {authorization:`Bearer ${secret}`};
  const item = await (await request(`/api/v1/items/${state.itemId}`,200,{headers})).json();
  assert.equal(item.title,'Disposable container recovery fixture');
  const document = await (await request(`/api/v1/documents/${state.documentId}`,200,{headers})).json();
  assert.equal(document.sha256,state.sha256);
  const bytes = Buffer.from(await (await request(`/api/v1/documents/${state.documentId}/content`,200,{headers})).arrayBuffer());
  assert.equal(hash(bytes),state.sha256); assert.equal(bytes.length,state.byteSize);
  await request(`/api/v1/documents/by-sha256/${'0'.repeat(64)}`,404,{headers});
  console.log(JSON.stringify({mode,uid:process.getuid(),...state,auth_required_401:true,bad_token_401:true,authenticated_reads:true,missing_document_404:true,content_hash_matches:true}));
} else {
  throw new Error(`Unknown probe mode ${mode}`);
}
