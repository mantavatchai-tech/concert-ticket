const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const files=new Set(['index.html','ticket.html','app.js','ticket.js','styles.css','config.js','vendor/fflate.min.js']);
function createServer() {
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')) {
      const name=url.pathname.slice(5);
      if(!['qr','send-line-ticket','line-webhook'].includes(name)) {res.writeHead(404).end();return;}
      let length=0;const chunks=[];
      for await(const chunk of req) {length+=chunk.length;if(length>1024*1024) {res.writeHead(413).end();return;}chunks.push(chunk);}
      const body=Buffer.concat(chunks);
      req.query=Object.fromEntries(url.searchParams);
      try {
        req.body=name==='line-webhook'?body:(body.length?JSON.parse(body):undefined);
        res.status=n=>{res.statusCode=n;return res;};
        res.json=data=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));return res;};
        res.send=data=>{res.end(data);return res;};
        await require(path.join(root,'api',name+'.js'))(req,res);
      } catch {if(!res.writableEnded) {res.statusCode=400;res.end('Request failed');}}
      return;
    }
    if(!['GET','HEAD'].includes(req.method)) {res.writeHead(405).end();return;}
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!files.has(file)) {res.writeHead(404).end();return;}
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)];
    res.setHeader('Content-Type',mime+'; charset=utf-8');
    if(req.method==='HEAD') {res.end();return;}
    fs.createReadStream(path.join(root,file)).on('error',()=>{res.statusCode=404;res.end();}).pipe(res);
  });
}
if(require.main===module) {
  if(fs.existsSync(path.join(root,'.env'))) process.loadEnvFile(path.join(root,'.env'));
  const port=Number(process.env.PORT || 3000);
  createServer().listen(port,'127.0.0.1',()=>console.log(`Local app: http://127.0.0.1:${port}`));
}
module.exports={createServer};

