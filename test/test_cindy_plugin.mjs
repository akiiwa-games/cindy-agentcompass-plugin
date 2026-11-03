// Official API fixtures at the plugin boundary. This is not a Cindy runtime test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=fs.readFileSync(new URL('../plugin/main.js',import.meta.url),'utf8');
const ctx={session_id:'true-parent',workdir:'E:/project',workdir_is_local:true,workdir_is_read_only:false};
const route={agentKind:'codex',providerId:'codex',model:'gpt-test',effort:'high',fastMode:false};
function fixture(options={}) {
  const records=new Map(), calls=[], messages=[], waiters=new Map();
  let handler, serial=0;
  const task={taskId:'child-task',revision:4,resolvedConfig:{...route},permissionMode:'bypassPermissions',workingDir:ctx.workdir};
  const run={runId:'run-1',taskId:task.taskId,status:'running',acceptedConfig:route};
  const cindy={
    node:{request:async request=>{
      calls.push(['node',request.method]);
      const {method,params}=request;
      if (method==='prepare') {
        const operation='a'.repeat(40);
        if (!records.has(operation)) records.set(operation,options.prepared || {parent:ctx.session_id,state:'prepared',
          bundle:{provider:'codex',account:'codex',harness:'codex',model:'gpt-test',effort:'high',modeId:'full-access'},
          prompt:'完整原文\r\nunchanged',router:{status:'native'},mappings:[]});
        return {ok:true,result:{operation,...structuredClone(records.get(operation))}};
      }
      const record=records.get(params.operation);
      if (record?.parent!==params.context.session_id) return {ok:false,message:'parent ownership mismatch'};
      if (method==='save') {records.set(params.operation,structuredClone(params.record));return {ok:true,result:{saved:true}};}
      if (method==='load') return {ok:true,result:structuredClone(record)};
      if (method==='output') return {ok:true,result:{artifact:'/test/full-message-page.json'}};
      throw Error('unexpected node method');
    }},
    tasks:{
      capabilities:async()=>({operations:['models','create','send','get','getRun','listRuns','readMessages','cancel','archive'],exactRoute:true,createPermissionMode:true}),
      models:async()=>({models:[{route,efforts:['high'],supportsFastMode:true}]}),
      create:async request=>{calls.push(['create',structuredClone(request)]);return structuredClone(task);},
      send:async request=>{calls.push(['send',structuredClone(request)]);if(options.uncertain) throw Error('DELIVERY_UNCERTAIN');return structuredClone(run);},
      getRun:async request=>{calls.push(['getRun',request]);return structuredClone(run);},
      listRuns:async()=>({items:[structuredClone(run)],nextCursor:null}),
      readMessages:async request=>{calls.push(['readMessages',request]);return request.after ?
        {items:[{id:'out-exact',role:'assistant',content:'[Worker final report] '+ '实'.repeat(6000)}],nextCursor:null} :
        {items:[{id:'unrelated',content:'wrong output'}],nextCursor:'page-2'};},
      cancel:async request=>{calls.push(['cancel',request]);run.status='stopping';return structuredClone(run);},
      archive:async request=>{calls.push(['archive',request]);return task;}
    },
    onHostMessage:callback=>{handler=callback;},
    send:message=>{messages.push(message);waiters.get(message.callId)?.(message);}
  };
  vm.runInNewContext(source,{cindy,Set,Boolean,Error,JSON});
  const send=(tool,args={},context=ctx)=>new Promise(resolve=>{
    const callId='call-'+(++serial);waiters.set(callId,resolve);
    handler({type:'tool-call',tool,callId,args:{...args,session_context:context}});
  });
  return {cindy,task,run,send,calls,records};
}
test('exact route/permission, unchanged task, concurrent repeats create and send once',async()=>{
  const f=fixture();
  const replies=await Promise.all([f.send('roll',{task:'x'}),f.send('roll',{task:'x'})]);
  assert.ok(replies.every(r=>r.ok));
  assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
  assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
  const request=f.calls.find(c=>c[0]==='send')[1];
  assert.equal(request.expectedRevision,4);
  assert.equal(request.text,'完整原文\r\nunchanged');
  assert.equal(replies[0].result.automatic_callback,false);
});
// CINDY_PUBLIC_ROUTE_FIXTURE: a receipt.json that the real worker.cjs prepared through the real public router.
if (process.env.CINDY_PUBLIC_ROUTE_FIXTURE) test('actual public router route reaches explicit Cindy permission',async()=>{
  const receipt=JSON.parse(fs.readFileSync(process.env.CINDY_PUBLIC_ROUTE_FIXTURE,'utf8'));
  const kind={claude:'cc',codex:'codex',pi:'pi'}[receipt.bundle.harness];
  const expected={agentKind:kind,providerId:receipt.bundle.account,model:receipt.bundle.launch_model || receipt.bundle.model,
    effort:receipt.bundle.effort,fastMode:false};
  // Only what prepare produced; a later receipt also holds its create/send/collection progress.
  const f=fixture({prepared:{parent:ctx.session_id,state:'prepared',router:receipt.router,bundle:receipt.bundle,prompt:receipt.prompt,mappings:[]}});
  f.cindy.tasks.models=async()=>({models:[{route:expected,efforts:[expected.effort],supportsFastMode:true}]});
  f.task.resolvedConfig=expected;
  const result=await f.send('roll',{task:'A fixture task'});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
  assert.equal(f.calls.find(c=>c[0]==='create')[1].permissionMode,'bypassPermissions');
  assert.equal(f.calls.find(c=>c[0]==='send')[1].text,receipt.prompt);
});
test('a router answer that is not a native route is returned as is and starts nothing',async()=>{
  for (const status of ['self','split','launched']) {
    const f=fixture({prepared:{parent:ctx.session_id,state:'prepared',bundle:null,prompt:'',router:{status,next_action:'router says'},mappings:[]}});
    const reply=await f.send('roll',{task:'x'});
    assert.equal(reply.ok,true);
    assert.equal(reply.result.status,status);
    assert.equal(f.calls.filter(c=>['create','send'].includes(c[0])).length,0);
  }
});
test('completed result uses exact outputMessageId and persists all pages',async()=>{
  const f=fixture();const first=await f.send('roll',{task:'x'});
  f.run.status='completed';f.run.outputMessageId='out-exact';
  const reply=await f.send('status',{operation:first.result.operation});
  assert.equal(reply.result.status,'completed');
  assert.equal(reply.result.output_available,true);
  assert.equal(reply.result.messages_complete,true);
  assert.equal(reply.result.summary_shortened,true);
  assert.equal(reply.result.full_result_artifacts.length,2);
  assert.match(reply.result.final_result_summary,/Worker final report/);
});
test('unknown send is observed with listRuns and never sent twice',async()=>{
  const f=fixture({uncertain:true});const first=await f.send('roll',{task:'x'});
  assert.equal(first.result.status,'unknown_send');
  const recovered=await f.send('status',{operation:first.result.operation});
  assert.equal(recovered.result.runId,'run-1');
  assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
});
test('disabled/offline/old host cannot start anything',async()=>{
  for(const mode of ['missing','denied','no-cancel']) {
    const f=fixture();
    if(mode==='missing') delete f.cindy.tasks;
    else if(mode==='denied') f.cindy.tasks.capabilities=async()=>{throw Error('PERMISSION_DENIED');};
    else {
      const capabilities=f.cindy.tasks.capabilities;
      f.cindy.tasks.capabilities=async()=>{const caps=await capabilities();return {...caps,operations:caps.operations.filter(op=>op!=='cancel')};};
    }
    assert.equal((await f.send('roll',{task:'x'})).ok,false);
    assert.equal(f.calls.filter(c=>c[0]==='create').length,0);
  }
});
test('wrong model/provider/permission/directory cannot receive model input',async()=>{
  for(const archive of [true,false]) {
  for(const kind of ['model','provider','permission','directory']) {
    const f=fixture();
    if(!archive) {
      const capabilities=f.cindy.tasks.capabilities;
      f.cindy.tasks.capabilities=async()=>{const caps=await capabilities();return {...caps,operations:caps.operations.filter(op=>op!=='archive')};};
      delete f.cindy.tasks.archive;
    }
    if(kind==='model') f.cindy.tasks.models=async()=>({models:[{route:{...route,model:'other'}}]});
    if(kind==='provider') f.cindy.tasks.models=async()=>({models:[{route:{...route,providerId:'other'}}]});
    if(kind==='permission') f.task.permissionMode='ask';
    if(kind==='directory') f.task.workingDir='E:/different';
    const reply=await f.send('roll',{task:'x'});
    assert.equal(f.calls.filter(c=>c[0]==='send').length,0);
    if(['permission','directory'].includes(kind)) {
      assert.equal(f.calls.filter(c=>c[0]==='archive').length,archive?1:0);
      assert.equal(reply.result.taskId,f.task.taskId);
      assert.equal(reply.result.draft_cleanup,archive?'archived':'manual_cleanup_required');
    }
  }
  }
});
test('lost create is not retried and a failed run preserves failure without inventing output',async()=>{
  const f=fixture();f.cindy.tasks.create=async()=>{throw Error('transport lost');};
  const first=await f.send('roll',{task:'x'});
  assert.equal(first.result.status,'unknown_create');
  const observed=await f.send('status',{operation:first.result.operation});
  assert.equal(observed.result.status,'unknown_create');
  assert.equal(f.calls.filter(c=>c[0]==='send').length,0);
  const other=fixture();const launched=await other.send('roll',{task:'x'});
  other.run.status='failed';other.run.error='upstream timeout';
  const failed=await other.send('status',{operation:launched.result.operation});
  assert.equal(failed.result.status,'failed');
  assert.equal(failed.result.error,'upstream timeout');
  assert.equal(failed.result.output_available,false);
});
test('parent/session boundary and readonly/remote fail before dispatch',async()=>{
  const f=fixture();const first=await f.send('roll',{task:'x'});
  assert.equal((await f.send('status',{operation:first.result.operation},{...ctx,session_id:'other'})).ok,false);
  assert.equal((await f.send('roll',{task:'x'},{...ctx,workdir_is_local:false})).ok,false);
  assert.equal((await f.send('roll',{task:'x'},{...ctx,workdir_is_read_only:true})).ok,false);
});
test('archive is optional for dispatch and cancellation; inactive cleanup is honest and repeatable',async()=>{
  for (const archive of [true,false]) {
  const f=fixture();
  if (!archive) {
    const capabilities=f.cindy.tasks.capabilities;
    f.cindy.tasks.capabilities=async()=>{const caps=await capabilities();return {...caps,operations:caps.operations.filter(op=>op!=='archive')};};
    delete f.cindy.tasks.archive;
  }
  const first=await f.send('roll',{task:'x'});assert.equal(first.ok,true);
  const args={operation:first.result.operation};
  assert.equal((await f.send('stop',args)).result.status,'stopping');
  assert.equal((await f.send('cleanup',args)).ok,false);
  f.run.status='cancelled';
  for(let i=0;i<2;i++) {
    const cleaned=(await f.send('cleanup',args)).result;
    assert.equal(cleaned.status,archive?'cleaned':'manual_cleanup_required');
    if (!archive) {assert.equal(cleaned.taskId,f.task.taskId);assert.equal(cleaned.archived,false);}
  }
  assert.equal(f.calls.filter(c=>c[0]==='archive').length,archive?1:0);
  }
});
