import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { AiReviewService } from './ai-review.js';
import { AppError } from './types.js';

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  response.end(JSON.stringify(body));
}

function bodyJson(request: IncomingMessage): Promise<Record<string,unknown>> {
  return new Promise((resolve,reject) => {
    let size=0;const parts:Buffer[]=[];
    request.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>262_144){reject(new AppError('BODY_TOO_LARGE','请求内容过大。'));request.destroy();}else parts.push(chunk);});
    request.on('end',()=>{try{const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();resolve(value);}catch{reject(new AppError('BAD_JSON','请求内容不是有效 JSON。'));}});
    request.on('error',reject);
  });
}

export function startWeb(store: Store, port=3210): Promise<void> {
  const ai=new AiReviewService(store);
  const publicDir=join(dirname(fileURLToPath(import.meta.url)),'public');
  const server=createServer(async(request,response)=>{
    try{
      const host=request.headers.host;
      if(host!==`127.0.0.1:${port}` && host!==`localhost:${port}`)throw new AppError('BAD_HOST','仅允许本机访问。');
      const url=new URL(request.url??'/',`http://127.0.0.1:${port}`);
      if(url.pathname.startsWith('/api/')){
        if(request.method==='GET' && url.pathname==='/api/dashboard')return json(response,200,store.dashboard());
        if(request.method!=='POST')return json(response,405,{error:'METHOD_NOT_ALLOWED'});
        const origin=request.headers.origin;
        if(origin && origin!==`http://127.0.0.1:${port}`&&origin!==`http://localhost:${port}`)throw new AppError('BAD_ORIGIN','跨站请求已拒绝。');
        if(!String(request.headers['content-type']??'').startsWith('application/json'))throw new AppError('BAD_CONTENT_TYPE','需要 JSON 请求。');
        const input=await bodyJson(request);
        if(url.pathname==='/api/manual-progress/queue')return json(response,200,ai.queueManual(input.text as string));
        const segments=url.pathname.split('/').filter(Boolean);
        const id=segments[2]?decodeURIComponent(segments[2]):'';
        if(segments[1]==='todos'&&segments[3]==='status'){
          if(input.status!=='done'&&input.status!=='open')throw new AppError('BAD_STATUS','待办状态无效。');
          store.setTodo(id,input.status,Number(input.expected_version));
        }else if(segments[1]==='applications'&&segments[3]==='edit'){
          store.editApplication(id,{company:input.company as string|undefined,position:input.position as string|undefined,stage:input.stage as string|undefined,status:input.status as string|undefined,expected_version:Number(input.expected_version)});
        }else if(segments[1]==='failures'&&segments[3]==='skip'){
          store.skipFailure(id,String(input.reason??''));
        }else if(segments[1]==='failures'&&segments[3]==='retry'){
          store.requestRetry(id);
        }else return json(response,404,{error:'NOT_FOUND'});
        return json(response,200,{ok:true});
      }
      if(request.method!=='GET')return json(response,405,{error:'METHOD_NOT_ALLOWED'});
      const files:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/redesign.css':['redesign.css','text/css; charset=utf-8']};
      const file=files[url.pathname];
      if(!file)return json(response,404,{error:'NOT_FOUND'});
      const contents=await readFile(join(publicDir,file[0]));
      response.writeHead(200,{'content-type':file[1],'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});
      response.end(contents);
    }catch(error){
      if(error instanceof AppError)return json(response,error.code==='BAD_HOST'?403:400,{error:error.code,message:error.message});
      return json(response,500,{error:'SERVER_ERROR',message:'服务暂时无法处理请求。'});
    }
  });
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,'127.0.0.1',()=>{console.log(`求职记已启动：http://127.0.0.1:${port}`);resolve();});
  });
}
