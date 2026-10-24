#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { isMainModule } from './lib/entry-point.mjs';
import { next } from './lib/engines/d0-next.mjs';
const require = createRequire(import.meta.url);
const { detectActiveWorkspace } = require('../hooks/lib/workspace-utils.js');
const { readEventLog, foldProjection, partitionSkips } = require('../hooks/lib/burndown-events.js');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const cmp = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const clean = (text,limit=4096) => String(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]/gu,' ').slice(0,limit);
const printable = value => typeof value==='string' ? clean(value) : Array.isArray(value) ? value.map(printable)
  : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([key,v])=>[clean(key),printable(v)])) : value;
function fail(code,inputPath) {
  const named=inputPath===undefined?null:clean(inputPath);
  throw Object.assign(new Error(code+(named===null?'':': '+named)),{code,...(named===null?{}:{input_path:named})});
}
const relative = (root,file) => path.relative(root,file).split(path.sep).join('/');
const inside = (root,file) => { const r=path.relative(root,file); return r!== '..' && !r.startsWith('..'+path.sep) && !path.isAbsolute(r); };
function validPath(rel,reported=rel) {
  if (!rel.split('/').every(segment=>/^[A-Za-z0-9._-]+$/.test(segment))) fail('PATH_SEGMENT_REFUSED',reported);
}
function ordinary(root,file) {
  const rel=relative(root,file);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) fail('INPUT_PATH_REFUSED',rel);
    const canonical=fs.realpathSync.native(file);
    if (!inside(root,canonical)) fail('INPUT_PATH_REFUSED',rel);
    const fd=fs.openSync(canonical,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try {
      const st=fs.fstatSync(fd); if (!st.isFile() || st.size>512*1024) fail('TODO_FILE_INVALID',rel);
      const bytes=Buffer.alloc(512*1024+1); let size=0;
      while(size<bytes.length) { const n=fs.readSync(fd,bytes,size,bytes.length-size,null); if(!n) break; size+=n; }
      if(size>512*1024) fail('TODO_FILE_INVALID',rel); return bytes.subarray(0,size).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (error) { if(error.input_path!==undefined) throw error; fail(error.code ?? 'INPUT_UNREADABLE',rel); }
}
function field(front,name) {
  const lines=front.split(/\r?\n/), hits=lines.filter(l=>l.startsWith(name+':'));
  if (hits.length===0) return null;
  if (hits.length!==1) return undefined;
  const raw=hits[0].slice(name.length+1).trim();
  if (raw) return raw;
  const start=lines.indexOf(hits[0])+1, values=[];
  for (const line of lines.slice(start)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m=/^\s+-\s+(.+)$/.exec(line); if (!m) break;
    values.push(m[1].replace(/^['"]|['"]$/g,''));
  }
  return values.length ? JSON.stringify(values) : undefined;
}
function dependencies(raw) {
  if (raw===null) return null;
  try {
    const values=JSON.parse(raw);
    return Array.isArray(values) && values.every(x=>typeof x==='string' && x.length>0) && new Set(values).size===values.length ? values : null;
  } catch { return null; }
}
export function captureWorkspace(repoInput,workspaceInput,asOf) {
  if (!Number.isSafeInteger(asOf) || asOf<0) fail('SNAPSHOT_TIME_INVALID');
  const repo=fs.realpathSync.native(repoInput), wsRoot=fs.realpathSync.native(path.join(repo,'workspaces'));
  const selected=workspaceInput ? path.resolve(path.normalize(workspaceInput).split(path.sep)[0]==='workspaces'?repo:wsRoot,workspaceInput) : detectActiveWorkspace(repo)?.path;
  if (!selected) fail('WORKSPACE_UNAVAILABLE');
  const workspace=fs.realpathSync.native(selected), name=path.basename(workspace);
  if (!inside(wsRoot,workspace) || path.dirname(workspace)!==wsRoot || name==='instructions' || name.startsWith('_')) fail('WORKSPACE_REFUSED',relative(repo,selected));
  validPath(relative(repo,workspace),relative(repo,selected));
  const files=[], memberships=[], diagnostics=[]; let skipped=0, skippedDots=0, skippedOther=0;
  for (const bucket of ['active','completed']) {
    const base=path.join(workspace,'todos',bucket), relBase=relative(repo,base);
    let stat;
    try { stat=fs.lstatSync(base); }
    catch(error) {
      if(error.code==='ENOENT') {diagnostics.push('TODO_BUCKET_EMPTY:'+relBase);memberships.push([relBase,'ABSENT']);continue;}
      fail(error.code ?? 'TODO_DIRECTORY_UNREADABLE',relBase);
    }
    if(stat.isSymbolicLink() || !stat.isDirectory() || !inside(workspace,fs.realpathSync.native(base))) fail('TODO_DIRECTORY_REFUSED',relBase);
    memberships.push([relBase,'DIRECTORY']);
    const visit=dir=>{
      const entries=fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>cmp(a.name,b.name));
      for (const e of entries) {
        const file=path.join(dir,e.name), rel=relative(repo,file);
        if (e.name.startsWith('.')) {skippedDots++;memberships.push([rel,'DOT_SKIPPED']);diagnostics.push('SKIPPED_DOT_ENTRY:'+rel);continue;}
        if(e.isSymbolicLink() && !e.name.endsWith('.md')) {
          skipped++;memberships.push([rel,'SYMLINK_SKIPPED']);diagnostics.push('SKIPPED_SYMLINK_ENTRY:'+rel);continue;
        }
        if (!e.isDirectory() && !e.name.endsWith('.md')) {skippedOther++;memberships.push([rel,'NON_TODO_SKIPPED']);diagnostics.push('SKIPPED_NON_TODO_ENTRY:'+rel);continue;}
        validPath(rel);
        if (e.isDirectory()) { memberships.push([rel,'DIRECTORY']);visit(file);continue; }
        const text=ordinary(repo,file);
        const sourceId=name+'/'+path.relative(base,file).split(path.sep).join('/').replace(/\.md$/,'');
        const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
        const priority=field(front,'priority')?.replace(/^['"]|['"]$/g,'');
        const order=/^P?[0-9]{1,6}$/.test(priority ?? '') ? Number(priority.replace(/^P/,'')) : null;
        const statusField=field(front,'status'), status=statusField?.replace(/^['"]|['"]$/g,'').toLowerCase();
        const state=statusField===undefined ? 'UNKNOWN' : bucket==='completed' ? 'DONE' : ({in_progress:'IN_PROGRESS',active:'IN_PROGRESS',blocked:'BLOCKED',built_not_walked:'BUILT_NOT_WALKED',pending:'NOT_STARTED',not_started:'NOT_STARTED'}[status] ?? (statusField===null ? 'NOT_STARTED' : 'UNKNOWN'));
        files.push({source_id:sourceId,id:'todo.'+hash(sourceId).slice(0,32),revision:0,bucket,state,dependencies:dependencies(field(front,'depends_on')),
          order,title:clean(/^#\s+(.+)$/m.exec(text)?.[1] ?? sourceId,500),source_ref:{id:'source.'+hash(rel).slice(0,32),sha256:hash(text)},path:rel});
        if (files.length>10000) fail('TODO_MEMBERSHIP_OVER_LIMIT');
      }
    };
    visit(base);
  }
  if (new Set(files.map(f=>f.source_id)).size!==files.length) fail('TODO_IDENTITY_COLLISION');
  const log=readEventLog(repo);
  if (!log.ok) fail('LEDGER_UNREADABLE');
  const folded=foldProjection(log.text), skips=partitionSkips(folded);
  const ledger=[...folded.rows.values()].filter(r=>r.id.startsWith(name+'/')).map(r=>({source_id:r.id,title:clean(r.item,500)}));
  const fingerprint=hash(JSON.stringify({workspace:name,files:files.map(f=>[f.path,f.source_ref.sha256]),memberships,ledger:hash(log.text),pendingTorn:log.pendingTorn}));
  return {workspace:name,as_of_epoch_seconds:asOf,files,ledger,input_sha256:fingerprint,skipped_symlink_entries:skipped,skipped_dot_entries:skippedDots,skipped_other_entries:skippedOther,
    diagnostics:[...diagnostics,...(log.pendingTorn?['PENDING_LEDGER_TORN']:[]),...(folded.skipped.length?['LEDGER_SKIPS_UNVERIFIED']:[])],ledger_skips:Object.fromEntries(Object.entries(skips).map(([k,v])=>[k,v.length]))};
}
export function rankWorkspace(before,after) {
  const bySource=new Map(before.files.map(f=>[f.source_id,f])), rows=[], anchors=[];
  for (const file of before.files) {
    const deps=file.dependencies, resolved=deps?.map(id=>bySource.get(id.replace(/\.md$/,'')));
    const blocked=resolved?.some(f=>f?.bucket==='active');
    const dependency=blocked ? 'BLOCKED' : deps===null || resolved.some(f=>!f || f.state!=='DONE') ? 'UNKNOWN' : 'READY';
    rows.push({...file,dependency_status:dependency,blocking_dependency_ids:deps===null?null:deps.filter((id,i)=>resolved[i]?.bucket!=='completed').map(id=>'todo.'+hash(id).slice(0,32)),
      closure:file.bucket==='completed'?'TERMINAL_UNVERIFIED':'OPEN',unknown_fields:['CLOSURE_UNVERIFIED',...(dependency==='UNKNOWN'?['DEPENDENCIES_UNKNOWN']:[])]});
    if (file.order!==null) anchors.push({item_id:file.id,anchor_ref:file.source_ref,order:file.order});
  }
  for (const item of before.ledger) if (!bySource.has(item.source_id)) rows.push({...item,id:'todo.'+hash(item.source_id).slice(0,32),revision:0,state:'UNKNOWN',
    closure:'OPEN',dependency_status:'UNKNOWN',blocking_dependency_ids:null,unknown_fields:['LEDGER_ONLY','CLOSURE_UNVERIFIED']});
  const forest={schema:'loom.s0.forest',version:1,as_of_epoch_seconds:before.as_of_epoch_seconds,coverage:'UNKNOWN',observed_items:rows.length,unknown_items:rows.length,
    lanes:[{lane_ref:null,items:rows}]};
  const context={coverage:'UNKNOWN',anchors,unknown_fields:['CAPTURE_UNVERIFIED']};
  const decision=next({forest,decision_context:context},before.as_of_epoch_seconds);
  const stale=before.input_sha256!==after.input_sha256;
  const contested=decision.unmet.includes('TOP_TIE');
  const recommended=stale || contested?null:rows.find(r=>r.id===decision.recommended_id) ?? null;
  const rankedById=new Map(decision.ranked.map(r=>[r.id,r]));
  const candidates=stale?[]:rows.filter(r=>rankedById.get(r.id)?.rationale?.contested).map(r=>r.source_id);
  return printable({workspace:before.workspace,status:stale?'STALE':'UNVERIFIED',input_sha256:before.input_sha256,after_sha256:after.input_sha256,
    as_of_epoch_seconds:before.as_of_epoch_seconds,action_authorized:false,coverage:'UNKNOWN',skipped_symlink_entries:before.skipped_symlink_entries,recommended_id:recommended?.source_id ?? null,candidates,
    skipped_dot_entries:before.skipped_dot_entries,skipped_other_entries:before.skipped_other_entries,
    why:stale?'Inputs moved during capture; refresh before comparing.':decision.unmet.includes('TOP_TIE')?'Tied observed ready items; deciding inputs are unverified.':recommended ? `declared priority ${recommended.order ?? 'unknown'}; state ${recommended.state}; dependencies READY; closure unverified`:'No observed ready item; unresolved metadata is not readiness.',
    blocked_on_unclosed_todos:rows.filter(r=>r.dependency_status==='BLOCKED').length,unknown_dependencies:rows.filter(r=>r.dependency_status==='UNKNOWN').length,
    diagnostics:before.diagnostics,unmet:decision.unmet,selection:decision.selection,rows:rows.map(r=>({source_id:r.source_id,title:r.title,state:r.state,dependency_status:r.dependency_status,
      closure:'UNVERIFIED',action_authorized:false,rank:rankedById.get(r.id)?.rank ?? null,rationale:rankedById.get(r.id)?.rationale ?? null,
      exclusion:rankedById.has(r.id)?null:r.state==='DONE'?'TERMINAL_UNVERIFIED':r.dependency_status==='READY'?r.state:r.dependency_status}))});
}
export function renderRecommendation(result) {
  result=printable(result);
  const ranked=(result.rows ?? []).filter(r=>r.rank!==null).sort((a,b)=>a.rank-b.rank), tied=ranked.filter(r=>r.rationale?.contested);
  const top=ranked.find(r=>r.source_id===result.recommended_id), contested=result.unmet?.includes('TOP_TIE');
  const visible=contested?tied:ranked.slice(0,5);
  return [contested?`TOP_TIE; contested=true; ${tied.length} ready candidates; order among them is not decided`:`Recommended next item: ${top?top.source_id+' — '+JSON.stringify(top.title):'NONE'}`,
    `Why: ${result.why}`,`Selection: ${result.selection ?? 'SURFACE'}; unmet: ${(result.unmet ?? []).join(', ') || 'NONE'}`,
    `Diagnostics: ${(result.diagnostics ?? []).join(', ') || 'NONE'}`,
    `${result.skipped_symlink_entries ?? 0} skipped symlinked entries; coverage UNKNOWN`,
    `${result.skipped_dot_entries ?? 0} skipped dot entries; ${result.skipped_other_entries ?? 0} skipped non-todo entries; coverage UNKNOWN`,
    `${result.blocked_on_unclosed_todos ?? 0} blocked on unclosed todos; ${result.unknown_dependencies ?? 0} dependency status UNKNOWN`,
    `Status: ${result.status}; action_authorized=false; closure UNVERIFIED`,
    `${(result.rows ?? []).length-visible.length} other observed rows available with --json`,
    ...visible.map(r=>`- ${r.source_id}: ${JSON.stringify(r.title)} [closure UNVERIFIED; ${r.dependency_status}; rank ${r.rank}; contested=${r.rationale?.contested === true}]`)].join('\n')+'\n';
}
export function main(argv=process.argv.slice(2)) {
  try {
    let workspace, json=false, asOf=Math.floor(Date.now()/1000);
    for (let i=0;i<argv.length;i++) {
      if (argv[i]==='--workspace' && argv[i+1]) workspace=argv[++i];
      else if (argv[i]==='--as-of' && /^(0|[1-9][0-9]*)$/.test(argv[i+1] ?? '')) asOf=Number(argv[++i]);
      else if (argv[i]==='--json') json=true;
      else fail('USAGE: ws-next [--workspace <selected-name>] [--as-of <epoch>] [--json]');
    }
    const before=captureWorkspace(process.cwd(),workspace,asOf), after=captureWorkspace(process.cwd(),before.workspace,asOf);
    const result=rankWorkspace(before,after);
    process.stdout.write(json?JSON.stringify(printable(result))+'\n':renderRecommendation(result));
    return result.status==='STALE'?2:0;
  } catch (error) {
    process.stdout.write(JSON.stringify(printable({status:'UNKNOWN',action_authorized:false,recommended_id:null,code:error.code ?? 'WORKSPACE_UNKNOWN',
      ...(error.input_path===undefined?{}:{input_path:error.input_path}),why:error.input_path!==undefined?error.message:error.code?'Workspace inputs could not be read ('+error.code+'); check the selected workspace and todo directories.':error.message}))+'\n');return 2;
  }
}
if (isMainModule(import.meta.url)) process.exitCode=main();
