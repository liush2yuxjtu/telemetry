const BASE = 'https://grokbot.tail6a877d.ts.net';
const WECHAT = BASE + '/wechat-mcp/mcp';
const ROOT = BASE + '/mcp';
const TARGETS = [
  BASE + '/wechat-mcp/healthz',
  WECHAT,
  BASE + '/wechat-mcp/.well-known/oauth-protected-resource',
  BASE + '/.well-known/oauth-protected-resource/wechat-mcp/mcp',
  BASE + '/.well-known/oauth-authorization-server',
  BASE + '/healthz',
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
async function probe(url) {
  try {
    const r = await fetch(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(8000)});
    const body = await r.text();
    return {url,ok:r.ok,status:r.status,location:r.headers.get('location'),contentType:r.headers.get('content-type'),body:body.slice(0,3000)};
  } catch (error) { return {url,ok:false,error:error?.name||'fetch_error',message:String(error?.message||error)}; }
}
function parseMcpText(text) {
  const data=[];
  for (const line of String(text||'').split(/\r?\n/)) if(line.startsWith('data:')) { const raw=line.slice(5).trim(); if(raw){try{data.push(JSON.parse(raw))}catch{}} }
  if(data.length) return data[data.length-1];
  try{return JSON.parse(text)}catch{return {raw:String(text||'').slice(0,8000)}}
}
async function registerClient(name) {
  const r=await fetch(BASE+'/register',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({client_name:name,grant_types:['client_credentials'],token_endpoint_auth_method:'client_secret_post',scope:'mcp'}),signal:AbortSignal.timeout(8000)});
  const text=await r.text(); if(!r.ok) throw new Error('register '+r.status+': '+text.slice(0,1000)); return JSON.parse(text);
}
async function getToken(client,resource) {
  const form=new URLSearchParams(); form.set('grant_type','client_credentials'); form.set('client_id',client.client_id); if(client.client_secret) form.set('client_secret',client.client_secret); form.set('scope','mcp'); form.set('resource',resource);
  const r=await fetch(BASE+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body:form,signal:AbortSignal.timeout(8000)});
  const text=await r.text(); if(!r.ok) throw new Error('token '+r.status+': '+text.slice(0,1000)); return JSON.parse(text);
}
async function mcpRequest(resource,token,payload,sessionId) {
  const headers={authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'}; if(sessionId) headers['mcp-session-id']=sessionId;
  const r=await fetch(resource,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
  const text=await r.text(); return {ok:r.ok,status:r.status,sessionId:r.headers.get('mcp-session-id')||sessionId||null,parsed:parseMcpText(text)};
}
async function inspectResource(resource,name) {
  const client=await registerClient(name); const token=await getToken(client,resource);
  const init=await mcpRequest(resource,token.access_token,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name,version:'1.0.0'}}});
  if(!init.ok) return {stage:'initialize',status:init.status,parsed:init.parsed};
  await mcpRequest(resource,token.access_token,{jsonrpc:'2.0',method:'notifications/initialized',params:{}},init.sessionId);
  const list=await mcpRequest(resource,token.access_token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},init.sessionId);
  return {stage:'tools/list',status:list.status,tools:list.parsed?.result?.tools||[]};
}
export default async function handler(req,res) {
  if(String(req.method||'').toUpperCase()!=='GET'){res.setHeader('allow','GET');return json(res,405,{ok:false,error:'method_not_allowed'})}
  const results=await Promise.all(TARGETS.map(probe)); let inspect=null;
  if(String(req.query?.inspect||'')==='1'){
    try { inspect={wechat:await inspectResource(WECHAT,'telemetry-wechat-inspect'),root:await inspectResource(ROOT,'telemetry-root-inspect')}; }
    catch(error){inspect={error:String(error?.message||error)}}
  }
  return json(res,200,{ok:true,checkedAt:new Date().toISOString(),results,inspect});
}
