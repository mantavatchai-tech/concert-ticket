// Isolated interactive sandbox. Never reads .env or connects to hosted Supabase/LINE.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const {createServer}=require('./dev-server.cjs');
const root=path.resolve(__dirname,'..');
const folder=path.join(root,'.local-demo');
const allowed=new Set(['admin_login','admin_logout','change_password','manage_user','revoke_user_sessions','save_event',
  'issue_ticket_batch','get_customer_ticket','get_dashboard','get_sales_report','backup_event','delete_event','set_ticket_payment','check_in_ticket','cancel_ticket','update_ticket_price']);
async function startDemo(port=3000) {
  fs.mkdirSync(folder,{recursive:true});
  const db=new PGlite(path.join(folder,'db'),{extensions:{pgcrypto}});
  const initialized=(await db.query("select to_regclass('public.issue_requests') present")).rows[0].present;
  let credentials;
  if(!initialized) {
    await db.exec('create role anon;create role authenticated;create role service_role;create schema extensions;grant usage on schema public to anon,authenticated,service_role;');
    for(const file of ['supabase-schema.sql','admin-features.sql','security-upgrade.sql','event-deletion.sql']) await db.exec(fs.readFileSync(path.join(root,file),'utf8'));
    const password='Local-'+randomBytes(6).toString('hex')+'!';
    credentials={username:'localadmin',password};
    await db.query("insert into public.admin_users(username,display_name,role,password_hash) values($1,'แอดมินทดลอง','admin',extensions.crypt($2,extensions.gen_salt('bf')))",[credentials.username,password]);
    fs.writeFileSync(path.join(folder,'credentials.json'),JSON.stringify(credentials,null,2));
  } else {
    credentials=JSON.parse(fs.readFileSync(path.join(folder,'credentials.json'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'customizable-events.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'event-deletion.sql'),'utf8'));
  }
  const today=(await db.query("select to_char(now() at time zone 'Asia/Bangkok','YYYY-MM-DD') as event_day")).rows[0].event_day;
  await db.query("insert into public.event_settings(event_day,name,vip_limit,regular_limit,vip_price,regular_prices) values($1,'งานทดลองวันนี้',48,1000,2000,array[150,180]) on conflict do nothing",[today]);
  const staticHandler=createServer().listeners('request')[0];
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  async function body(req) {
    const chunks=[];let bytes=0;
    for await(const chunk of req){bytes+=chunk.length;if(bytes>1048576) throw new Error('Request too large');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  const server=http.createServer(async(req,res)=>{
    const origin=`http://127.0.0.1:${server.address().port}`;
    const url=new URL(req.url,origin);
    if(req.headers.host!==new URL(origin).host) return json(res,403,{error:'Local access only'});
    if(req.headers.origin && req.headers.origin!==origin) return json(res,403,{error:'Local origin only'});
    try {
      if(url.pathname==='/config.js') {
        res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});
        return res.end('window.APP_CONFIG='+JSON.stringify({supabaseUrl:origin,supabaseAnonKey:'local-demo-public'})+';');
      }
      if(['/','/index.html','/ticket.html'].includes(url.pathname)) {
        let html=fs.readFileSync(path.join(root,url.pathname==='/ticket.html'?'ticket.html':'index.html'),'utf8');
        const banner='<div style="padding:12px;text-align:center;background:#fff0b3;color:#432e00;font:16px sans-serif">โหมดทดสอบในเครื่อง · ข้อมูลแยกจากระบบจริง · LINE เป็นการจำลอง</div>';
        html=html.replace(/(<body[^>]*>)/,'$1'+banner);
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);
      }
      if(url.pathname.startsWith('/rest/v1/rpc/')) {
        if(req.method!=='POST') return json(res,405,{message:'POST required'});
        const name=url.pathname.slice('/rest/v1/rpc/'.length);
        if(!allowed.has(name)) return json(res,403,{message:'Function unavailable in local demo'});
        const args=await body(req);
        const names=(await db.query('select proargnames from pg_proc where pronamespace=\'public\'::regnamespace and proname=$1',[name])).rows[0]?.proargnames || [];
        const keys=Object.keys(args);
        if(keys.some(key=>!names.includes(key))) return json(res,400,{message:'Unknown argument'});
        const result=await db.transaction(async tx=>{
          await tx.exec('set local role anon');
          return (await tx.query(`select public.${name}(${keys.map((key,index)=>'"'+key+'" => $'+(index+1)).join(',')}) as value`,keys.map(key=>args[key]))).rows[0].value;
        });
        return json(res,200,result);
      }
      if(url.pathname==='/api/send-line-ticket') {
        if(req.method!=='POST') return json(res,405,{error:'POST required'});
        const token=(req.headers.authorization || '').replace(/^Bearer /,'');
        const args=await body(req);
        // Exercise the real session/recipient validation, but never contact LINE.
        const result=(await db.query('select public.prepare_line_delivery($1,$2) as value',[token,args.ticketId])).rows[0].value;
        await db.query('select public.finish_line_delivery($1,$2,true,null)',[args.ticketId,result.retry_key]);
        return json(res,200,{ok:true,simulated:true});
      }
      if(url.pathname==='/api/line-webhook') return json(res,403,{error:'External webhooks disabled in local demo'});
      await staticHandler(req,res);
    } catch(error) {
      json(res,400,{code:error.code || 'LOCAL_ERROR',message:error.message,error:error.message});
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,username:credentials.username,password:credentials.password,today,mode:'isolated local demo'}));
  const close=async()=>{await new Promise(resolve=>server.close(resolve));await db.close();};
  return {server,db,close};
}
if(require.main===module) startDemo(Number(process.env.LOCAL_DEMO_PORT || 3000)).then(({close})=>{
  process.once('SIGINT',()=>close().then(()=>process.exit()));
  process.once('SIGTERM',()=>close().then(()=>process.exit()));
}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={startDemo};
