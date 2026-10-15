import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import * as permissions from "../lib/mcp/permissions.ts";
import * as core from "../lib/mcp/oauth-core.ts";
import * as catalog from "../lib/mcp/catalog.ts";
function load(path: string, imports: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code, {exports,require:(name:string)=>{assert(name in imports,`Missing fixture ${name}`);return imports[name];},Request,Response,URL,Buffer,console,Date,process:{env:{LIFEOS_MCP_TOKEN:"synthetic-test-secret-0123456789"}}});
  return exports;
}
const operations = load("lib/mcp/operations.ts", {"node:crypto":crypto,"@/lib/supabase/service":{}});
const http = load("lib/mcp/http.ts", {"./operations":operations});
const req = (body: unknown, headers: Record<string,string>={}) => new Request("https://app.example/api/mcp/http", {method:"POST",headers:{authorization:"Bearer synthetic", "content-type":"application/json",...headers},body:JSON.stringify(body)});
function remote(options: {revoked?:boolean;caps?:permissions.CapabilitySet}={}) {
  let dispatches=0;
  const svc = {from(table:string) {
    const query = {select:()=>query,eq:()=>query,is:()=>Promise.resolve({error:null}),update:()=>query,maybeSingle:async()=>({data:table==="mcp_grants"?{kind:"access",client_id:"client",user_id:"owner",expires_at:"2099-01-01",used_at:null,revoked_at:null}:{approved_at:"2026-01-01",revoked_at:options.revoked?"2026-01-02":null,capabilities:options.caps??permissions.DEFAULT_CAPABILITIES},error:null})};return query;
  }};
  const handler = load("app/api/mcp/http/route.ts", {
    "next/server":{after:()=>{}},"@/lib/supabase/service":{createServiceClient:()=>svc},"@/lib/mcp/oauth-core":core,"@/lib/mcp/origin":{appOrigin:()=>"https://app.example"},"@/lib/mcp/permissions":permissions,
    "@/lib/mcp/dispatch":{manifest:()=>[],dispatch:async()=>{dispatches++;return {state:"completed",operation_id:"operation",action_id:"action",data:{}};}},
    "@/lib/mcp/http":http,"@/lib/mcp/operations":operations,"@/lib/mcp/jobs":{},"@/lib/mcp/catalog":catalog,
  }) as {POST:(req:Request)=>Promise<Response>};
  return {handler,getDispatches:()=>dispatches};
}
test("capabilities fail closed, separate disclosures and constrain targets",()=>{
  assert.equal(permissions.normalizeCapabilities(null),null);
  assert.equal(permissions.normalizeCapabilities({read:true}),null);
  assert(permissions.capabilityAllows(permissions.DEFAULT_CAPABILITIES,"lifeos_list_tasks",false));
  for(const name of ["lifeos_get_house_rules","lifeos_get_context","lifeos_read_mail_thread","lifeos_read_mail_attachment","lifeos_list_finance_items"]) assert(!permissions.capabilityAllows(permissions.DEFAULT_CAPABILITIES,name,false));
  assert(!permissions.capabilityAllows(permissions.DEFAULT_CAPABILITIES,"lifeos_update_task",true));
  const noFinance={...permissions.ALL_CAPABILITIES,finance:false};
  assert(!permissions.capabilityAllows(noFinance,"lifeos_update_task",true,{hours_spent:2}));
  assert(!permissions.capabilityAllows(noFinance,"lifeos_create_trip",true,{details:{amount:12}}));
  assert(!permissions.capabilityAllows({...permissions.ALL_CAPABILITIES,attachments:false},"lifeos_start_scan_job",true));
  const mailbox={...permissions.ALL_CAPABILITIES,mailboxes:["allowed"]};
  assert(permissions.capabilityAllows(mailbox,"lifeos_read_mail_thread",false,{account:"allowed"}));
  assert(!permissions.capabilityAllows(mailbox,"lifeos_read_mail_thread",false,{account:"other"}));
  assert(!permissions.capabilityAllows(mailbox,"lifeos_get_context",false));
  const stream={...permissions.ALL_CAPABILITIES,work_streams:["stream-id"]};
  assert(permissions.capabilityAllows(stream,"lifeos_list_tasks",false));
  assert(!permissions.capabilityAllows(stream,"lifeos_search",false));
});
test("remote transport rejects malformed envelopes without calling tools",async()=>{
  const {handler,getDispatches}=remote();
  for(const value of [null,[null],[],"text",{}, {jsonrpc:"2.0",id:null,method:"ping"},{jsonrpc:"2.0",id:1,method:"tools/call",params:[]}]) assert.equal((await handler.POST(req(value))).status,400);
  assert.equal(getDispatches(),0);
});
test("remote notifications are silent and never execute tool calls",async()=>{
  const {handler,getDispatches}=remote();
  for(const method of ["notifications/initialized","tools/call","ping"]) assert.equal((await handler.POST(req({jsonrpc:"2.0",method,params:{name:"lifeos_create_task"}}))).status,202);
  assert.equal(getDispatches(),0);
});
test("remote checks connection revocation, Origin and protocol negotiation",async()=>{
  assert.equal((await remote({revoked:true}).handler.POST(req({jsonrpc:"2.0",id:1,method:"ping"}))).status,401);
  const {handler}=remote();
  for(const origin of ["null","https://evil.example"]) assert.equal((await handler.POST(req({jsonrpc:"2.0",id:1,method:"ping"},{origin}))).status,403);
  const init=await handler.POST(req({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2099-01-01",capabilities:{},clientInfo:{name:"test",version:"1"}}},{"mcp-protocol-version":"2099-01-01"}));
  assert.equal(init.status,200);assert.equal((await init.json()).result.protocolVersion,"2025-06-18");
  assert.equal((await handler.POST(req({jsonrpc:"2.0",id:1,method:"ping"},{"mcp-protocol-version":"2099-01-01"}))).status,400);
});
test("remote tools preserve structured operation identifiers",async()=>{
  const {handler}=remote();const response=await handler.POST(req({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"lifeos_create_task",arguments:{}}}));
  const body=await response.json();assert.equal(body.result.structuredContent.operation_id,"operation");assert.equal(body.result.structuredContent.action_id,"action");
  assert.deepEqual(JSON.parse(body.result.content[0].text),body.result.structuredContent);
});
test("body budget is enforced against streamed bytes",async()=>{
  const readJson=http.readJson as (req:Request)=>Promise<unknown>;
  await assert.rejects(readJson(req({payload:"x".repeat(65536)})),/64 KB/);
});

test("shared dispatcher idempotency preserves the original outcome and rejects changed payloads",async()=>{
  const records=new Map<string,Record<string,unknown>>();const writes:unknown[]=[];const activity:string[]=[];
  const store=async (_context:unknown,action:string,args:Record<string,unknown>={})=>{
    if(action==="begin_call")return{id:"activity"};
    if(action==="finish_call"){activity.push(String(args.state));return{};}
    if(action==="reserve"){
      if(records.has(String(args.key)))return{claimed:false,operation:records.get(String(args.key))};
      const op={id:"operation",request_hash:args.hash,scope_hash:args.scope_hash,state:"running",result:null};records.set(String(args.key),op);return{claimed:true,operation:op};
    }
    if(action==="finish"){
      const op=[...records.values()].find(r=>r.id===args.id)!;assert.equal(op.state,"running");Object.assign(op,{state:args.state,result:args.result});return op;
    }
    throw new Error(`Unexpected ${action}`);
  };
  const api={READ_TOOL_NAMES:["lifeos_list_tasks"],READ_TOOL_DESCRIPTIONS:{lifeos_list_tasks:"Tasks"},READ_TOOL_SCHEMAS:{lifeos_list_tasks:{type:"object",properties:{},additionalProperties:false}},writeTools:()=>[{name:"add_note",description:"Add",bucket:"autonomous",input_schema:{type:"object",properties:{title:{type:"string"}},required:["title"],additionalProperties:false}}],runReadTool:async()=>({items:[{id:"task",title:"Task",billing_ref:"private",hours_spent:3,work_stream:{hourly_rate:42,name:"Stream"}}]}),runWriteTool:async(_name:unknown,input:unknown)=>{writes.push(input);return{reply:"Saved",queued:false};}};
  const loaded=load("lib/mcp/dispatch.ts",{"node:crypto":crypto,"@/lib/assistant/mcp-api":api,"@/lib/assistant/actor":{serviceActor:async()=>({})},"@/lib/supabase/service":{},"./permissions":permissions,"./operations":{...operations,operationStore:store}});
  const dispatch=loaded.dispatch as (context:unknown,name:string,input:Record<string,unknown>)=>Promise<Record<string,unknown>>;
  const context={clientId:"client",userId:"owner",capabilities:permissions.ALL_CAPABILITIES};
  const first=await dispatch(context,"lifeos_add_note",{title:"A",_idempotency_key:"same"});assert.equal(first.state,"completed");assert.equal(first.operation_id,"operation");
  const replay=await dispatch(context,"lifeos_add_note",{title:"A",_idempotency_key:"same"});assert.equal(replay.replayed,true);assert.equal(writes.length,1);assert(activity.includes("replayed"));
  const conflict=await dispatch(context,"lifeos_add_note",{title:"B",_idempotency_key:"same"});assert.equal(conflict.state,"failed");assert.equal((conflict.error as {code:string}).code,"idempotency_conflict");assert.equal(records.get("same")?.state,"completed");assert.equal(writes.length,1);
  const scoped=await dispatch({...context,capabilities:permissions.DEFAULT_CAPABILITIES},"lifeos_list_tasks",{});assert.equal(scoped.state,"completed");assert(!JSON.stringify(scoped).includes("private"));assert(!JSON.stringify(scoped).includes("hourly_rate"));assert(!JSON.stringify(scoped).includes("hours_spent"));
  const invalid=await dispatch(context,"lifeos_add_note",JSON.parse('{"title":"A","constructor":{}}'));assert.equal(invalid.state,"failed");assert.equal(writes.length,1);
});

test("background worker rechecks revocation, honors cancellation and marks ambiguous effects uncertain",async()=>{
  for(const scenario of ["revoked","cancelled","uncertain","completed"]){
    let scans=0;let finished:Record<string,unknown>={};
    const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:{approved_at:"2026-01-01",revoked_at:scenario==="revoked"?"2026-01-02":null,capabilities:permissions.ALL_CAPABILITIES},error:null})};
    const store=async(_context:unknown,action:string,args:Record<string,unknown>={})=>{
      if(action==="claim_job")return{id:"job",client_id:"client",capabilities:permissions.ALL_CAPABILITIES,input:{account:"allowed",days:1}};
      if(action==="job")return{cancel_requested:scenario==="cancelled"};
      if(action==="finish_job"){finished=args;return args;}
      throw new Error(action);
    };
    const loaded=load("lib/mcp/jobs.ts",{"@/lib/assistant/actor":{serviceActor:async()=>({userId:"owner"})},"@/lib/assistant/mcp-api":{runWriteTool:async()=>{scans++;if(scenario==="uncertain")throw new Error("Worker lost completion after task write");return{reply:"Scanned",queued:false};}},"@/lib/supabase/service":{createServiceClient:()=>({from:()=>query})},"./permissions":permissions,"./operations":{...operations,operationStore:store}});
    await (loaded.runNextMcpJob as ()=>Promise<unknown>)();
    assert.equal(finished.state,scenario==="revoked"?"failed":scenario);
    assert.equal(scans,["revoked","cancelled"].includes(scenario)?0:1);
  }
});
