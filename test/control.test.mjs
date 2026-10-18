import test from 'node:test';
import assert from 'node:assert/strict';
import { definitionContext, desktopObservationGuard, makeControlTool } from '../control.mjs';

test('private definition collection never changes foreign registration or hooks', () => {
  let foreign=0, hooks=0;
  const ctx={tools:{register(){foreign++;}},on(){hooks++;},inject(){hooks++;},get(){return 42;}};
  const defs=new Map(); const captured=definitionContext(ctx,defs);
  captured.tools.register({name:'one'});captured.on('agent/pre-step',()=>{});captured.inject(['x'],()=>{});
  assert.equal(foreign,0);assert.equal(hooks,0);assert.equal(defs.size,1);
  ctx.tools.register({name:'foreign'});assert.equal(foreign,1);
});

test('dispatcher validates action and forwards exact arguments, signal and rendered image',async()=>{
  const controller=new AbortController();let calls=0;
  const def={description:'Test',parameters:{type:'object'},async execute(args,exec){calls++;assert.deepEqual(args,{text:'龙爪'});assert.equal(exec.signal,controller.signal);return {id:1};},output:{render:()=>[{type:'image',attachment:{attachmentId:'image'}}]}};
  const tool=makeControlTool({name:'dragon_browser',actions:{type:'test'},definitions:new Map([['test',def]])});
  assert.equal((await tool.execute({action:'help',args:{action:'type'}})).content.length,1);
  assert.equal(calls,0);
  assert.equal((await tool.execute({action:'type',args:{text:'龙爪'}},{signal:controller.signal})).content[0].type,'image');
  await assert.rejects(tool.execute({action:'constructor'}),/未知动作/);
  await assert.rejects(tool.execute({action:'type',args:[]}),/对象/);
  await assert.rejects(tool.execute({action:'type',unexpected:true}),/未知请求/);
  controller.abort();await assert.rejects(tool.execute({action:'type',args:{text:'龙爪'}},{signal:controller.signal}));
  assert.equal(calls,1);
});

test('observation binding rejects another session, switched/moved window, stale observation and replay',async()=>{
  let clock=0;
  let screen={windowId:7,bounds:{x:10,y:20,width:800,height:600}};
  const guard=desktopObservationGuard({listScreens:async()=>[screen]},{now:()=>clock,ttl:100});
  const exec={agent:{id:'a'}};
  const observe=async()=>{
    const note=await guard.after({value:{screens:[{windowId:7,logicalWidth:800,logicalHeight:600}]},exec});
    return note.match(/observation_id=([^\n]+)/)[1];
  };
  let id=await observe();
  await assert.rejects(guard.before({action:'click',observation_id:id,exec:{agent:{id:'b'}}}),/过期/);
  await guard.before({action:'click',observation_id:id,exec});
  await assert.rejects(guard.before({action:'click',observation_id:id,exec}),/过期/);
  id=await observe();screen={...screen,windowId:8};
  await assert.rejects(guard.before({action:'click',observation_id:id,exec}),/变化/);
  screen={...screen,windowId:7};id=await observe();screen.bounds.x=15;
  await assert.rejects(guard.before({action:'click',observation_id:id,exec}),/变化/);
  id=await observe();clock=101;
  await assert.rejects(guard.before({action:'click',observation_id:id,exec}),/过期/);
});
