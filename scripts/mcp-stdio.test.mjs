// Integration contract with an actual SDK client and compiled stdio process.
// The HTTP backend is synthetic; no account, model or provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
const manifest=JSON.parse(fs.readFileSync(new URL('../docs/generated/mcp-manifest.json',import.meta.url),'utf8'));
test('stdio SDK preserves schemas, structured writes, resources and prompts',async()=>{
  const backend=http.createServer(async(req,res)=>{
    let body='';for await(const part of req) body+=part;
    const input=JSON.parse(body);let data;
    if(input.op==='manifest') data=manifest;
    else if(input.op==='resource') data={contents:[{uri:input.uri,mimeType:'application/json',text:'{"synthetic":true}'}]};
    else if(input.op==='prompt') data={description:'Synthetic prompt',messages:[{role:'user',content:{type:'text',text:'Synthetic planning instruction'}}]};
    else data={state:'completed',operation_id:'operation-123',action_id:'action-123',undo_available:true,retryable:false,data:{synthetic:true},source:'Life OS',fetched_at:new Date().toISOString(),untrusted_content:true};
    res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
  });
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const client=new Client({name:'connector-contract-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../mcp-server/dist/index.js',import.meta.url))],env:{PATH:process.env.PATH,LIFEOS_URL:`http://127.0.0.1:${backend.address().port}`,LIFEOS_MCP_TOKEN:'synthetic-contract-token'},stderr:'pipe'});
  try{
    await client.connect(transport);
    const tools=await client.listTools();assert.equal(tools.tools.length,manifest.read_tools.length+manifest.write_tools.length);
    const result=await client.callTool({name:'lifeos_add_note',arguments:{title:'Synthetic',type:'idea',body:'Synthetic',_idempotency_key:'note-123'}});
    assert.equal(result.structuredContent.operation_id,'operation-123');assert.equal(result.structuredContent.action_id,'action-123');
    assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
    const preview=await client.callTool({name:'lifeos_preview_patch',arguments:{table:'notes',record_id:'synthetic',patch:{body_md:null}}});
    assert.equal(preview.isError,undefined);
    const invalid=await client.callTool({name:'lifeos_commit_previews',arguments:{preview_ids:Array(11).fill('x')}});assert.equal(invalid.isError,true);
    assert.equal((await client.listResources()).resources.length,manifest.resources.length);
    assert.match((await client.readResource({uri:manifest.resources[0].uri})).contents[0].text,/synthetic/);
    assert.equal((await client.listPrompts()).prompts.length,manifest.prompts.length);
    assert.match((await client.getPrompt({name:manifest.prompts[0].name})).messages[0].content.text,/Synthetic/);
  } finally {await client.close();await new Promise(resolve=>backend.close(resolve));}
});
